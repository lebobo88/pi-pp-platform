import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@/api/queryClient";
import { installMockApi } from "@/mocks/mockApi";
import { ProvidersPage } from "./ProvidersPage";

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

function setValue(el: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
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
      { initialEntries: ["/providers"] },
      createElement(
        Routes,
        null,
        createElement(Route, { path: "/providers", element: createElement(ProvidersPage) }),
      ),
    ),
  );
}

describe("ProvidersPage settings editor", () => {
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

  it("stores provider-qualified pool entries and allows the same model id from different providers", async () => {
    await act(async () => {
      root.render(App());
    });

    await waitFor(() => !!container.querySelector('[data-testid="tier-pool-add-claude-sonnet"]'));
    expect(container.querySelector('[data-testid="tier-pool-claude-sonnet-0"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="tier-pool-claude-sonnet-1"]')).toBeTruthy();

    await act(async () => {
      setValue(container.querySelector<HTMLInputElement>('[data-testid="tier-pool-add-claude-sonnet"]')!, "azure-openai/gpt-5.4-mini");
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="tier-pool-add-btn-claude-sonnet"]')!.click();
    });

    await waitFor(() => !!container.querySelector('[data-testid="tier-pool-claude-sonnet-2"]'));
    expect(container.querySelector<HTMLInputElement>('[data-testid="tier-pool-claude-sonnet-0"]')?.value).toBe("openai/gpt-5.4-mini");
    expect(container.querySelector<HTMLInputElement>('[data-testid="tier-pool-claude-sonnet-1"]')?.value).toBe("anthropic/claude-sonnet-4-6");
    expect(container.querySelector<HTMLInputElement>('[data-testid="tier-pool-claude-sonnet-2"]')?.value).toBe("azure-openai/gpt-5.4-mini");
  });

  it("does not add an ambiguous bare model id to a tier pool", async () => {
    await act(async () => {
      root.render(App());
    });

    await waitFor(() => !!container.querySelector('[data-testid="tier-pool-add-claude-sonnet"]'));
    expect(container.querySelectorAll('[data-testid^="tier-pool-claude-sonnet-"]').length).toBe(2);

    await act(async () => {
      setValue(container.querySelector<HTMLInputElement>('[data-testid="tier-pool-add-claude-sonnet"]')!, "gpt-5.4-mini");
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="tier-pool-add-btn-claude-sonnet"]')!.click();
    });

    await act(async () => {
      await sleep(180);
    });

    expect(container.querySelectorAll('[data-testid^="tier-pool-claude-sonnet-"]').length).toBe(2);
    expect(container.querySelector<HTMLInputElement>('[data-testid="tier-pool-add-claude-sonnet"]')?.value).toBe("gpt-5.4-mini");
  });
});
