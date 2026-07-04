import { create } from "zustand";
import { persist } from "zustand/middleware";

/**
 * API-token auth state. The daemon may require a bearer token; when a request
 * comes back 401 the client marks `unauthorized` and the TokenGate modal asks
 * for a token. The token persists in localStorage (key "pp.apiToken") so a
 * reload doesn't re-prompt.
 */
export interface AuthState {
  /** Bearer token, or null when none is set. */
  token: string | null;
  /** True after any request 401'd; cleared by setToken. */
  unauthorized: boolean;
  setToken: (token: string | null) => void;
  clearToken: () => void;
  markUnauthorized: () => void;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set) => ({
      token: null,
      unauthorized: false,
      setToken: (token) => set({ token: token || null, unauthorized: false }),
      clearToken: () => set({ token: null }),
      markUnauthorized: () => set({ unauthorized: true }),
    }),
    {
      name: "pp.apiToken",
      // Only the token persists; `unauthorized` is per-session UI state.
      partialize: (s) => ({ token: s.token }),
    },
  ),
);

/** Imperative token read for non-React modules (api client, SSE manager). */
export function getApiToken(): string | null {
  return useAuthStore.getState().token;
}

/** Imperative 401 flag for non-React modules (api client). */
export function markUnauthorized(): void {
  useAuthStore.getState().markUnauthorized();
}
