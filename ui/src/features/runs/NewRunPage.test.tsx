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

    // Step 1: pick a project + type a request.
    await act(async () => {
      const project = container.querySelector<HTMLSelectElement>('[data-testid="wizard-project"]')!;
      setValue(project, project.options[1]!.value);
      const request = container.querySelector<HTMLTextAreaElement>('[data-testid="wizard-request"]')!;
      setValue(request, "Add a coupon-code field to checkout and validate it server-side.");
    });

    // Walk steps 1→2→3→4 (single mode is valid by default at every step).
    const clickNext = async () => {
      await waitFor(() => {
        const btn = container.querySelector<HTMLButtonElement>('[data-testid="wizard-next"]');
        return !!btn && !btn.disabled;
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="wizard-next"]')!.click();
      });
    };
    await clickNext(); // → step 2
    await clickNext(); // → step 3
    await clickNext(); // → step 4

    await waitFor(() => {
      const btn = container.querySelector<HTMLButtonElement>('[data-testid="wizard-launch"]');
      return !!btn && !btn.disabled;
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="wizard-launch"]')!.click();
    });

    // Navigation to the run view, which fetches + renders the (fake) run tree.
    // "Pipeline" only appears on RunDetailPage, so it proves navigation landed.
    await waitFor(() => (container.textContent ?? "").includes("Pipeline"));
    expect(container.textContent).toContain("implementation");
    expect(container.textContent).toContain("coupon-code");
  }, 20000);

  it("keeps advanced model routing available in best-of mode while tier caps stay disabled", async () => {
    await act(async () => {
      root.render(App());
    });

    await waitFor(() => {
      const sel = container.querySelector<HTMLSelectElement>('[data-testid="wizard-project"]');
      return !!sel && sel.options.length > 1;
    });

    await act(async () => {
      const project = container.querySelector<HTMLSelectElement>('[data-testid="wizard-project"]')!;
      setValue(project, project.options[1]!.value);
      const request = container.querySelector<HTMLTextAreaElement>('[data-testid="wizard-request"]')!;
      setValue(request, "Generate a few best-of checkout copy variants.");
    });

    const clickNext = async () => {
      await waitFor(() => {
        const btn = container.querySelector<HTMLButtonElement>('[data-testid="wizard-next"]');
        return !!btn && !btn.disabled;
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="wizard-next"]')!.click();
      });
    };
    await clickNext(); // step 2

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="mode-best_of"]')!.click();
    });
    await clickNext(); // step 3

    await waitFor(() => !!container.querySelector('[data-testid="wizard-ladder-override-sonnet"]'));
    expect(container.querySelector<HTMLSelectElement>('[data-testid="wizard-tier-cap"]')?.disabled).toBe(true);
    expect(container.querySelector('[data-testid="wizard-tier-pool-add-sonnet"]')).toBeTruthy();

    await act(async () => {
      setValue(container.querySelector<HTMLInputElement>('[data-testid="wizard-ladder-override-sonnet"]')!, "openai/gpt-5.4-mini");
      setValue(container.querySelector<HTMLInputElement>('[data-testid="wizard-tier-pool-add-sonnet"]')!, "azure-openai/gpt-5.4-mini");
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-testid="wizard-tier-pool-add-btn-sonnet"]')!.click();
    });

    await waitFor(() => !!container.querySelector('[data-testid="wizard-tier-pool-sonnet-0"]'));
    expect(container.querySelector<HTMLInputElement>('[data-testid="wizard-ladder-override-sonnet"]')?.value).toBe("openai/gpt-5.4-mini");
    expect(container.querySelector<HTMLInputElement>('[data-testid="wizard-tier-pool-sonnet-0"]')?.value).toBe("azure-openai/gpt-5.4-mini");
  }, 20000);

  it("does not commit an ambiguous bare ladder override into wizard state", async () => {
    await act(async () => {
      root.render(App());
    });

    await waitFor(() => {
      const sel = container.querySelector<HTMLSelectElement>('[data-testid="wizard-project"]');
      return !!sel && sel.options.length > 1;
    });

    await act(async () => {
      const project = container.querySelector<HTMLSelectElement>('[data-testid="wizard-project"]')!;
      setValue(project, project.options[1]!.value);
      const request = container.querySelector<HTMLTextAreaElement>('[data-testid="wizard-request"]')!;
      setValue(request, "Try an ambiguous model override but keep default routing.");
    });

    const clickNext = async () => {
      await waitFor(() => {
        const btn = container.querySelector<HTMLButtonElement>('[data-testid="wizard-next"]');
        return !!btn && !btn.disabled;
      });
      await act(async () => {
        container.querySelector<HTMLButtonElement>('[data-testid="wizard-next"]')!.click();
      });
    };
    await clickNext();
    await clickNext();

    await waitFor(() => !!container.querySelector('[data-testid="wizard-ladder-override-sonnet"]'));
    await act(async () => {
      setValue(container.querySelector<HTMLInputElement>('[data-testid="wizard-ladder-override-sonnet"]')!, "gpt-5.4-mini");
    });
    await act(async () => {
      container.querySelector<HTMLInputElement>('[data-testid="wizard-ladder-override-sonnet"]')!.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    });

    await clickNext();
    expect(container.textContent).toContain("model routing");
    expect(container.textContent).toContain("default");
  }, 20000);
});
