import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@/api/queryClient";
import { installMockApi } from "@/mocks/mockApi";
import { useUiStore } from "@/stores/uiStore";
import { ProjectPicker } from "./ProjectPicker";

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
}

function key(el: Element, k: string) {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
}

function App() {
  const qc = createQueryClient();
  return createElement(
    QueryClientProvider,
    { client: qc },
    createElement(MemoryRouter, null, createElement(ProjectPicker)),
  );
}

describe("ProjectPicker — searchable combobox", () => {
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

  const trigger = () => container.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')!;
  const input = () => container.querySelector<HTMLInputElement>('input[role="combobox"]');
  const optionNames = () =>
    [...container.querySelectorAll('[role="option"]')].map(
      (o) => o.querySelector("span > span")!.textContent,
    );

  async function open() {
    await act(async () => {
      trigger().dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
  }

  it("opens with autofocused search, All projects first, projects sorted by last_run_at desc", async () => {
    await act(async () => {
      root.render(App());
    });
    expect(trigger().textContent).toBe("All projects");

    await open();
    await waitFor(() => optionNames().length === 4);

    expect(document.activeElement).toBe(input());
    // acme (Jul 1) > pi-pp (Jun 30) > orbit (Jun 29).
    expect(optionNames()).toEqual(["All projects", "acme-checkout", "pi-pp-platform", "orbit-api"]);
    // The current selection ("All projects") is marked.
    expect(container.querySelector('[role="option"][aria-selected="true"]')!.textContent).toContain("All projects");
    // Footer registration link.
    expect(container.querySelector('a[href="/projects"]')!.textContent).toContain("Register project");
  });

  it("filters as you type and Enter selects the active option (writes uiStore)", async () => {
    await act(async () => {
      root.render(App());
    });
    await open();
    await waitFor(() => optionNames().length === 4);

    await act(async () => {
      setValue(input()!, "orb");
    });
    expect(optionNames()).toEqual(["orbit-api"]);

    await act(async () => {
      key(input()!, "Enter");
    });
    expect(useUiStore.getState().activeProjectPath).toBe("C:/AiAppDeployments/orbit-api");
    expect(input()).toBeNull(); // popover closed
    expect(trigger().textContent).toBe("orbit-api");
  });

  it("arrow keys move the active row; Escape closes without selecting", async () => {
    await act(async () => {
      root.render(App());
    });
    await open();
    await waitFor(() => optionNames().length === 4);

    await act(async () => {
      key(input()!, "ArrowDown");
    });
    expect(input()!.getAttribute("aria-activedescendant")).toBe("project-picker-listbox-opt-1");

    await act(async () => {
      key(input()!, "Escape");
    });
    expect(input()).toBeNull();
    expect(useUiStore.getState().activeProjectPath).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });
});
