import { Suspense } from "react";
import { Outlet } from "react-router";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { EmptyState } from "@/components/EmptyState";

/** Shown while a lazy route chunk loads (see App.tsx code splitting). */
function RouteFallback() {
  return (
    <div className="flex h-full items-center justify-center">
      <EmptyState compact title="Loading…" />
    </div>
  );
}

export function AppShell() {
  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg-0 text-ink-1">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar />
        <main className="min-h-0 flex-1 overflow-auto">
          <Suspense fallback={<RouteFallback />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
