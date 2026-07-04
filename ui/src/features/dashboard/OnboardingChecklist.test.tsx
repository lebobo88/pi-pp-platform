import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@/api/queryClient";
import { installMockApi } from "@/mocks/mockApi";
import { OnboardingChecklist } from "./OnboardingChecklist";

// React 18 act environment flag.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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
    createElement(MemoryRouter, null, createElement(OnboardingChecklist)),
  );
}

describe("OnboardingChecklist", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeAll(() => {
    installMockApi();
  });

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders the three steps with live checkmarks from the mock API", async () => {
    await act(async () => {
      root.render(App());
    });
    // Mock providers include configured vendors and mock projects exist, so
    // steps 1 and 2 resolve to done once the queries land.
    await waitFor(() => (container.textContent?.match(/✓/g)?.length ?? 0) >= 2);

    const text = container.textContent ?? "";
    expect(text).toContain("Get started");
    expect(text).toContain("Add a provider key");
    expect(text).toContain("Register a project");
    expect(text).toContain("Launch your first run");

    // With steps 1+2 done the run step unlocks.
    const buttons = Array.from(container.querySelectorAll("button"));
    const runBtn = buttons.find((b) => b.textContent?.includes("New run"));
    expect(runBtn).toBeTruthy();
    expect(runBtn!.disabled).toBe(false);
  }, 15000);

  it("disables the run step before providers/projects load", async () => {
    await act(async () => {
      root.render(App());
    });
    // Synchronously after mount (queries pending) the gate must hold.
    const buttons = Array.from(container.querySelectorAll("button"));
    const runBtn = buttons.find((b) => b.textContent?.includes("New run"));
    expect(runBtn).toBeTruthy();
    expect(runBtn!.disabled).toBe(true);
  }, 15000);
});
