import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { MemoryRouter, Routes, Route } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@/api/queryClient";
import { installMockApi } from "@/mocks/mockApi";
import { mockSkills } from "@/mocks/fixtures";
import { SkillsPage } from "./SkillsPage";

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

function App(initialEntry = "/library/skills") {
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
        createElement(Route, { path: "/library/skills", element: createElement(SkillsPage) }),
      ),
    ),
  );
}

describe("SkillsPage (list + detail chips + ?id= deep link)", () => {
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

  it("renders every skill and the first skill's detail with its scope chips", async () => {
    await act(async () => {
      root.render(App());
    });

    await waitFor(() => container.querySelectorAll('[data-testid^="skill-row-"]').length > 0);
    expect(container.querySelectorAll('[data-testid^="skill-row-"]').length).toBe(mockSkills.length);

    // Default selection is the first skill (api-contracts) — its detail shows
    // the injection pill, stage pills, and accent profile pills.
    await waitFor(() => (container.querySelector('[data-testid="skill-detail"]')?.textContent ?? "").includes("Checklist"));
    const detail = container.querySelector('[data-testid="skill-detail"]')!;
    expect(detail.textContent).toContain("api-contracts");
    expect(detail.textContent).toContain("generator"); // injection pill
    expect(detail.textContent).toContain("contracts"); // applies_to_stages pill
    expect(detail.textContent).toContain("api-platform"); // applies_to_profiles pill
    expect(detail.textContent).not.toContain("applies to all stages");
  });

  it("deep-links via ?id= and captions unscoped skills with 'applies to all stages'", async () => {
    await act(async () => {
      root.render(App("/library/skills?id=judge-calibration"));
    });

    // judge-calibration has empty applies_to_* arrays → the caption shows.
    await waitFor(() => (container.querySelector('[data-testid="skill-detail"]')?.textContent ?? "").includes("judge-calibration"));
    await waitFor(() => (container.querySelector('[data-testid="skill-detail"]')?.textContent ?? "").includes("Checklist"));
    const detail = container.querySelector('[data-testid="skill-detail"]')!;
    expect(detail.textContent).toContain("applies to all stages");
    expect(detail.textContent).toContain("judge"); // injection pill
  });
});
