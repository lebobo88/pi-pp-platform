import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider, Navigate } from "react-router";
import { createQueryClient } from "@/api/queryClient";
import { GlobalEvents } from "@/api/GlobalEvents";
import { AppShell } from "@/layout/AppShell";
import { ToastViewport } from "@/components/Toast";
import { NewRunPage, EvolutionPage, NotFoundPage } from "@/routes/stubs";
import { KitchenSinkPage } from "@/routes/KitchenSink";
import { DashboardPage } from "@/features/dashboard/DashboardPage";
import { ProjectsPage } from "@/features/projects/ProjectsPage";
import { ProjectDetailPage } from "@/features/projects/ProjectDetailPage";
import { RunsPage } from "@/features/runs/RunsPage";
import { RunDetailPage } from "@/features/runs/RunDetailPage";
import { ProvidersPage } from "@/features/providers/ProvidersPage";
import { BudgetsPage } from "@/features/budgets/BudgetsPage";
import { TeamsPage } from "@/features/library/TeamsPage";
import { RubricsPage } from "@/features/library/RubricsPage";
import { ProfilesPage } from "@/features/library/ProfilesPage";
import { SystemPage } from "@/features/system/SystemPage";

const queryClient = createQueryClient();

const router = createBrowserRouter([
  {
    element: <AppShell />,
    children: [
      { path: "/", element: <DashboardPage /> },
      { path: "/projects", element: <ProjectsPage /> },
      { path: "/projects/:projectPath", element: <ProjectDetailPage /> },
      { path: "/runs", element: <RunsPage /> },
      { path: "/runs/new", element: <NewRunPage /> },
      { path: "/runs/:runId", element: <RunDetailPage /> },
      { path: "/providers", element: <ProvidersPage /> },
      { path: "/budgets", element: <BudgetsPage /> },
      { path: "/evolution", element: <EvolutionPage /> },
      { path: "/library", element: <Navigate to="/library/teams" replace /> },
      { path: "/library/teams", element: <TeamsPage /> },
      { path: "/library/rubrics", element: <RubricsPage /> },
      { path: "/library/profiles", element: <ProfilesPage /> },
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
