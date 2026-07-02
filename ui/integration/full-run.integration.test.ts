import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Routes, Route } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@/api/queryClient";
import { api } from "@/api/client";
import { apiPaths, type StartRunResponse } from "@shared/api-types";
import { liveRunStore } from "@/stores/liveRunStore";
import { startServer, installFetchBase, installEventSource, makeTempGitProject, type LiveServer } from "./harness";
import { NewRunPage } from "@/features/runs/NewRunPage";
import { RunDetailPage } from "@/features/runs/RunDetailPage";
import { RunsPage } from "@/features/runs/RunsPage";

const RUN = !!process.env.PP_INTEGRATION;
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(check: () => boolean, timeout = 15_000, interval = 100): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (check()) return;
    await act(async () => { await sleep(interval); });
  }
  if (!check()) throw new Error("waitFor timed out");
}
function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}
function render(path: string, routes: ReactElement): { container: HTMLDivElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const qc = createQueryClient();
  act(() => {
    root.render(createElement(QueryClientProvider, { client: qc }, createElement(MemoryRouter, { initialEntries: [path] }, routes)));
  });
  return { container, root };
}
/** Poll a run's persisted status via the API. */
async function pollStatus(base: string, runId: string, until: (s: string) => boolean, timeout = 15_000): Promise<string> {
  const start = Date.now();
  let status = "";
  while (Date.now() - start < timeout) {
    const tree = await api.get<{ run: { status: string } }>(apiPaths.run(runId));
    status = tree.run.status;
    if (until(status)) return status;
    await sleep(150);
  }
  return status;
}
/** Read the raw SSE stream for a run until `needle` (or timeout). */
function readSse(base: string, runId: string, needle: string, ms = 12_000): Promise<string> {
  return new Promise((resolve) => {
    const req = http.request(`${base}${apiPaths.runEvents(runId)}?lastEventId=0`, (res) => {
      let buf = "";
      const to = setTimeout(() => { res.destroy(); resolve(buf); }, ms);
      res.on("data", (c) => { buf += c.toString(); if (buf.includes(needle)) { clearTimeout(to); res.destroy(); resolve(buf); } });
    });
    req.end();
  });
}

describe.skipIf(!RUN)("full-run UI E2E against live ppd (M5i)", () => {
  let server: LiveServer;
  let uninstall: () => void;
  let uninstallEs: () => void;
  let project: string;

  beforeAll(async () => {
    server = await startServer({ PP_LLM: "fake" });
    uninstall = installFetchBase(server.base);
    uninstallEs = installEventSource(server.base);
    project = makeTempGitProject();
    await api.post(apiPaths.projects, { path: project });
  }, 45_000);

  afterAll(async () => {
    uninstall?.();
    uninstallEs?.();
    await server?.stop();
  });

  it("wizard → POST /runs → RunDetailPage animates from real SSE → finalizes → RunsPage lists it", async () => {
    liveRunStore.reset();
    const routes = createElement(
      Routes,
      null,
      createElement(Route, { path: "/runs/new", element: createElement(NewRunPage) }),
      createElement(Route, { path: "/runs/:runId", element: createElement(RunDetailPage) }),
    );
    const { container, root } = render("/runs/new", routes);

    // Step 1: pick the registered temp project + a request.
    await waitFor(() => {
      const sel = container.querySelector<HTMLSelectElement>('[data-testid="wizard-project"]');
      return !!sel && Array.from(sel.options).some((o) => o.value === project);
    });
    await act(async () => {
      setValue(container.querySelector<HTMLSelectElement>('[data-testid="wizard-project"]')!, project);
      setValue(container.querySelector<HTMLTextAreaElement>('[data-testid="wizard-request"]')!, "Add a greeting helper to the project.");
    });

    // Walk to step 4 (single mode is valid throughout) and launch.
    const next = async () => {
      await waitFor(() => { const b = container.querySelector<HTMLButtonElement>('[data-testid="wizard-next"]'); return !!b && !b.disabled; });
      await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="wizard-next"]')!.click(); });
    };
    await next(); await next(); await next();
    await waitFor(() => { const b = container.querySelector<HTMLButtonElement>('[data-testid="wizard-launch"]'); return !!b && !b.disabled; });
    await act(async () => { container.querySelector<HTMLButtonElement>('[data-testid="wizard-launch"]')!.click(); });

    // Navigated to RunDetailPage — the request text and pipeline render.
    await waitFor(() => (container.textContent ?? "").includes("greeting helper") && (container.textContent ?? "").includes("Pipeline"));
    expect(container.textContent).toContain("Pipeline");

    // The newest run is the one we just launched.
    const runs = await api.get<Array<{ id: string; status: string }>>(apiPaths.runs);
    expect(runs.length).toBeGreaterThan(0);
    const runId = runs[0]!.id;

    // The mounted page's useRunStream (lastEventId=0 replay) folds the REAL
    // pilot SSE frames into liveRunStore: stages arrive and the run reaches a
    // finalized status from run.finalized. This is the live-animation proof.
    await waitFor(() => {
      const o = liveRunStore.getOverlay(runId);
      return Object.keys(o.stageStatus).length > 0 && (o.status === "complete" || o.status === "surfaced");
    }, 15_000);
    const overlay = liveRunStore.getOverlay(runId);
    expect(Object.keys(overlay.stageStatus).length).toBeGreaterThan(0);
    expect(["complete", "surfaced"]).toContain(overlay.status);

    act(() => root.unmount());
    container.remove();

    // The run also reached a terminal status server-side.
    const finalized = await pollStatus(server.base, runId, (s) => s === "complete" || s === "surfaced" || s === "aborted");
    expect(["complete", "surfaced"]).toContain(finalized);

    const list = render("/runs", createElement(Routes, null, createElement(Route, { path: "/runs", element: createElement(RunsPage) })));
    await waitFor(() => (list.container.textContent ?? "").includes("greeting helper"));
    expect(list.container.textContent).toContain("greeting helper");
    act(() => list.root.unmount());
    list.container.remove();
  }, 40_000);

  it("real SSE stream carries budget.tick and run.finalized frames", async () => {
    const started = await api.post<StartRunResponse>(apiPaths.runs, { project_path: project, request_text: "budget probe", mode: "single" });
    expect(started.run_id).toBeTruthy();
    const buf = await readSse(server.base, started.run_id, "event: run.finalized");
    expect(buf).toContain("event: budget.tick");
    expect(buf).toContain("event: run.finalized");
    expect(buf).toContain("event: stage.started");
  }, 25_000);

  it("abort round-trip: start a run, click Abort in the UI, status becomes aborted", async () => {
    liveRunStore.reset();
    // Start via API so we can render the detail page immediately while it runs.
    const started = await api.post<StartRunResponse>(apiPaths.runs, { project_path: project, request_text: "abort me", mode: "single" });
    const runId = started.run_id;

    const { container, root } = render(
      `/runs/${encodeURIComponent(runId)}`,
      createElement(Routes, null, createElement(Route, { path: "/runs/:runId", element: createElement(RunDetailPage) })),
    );
    // The Abort button shows while running. Click it + confirm ASAP.
    let clicked = false;
    await waitFor(() => {
      const btn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Abort");
      if (btn) { act(() => btn.click()); clicked = true; return true; }
      // If the run already finalized before we could click, stop waiting.
      return (container.textContent ?? "").includes("complete") || (container.textContent ?? "").includes("surfaced");
    }, 6_000);

    if (clicked) {
      await waitFor(() => Array.from(container.querySelectorAll("button")).some((b) => b.textContent === "Abort run"), 3_000);
      await act(async () => {
        Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Abort run")?.click();
      });
    }
    act(() => root.unmount());
    container.remove();

    const status = await pollStatus(server.base, runId, (s) => s === "aborted" || s === "complete" || s === "surfaced", 15_000);
    // If we caught it running, it must be aborted; otherwise the fake finished first.
    if (clicked) expect(status).toBe("aborted");
    else expect(["complete", "surfaced"]).toContain(status);
  }, 30_000);
});
