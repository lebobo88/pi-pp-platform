import { describe, it, expect, beforeEach } from "vitest";
import { useUiStore } from "./uiStore";

describe("uiStore", () => {
  beforeEach(() => {
    localStorage.removeItem("pp.ui");
    useUiStore.setState({ sidebarCollapsed: false, toasts: [], activeProjectPath: null });
  });

  it("toggleSidebar flips sidebarCollapsed", () => {
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    useUiStore.getState().toggleSidebar();
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    useUiStore.getState().toggleSidebar();
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
  });

  it("persists ONLY sidebarCollapsed to localStorage under pp.ui", () => {
    useUiStore.getState().setActiveProject("C:/somewhere");
    useUiStore.getState().pushToast({ tone: "info", title: "hi", ttl: 0 });
    useUiStore.getState().toggleSidebar();

    const raw = localStorage.getItem("pp.ui");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as { state: Record<string, unknown> };
    expect(parsed.state.sidebarCollapsed).toBe(true);
    // Toasts and the project picker are per-session UI state and must not persist.
    expect(Object.keys(parsed.state)).toEqual(["sidebarCollapsed"]);
  });
});
