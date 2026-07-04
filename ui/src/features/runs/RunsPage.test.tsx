import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Routes, Route } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@/api/queryClient";
import { installMockApi } from "@/mocks/mockApi";
import { mockRunSummaries } from "@/mocks/fixtures";
import { useUiStore } from "@/stores/uiStore";
import { RunsPage } from "./RunsPage";

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

function App() {
  const qc = createQueryClient();
  return createElement(
    QueryClientProvider,
    { client: qc },
    createElement(
      MemoryRouter,
      { initialEntries: ["/runs"] },
      createElement(Routes, null, createElement(Route, { path: "/runs", element: createElement(RunsPage) })),
    ),
  );
}

describe("RunsPage — cursor pagination over the {items,next_cursor} envelope", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => installMockApi());
  beforeEach(() => {
    useUiStore.setState({ activeProjectPath: null });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const rows = () => container.querySelectorAll("tbody tr td[colspan]").length
    ? 0
    : container.querySelectorAll("tbody tr").length;
  const pagerButton = () =>
    [...container.querySelectorAll("button")].find((b) =>
      /Load more|Loading…|End of history/.test(b.textContent ?? ""),
    )!;

  it("loads page 1, disables sorting while more pages remain, then Load more → End of history", async () => {
    await act(async () => {
      root.render(App());
    });

    // Page 1: 25 rows (PAGE_SIZE) of the 40 fixture runs.
    await waitFor(() => rows() === 25);

    // Sorting disabled while hasNextPage — no sort glyphs in the header.
    expect(container.querySelector("thead")!.textContent).not.toContain("↕");

    const btn = pagerButton();
    expect(btn.textContent).toBe("Load more");
    expect(btn.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // All 40 runs flattened into the one table.
    await waitFor(() => rows() === mockRunSummaries.length);

    const done = pagerButton();
    expect(done.textContent).toBe("End of history");
    expect(done.hasAttribute("disabled")).toBe(true);

    // Sorting re-enabled once history is complete.
    expect(container.querySelector("thead")!.textContent).toContain("↕");
  });
});
