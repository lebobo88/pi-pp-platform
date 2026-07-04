import { describe, it, expect, beforeEach } from "vitest";
import { useAuthStore, getApiToken } from "./authStore";

beforeEach(() => {
  useAuthStore.setState({ token: null, unauthorized: false });
  localStorage.removeItem("pp.apiToken");
});

describe("authStore", () => {
  it("starts with no token and not unauthorized", () => {
    expect(useAuthStore.getState().token).toBeNull();
    expect(useAuthStore.getState().unauthorized).toBe(false);
    expect(getApiToken()).toBeNull();
  });

  it("setToken stores the token and exposes it imperatively", () => {
    useAuthStore.getState().setToken("tok_abc123");
    expect(useAuthStore.getState().token).toBe("tok_abc123");
    expect(getApiToken()).toBe("tok_abc123");
  });

  it("setToken clears the unauthorized flag", () => {
    useAuthStore.getState().markUnauthorized();
    expect(useAuthStore.getState().unauthorized).toBe(true);
    useAuthStore.getState().setToken("tok_abc123");
    expect(useAuthStore.getState().unauthorized).toBe(false);
  });

  it("normalizes an empty token to null", () => {
    useAuthStore.getState().setToken("");
    expect(useAuthStore.getState().token).toBeNull();
  });

  it("clearToken drops the token", () => {
    useAuthStore.getState().setToken("tok_abc123");
    useAuthStore.getState().clearToken();
    expect(getApiToken()).toBeNull();
  });

  it("persists the token (only) to localStorage under pp.apiToken", () => {
    useAuthStore.getState().setToken("tok_persist");
    useAuthStore.getState().markUnauthorized();
    const raw = localStorage.getItem("pp.apiToken");
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw!) as { state: Record<string, unknown> };
    expect(parsed.state.token).toBe("tok_persist");
    // unauthorized is per-session UI state and must not persist.
    expect(parsed.state).not.toHaveProperty("unauthorized");
  });
});
