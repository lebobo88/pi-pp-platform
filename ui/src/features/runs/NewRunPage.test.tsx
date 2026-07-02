import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { MemoryRouter, Routes, Route } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@/api/queryClient";
import { installMockApi } from "@/mocks/mockApi";
import { liveRunStore } from "@/stores/liveRunStore";
import { NewRunPage } from "./NewRunPage";
import { RunDetailPage } from "./RunDetailPage";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, timeout = 10000, interval = 60): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (check()) return;
    await act(async () => {
      await sleep(interval);
    });
  }
  if (!check()) throw new Error("waitFor timed out");
}

/** Set a controlled input/textarea/select value the way React notices. */
function setValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto =
    el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function App() {
  const qc = createQueryClient();
  return createElement(
    QueryClientProvider,
    { client: qc },
    createElement(
      MemoryRouter,
      { initialEntries: ["/runs/new"] },
      createElement(
        Routes,
        null,
        createElement(Route, { path: "/runs/new", element: createElement(NewRunPage) }),
        createElement(Route, { path: "/runs/:runId", element: createElement(RunDetailPage) }),
      ),
    ),
  );
}

describe("New run wizard → run view (full UI-driven run)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => installMockApi());
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

  it("dispatches a run from the wizard and lands on the animated run view", async () => {
    await act(async () => {
      root.render(App());
    });

    // Wait for the projects list to populate the select.
    await waitFor(() => {
      const sel = container.querySelector<HTMLSelectElement>('[data-testid="wizard-project"]');
      return !!sel && sel.options.length > 1;
    });

    await act(async () => {
      const project = container.querySelector<HTMLSelectElement>('[data-testid="wizard-project"]')!;
      setValue(project, project.options[1]!.value);
      const request = container.querySelector<HTMLTextAreaElement>('[data-testid="wizard-request"]')!;
      setValue(request, "Add a coupon-code field to checkout and validate it server-side.");
    });

    // Submit enables once the form is valid.
    await waitFor(() => {
      const btn = container.querySelector<HTMLButtonElement>('[data-testid="wizard-submit"]');
      return !!btn && !btn.disabled;
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="wizard-submit"]')!.click();
    });

    // Navigation to the run view, which fetches + renders the (fake) run tree.
    // "Pipeline" only appears on RunDetailPage, so it proves navigation landed
    // (the wizard's own textarea already contains "coupon-code").
    await waitFor(() => (container.textContent ?? "").includes("Pipeline"));
    expect(container.textContent).toContain("implementation");
    expect(container.textContent).toContain("coupon-code");
  }, 20000);
});
