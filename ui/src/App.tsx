import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider, Navigate } from "react-router";
import { createQueryClient } from "@/api/queryClient";
import { GlobalEvents } from "@/api/GlobalEvents";
import { AppShell } from "@/layout/AppShell";
import { ToastViewport } from "@/components/Toast";
import {
  DashboardPage,
  ProjectsPage,
  RunsPage,
  NewRunPage,
  RunDetailPage,
  ProvidersPage,
  BudgetsPage,
  EvolutionPage,
  LibraryTeamsPage,
  LibraryRubricsPage,
  LibraryProfilesPage,
  SystemPage,
  NotFoundPage,
} from "@/routes/stubs";
import { KitchenSinkPage } from "@/routes/KitchenSink";

const queryClient = createQueryClient();

const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: "/", element: <DashboardPage /> },
      { path: "/projects", element: <ProjectsPage /> },
      { path: "/runs", element: <RunsPage /> },
      { path: "/runs/new", element: <NewRunPage /> },
      { path: "/runs/:runId", element: <RunDetailPage /> },
      { path: "/providers", element: <ProvidersPage /> },
      { path: "/budgets", element: <BudgetsPage /> },
      { path: "/evolution", element: <EvolutionPage /> },
      { path: "/library", element: <Navigate to="/library/teams" replace /> },
      { path: "/library/teams", element: <LibraryTeamsPage /> },
      { path: "/library/rubrics", element: <LibraryRubricsPage /> },
      { path: "/library/profiles", element: <LibraryProfilesPage /> },
      { path: "/system", element: <SystemPage /> },
      { path: "/kitchen-sink", element: <KitchenSinkPage /> },
      { path: "*", element: <NotFoundPage /> },
    ],
  },
]);

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <GlobalEvents />
      <RouterProvider router={router} />
      <ToastViewport />
    </QueryClientProvider>
  );
}
