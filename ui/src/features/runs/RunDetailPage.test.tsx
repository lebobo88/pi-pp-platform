import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { MemoryRouter, Routes, Route } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@/api/queryClient";
import { installMockApi } from "@/mocks/mockApi";
import { liveRunStore } from "@/stores/liveRunStore";
import { MOCK_RUN_ID } from "@/mocks/fixtures/runTree";
import { RunDetailPage } from "./RunDetailPage";

// React 18 act environment flag.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll `check` until it's truthy, flushing React work between polls. */
async function waitFor(check: () => boolean, timeout = 8000, interval = 60): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (check()) return;
    await act(async () => {
      await sleep(interval);
    });
  }
  if (!check()) throw new Error("waitFor timed out");
}

function App() {
  const qc = createQueryClient();
  return createElement(
    QueryClientProvider,
    { client: qc },
    createElement(
      MemoryRouter,
      { initialEntries: [`/runs/${MOCK_RUN_ID}`] },
      createElement(
        Routes,
        null,
        createElement(Route, { path: "/runs/:runId", element: createElement(RunDetailPage) }),
      ),
    ),
  );
}

describe("RunDetailPage (mock render + live animation)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    installMockApi();
  });

  beforeEach(() => {
    liveRunStore.reset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the fetched run tree", async () => {
    await act(async () => {
      root.render(App());
    });
    await waitFor(() => container.textContent?.includes("coupon-code") ?? false);

    const text = container.textContent ?? "";
    // Run header rendered the request.
    expect(text).toContain("coupon-code");
    // Pipeline rail rendered the stage kinds.
    expect(text).toContain("implementation");
    expect(text).toContain("Pipeline");
    // Tabs present.
    expect(text).toContain("Candidates");
    expect(text).toContain("Missability");
  }, 15000);

  it("animates from the scripted SSE replay", async () => {
    await act(async () => {
      root.render(App());
    });

    // The scripted replay drives the live overlay: at least one stage status
    // arrives, and log output streams into an attempt buffer.
    await waitFor(() => Object.keys(liveRunStore.getOverlay(MOCK_RUN_ID).stageStatus).length > 0);
    expect(Object.keys(liveRunStore.getOverlay(MOCK_RUN_ID).stageStatus).length).toBeGreaterThan(0);

    await waitFor(() => {
      const overlay = liveRunStore.getOverlay(MOCK_RUN_ID);
      const anyLog =
        liveRunStore.getLog("att_spec_1").lines.length > 0 ||
        liveRunStore.getLog("att_impl_b").lines.length > 0;
      return anyLog || overlay.version > 2;
    });

    expect(liveRunStore.getOverlay(MOCK_RUN_ID).version).toBeGreaterThan(0);
  }, 15000);
});
