import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { MemoryRouter, Routes, Route } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@/api/queryClient";
import { installMockApi } from "@/mocks/mockApi";
import { mockAgents } from "@/mocks/fixtures";
import { AgentsPage } from "./AgentsPage";

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

/** Set a controlled input value the way React notices. */
function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function App(initialEntry = "/library/agents") {
  const qc = createQueryClient();
  return createElement(
    QueryClientProvider,
    { client: qc },
    createElement(
      MemoryRouter,
      { initialEntries: [initialEntry] },
      createElement(
        Routes,
        null,
        createElement(Route, { path: "/library/agents", element: createElement(AgentsPage) }),
      ),
    ),
  );
}

describe("AgentsPage (search + category grouping + ?id= selection)", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => installMockApi());
  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("lists every agent grouped by category (alphabetical, sticky headers)", async () => {
    await act(async () => {
      root.render(App());
    });

    await waitFor(() => container.querySelectorAll('[data-testid^="agent-row-"]').length > 0);

    // Full catalog renders (75 in the mock).
    expect(container.querySelectorAll('[data-testid^="agent-row-"]').length).toBe(mockAgents.length);
    expect(mockAgents.length).toBe(75);

    // Group headers are the distinct categories, alphabetically ordered.
    const headers = [...container.querySelectorAll('[data-testid^="agents-group-"]')].map(
      (el) => el.textContent,
    );
    const expected = [...new Set(mockAgents.map((a) => a.category))].sort();
    expect(headers).toEqual(expected);

    // Rows sit under their own category header (spot-check one group).
    const judgeHeader = container.querySelector('[data-testid="agents-group-judge"]');
    expect(judgeHeader).toBeTruthy();
  });

  it("filters by name + description and defaults the detail to the first visible agent", async () => {
    await act(async () => {
      root.render(App());
    });
    await waitFor(() => container.querySelectorAll('[data-testid^="agent-row-"]').length > 0);

    // Search by a description-only keyword: "STRIDE" appears only in
    // security-reviewer's description, not in any agent name.
    await act(async () => {
      setValue(container.querySelector<HTMLInputElement>('[data-testid="agents-search"]')!, "stride");
    });

    await waitFor(() => container.querySelectorAll('[data-testid^="agent-row-"]').length === 1);
    expect(container.querySelector('[data-testid="agent-row-security-reviewer"]')).toBeTruthy();
    // Only its category group remains.
    const headers = [...container.querySelectorAll('[data-testid^="agents-group-"]')].map((el) => el.textContent);
    expect(headers).toEqual(["governance"]);

    // The detail pane follows the first visible item and loads the prompt body.
    await waitFor(() => (container.querySelector('[data-testid="agent-detail"]')?.textContent ?? "").includes("Operating rules"));
    expect(container.querySelector('[data-testid="agent-detail"]')!.textContent).toContain("security-reviewer");
    // "Used by teams" chips render.
    expect(container.querySelector('[data-testid="agent-detail"]')!.textContent).toContain("security-review-team");
  });

  it("deep-links selection via ?id=", async () => {
    await act(async () => {
      root.render(App("/library/agents?id=architect"));
    });
    await waitFor(() => (container.querySelector('[data-testid="agent-detail"]')?.textContent ?? "").includes("architect"));
    expect(container.querySelector('[data-testid="agent-detail"]')!.textContent).toContain("C4 sketches");
  });
});
