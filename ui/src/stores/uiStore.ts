import { create } from "zustand";
import { persist } from "zustand/middleware";

export type ToastTone = "info" | "success" | "warn" | "error";

export interface Toast {
  id: string;
  tone: ToastTone;
  title: string;
  message?: string;
  /** Auto-dismiss after ms; 0 = sticky. */
  ttl: number;
}

export interface UiState {
  /** Currently selected project path (top-bar picker), or null for "all". */
  activeProjectPath: string | null;
  setActiveProject: (path: string | null) => void;

  sidebarCollapsed: boolean;
  toggleSidebar: () => void;

  toasts: Toast[];
  pushToast: (t: Omit<Toast, "id" | "ttl"> & { ttl?: number }) => string;
  dismissToast: (id: string) => void;
}

let toastSeq = 0;

export const useUiStore = create<UiState>()(
  persist(
    (set, get) => ({
      activeProjectPath: null,
      setActiveProject: (path) => set({ activeProjectPath: path }),

      sidebarCollapsed: false,
      toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

      toasts: [],
      pushToast: (t) => {
        const id = `toast_${++toastSeq}`;
        const ttl = t.ttl ?? 4200;
        set((s) => ({ toasts: [...s.toasts, { id, ttl, ...t }] }));
        if (ttl > 0) {
          setTimeout(() => get().dismissToast(id), ttl);
        }
        return id;
      },
      dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((x) => x.id !== id) })),
    }),
    {
      name: "pp.ui",
      // Only the sidebar preference persists; toasts and the project picker
      // are per-session UI state.
      partialize: (s) => ({ sidebarCollapsed: s.sidebarCollapsed }),
    },
  ),
);

/** Imperative helper so non-component code can raise a toast. */
export function toast(t: Omit<Toast, "id" | "ttl"> & { ttl?: number }): string {
  return useUiStore.getState().pushToast(t);
}
