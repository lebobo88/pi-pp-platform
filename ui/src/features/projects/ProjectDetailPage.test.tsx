import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { apiPaths } from "@shared/api-types";
import { api } from "@/api/client";
import { createQueryClient } from "@/api/queryClient";
import { installMockApi } from "@/mocks/mockApi";
import { ProjectDetailPage } from "./ProjectDetailPage";

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

function setValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
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
      { initialEntries: ["/projects/C%3A%2FAiAppDeployments%2Facme-checkout"] },
      createElement(
        Routes,
        null,
        createElement(Route, { path: "/projects/:projectPath", element: createElement(ProjectDetailPage) }),
      ),
    ),
  );
}

describe("ProjectDetailPage profile editing", () => {
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

  it("loads the project profile document, supports a custom name, and preserves raw yaml edits", async () => {
    await api.put(apiPaths.projectProfile("C:/AiAppDeployments/acme-checkout"), {
      yaml: [
        "name: checkout-custom",
        "description: Custom checkout profile",
        "ladder:",
        "  sonnet: openai/gpt-5.4-mini",
        "tier_pools:",
        "  sonnet:",
        "    - openai/gpt-5.4-mini",
        "    - azure-openai/gpt-5.4-mini",
        "    - anthropic/claude-sonnet-4-6",
        "",
      ].join("\n"),
    });

    await act(async () => {
      root.render(App());
    });

    await waitFor(() => (container.textContent ?? "").includes("acme-checkout"));
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((btn) => btn.textContent === "Profile")!.click();
    });

    await waitFor(() => !!container.querySelector("textarea"));
    expect(container.textContent).toContain("checkout-custom");
    expect(container.textContent).not.toContain("Profile unavailable");
    expect(container.textContent).toContain(".harness/profile.yaml");

    const textarea = container.querySelector<HTMLTextAreaElement>("textarea")!;
    expect(textarea.value).toContain("tier_pools:");
    expect(textarea.value).toContain("azure-openai/gpt-5.4-mini");

    await act(async () => {
      setValue(textarea, textarea.value.replace("Custom checkout profile", "Custom checkout profile v2"));
    });
    const save = Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find((btn) => btn.textContent === "Save")!;
    expect(save.disabled).toBe(false);
    await act(async () => {
      save.click();
    });

    await waitFor(() => container.querySelector<HTMLTextAreaElement>("textarea")!.value.includes("Custom checkout profile v2"));
    expect(container.querySelector<HTMLTextAreaElement>("textarea")!.value).toContain("Custom checkout profile v2");
  });
});
