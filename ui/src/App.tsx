import { lazy } from "react";
import { QueryClientProvider } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider, Navigate } from "react-router";
import { createQueryClient } from "@/api/queryClient";
import { GlobalEvents } from "@/api/GlobalEvents";
import { AppShell } from "@/layout/AppShell";
import { ToastViewport } from "@/components/Toast";
import { TokenGate } from "@/features/auth/TokenGate";
import { DashboardPage } from "@/features/dashboard/DashboardPage";

/*
 * Code splitting: every route except the Dashboard (the landing screen) loads
 * lazily so the initial bundle stays small. Pages use named exports, hence the
 * `.then((m) => ({ default: m.X }))` shim. AppShell wraps the Outlet in
 * <Suspense>, which shows a tiny fallback while a chunk loads.
 */
const ProjectsPage = lazy(() => import("@/features/projects/ProjectsPage").then((m) => ({ default: m.ProjectsPage })));
const ProjectDetailPage = lazy(() => import("@/features/projects/ProjectDetailPage").then((m) => ({ default: m.ProjectDetailPage })));
const RunsPage = lazy(() => import("@/features/runs/RunsPage").then((m) => ({ default: m.RunsPage })));
const RunDetailPage = lazy(() => import("@/features/runs/RunDetailPage").then((m) => ({ default: m.RunDetailPage })));
const NewRunPage = lazy(() => import("@/features/runs/NewRunPage").then((m) => ({ default: m.NewRunPage })));
const EvolutionPage = lazy(() => import("@/features/evolution/EvolutionPage").then((m) => ({ default: m.EvolutionPage })));
const ProvidersPage = lazy(() => import("@/features/providers/ProvidersPage").then((m) => ({ default: m.ProvidersPage })));
const BudgetsPage = lazy(() => import("@/features/budgets/BudgetsPage").then((m) => ({ default: m.BudgetsPage })));
const TeamsPage = lazy(() => import("@/features/library/TeamsPage").then((m) => ({ default: m.TeamsPage })));
const AgentsPage = lazy(() => import("@/features/library/AgentsPage").then((m) => ({ default: m.AgentsPage })));
const SkillsPage = lazy(() => import("@/features/library/SkillsPage").then((m) => ({ default: m.SkillsPage })));
const RubricsPage = lazy(() => import("@/features/library/RubricsPage").then((m) => ({ default: m.RubricsPage })));
const ProfilesPage = lazy(() => import("@/features/library/ProfilesPage").then((m) => ({ default: m.ProfilesPage })));
const ForumsPage = lazy(() => import("@/features/library/ForumsPage").then((m) => ({ default: m.ForumsPage })));
const TaxonomyPage = lazy(() => import("@/features/library/TaxonomyPage").then((m) => ({ default: m.TaxonomyPage })));
const SystemPage = lazy(() => import("@/features/system/SystemPage").then((m) => ({ default: m.SystemPage })));
const KitchenSinkPage = lazy(() => import("@/routes/KitchenSink").then((m) => ({ default: m.KitchenSinkPage })));
const NotFoundPage = lazy(() => import("@/routes/stubs").then((m) => ({ default: m.NotFoundPage })));
const RunObservatoryPage = lazy(() => import("@/features/observability/RunObservatoryPage").then((m) => ({ default: m.RunObservatoryPage })));
const MissionControlPage = lazy(() => import("@/features/observability/MissionControlPage").then((m) => ({ default: m.MissionControlPage })));

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
      { path: "/runs/:runId/live", element: <RunObservatoryPage /> },
      { path: "/observability", element: <MissionControlPage /> },
      { path: "/providers", element: <ProvidersPage /> },
      { path: "/budgets", element: <BudgetsPage /> },
      { path: "/evolution", element: <EvolutionPage /> },
      { path: "/library", element: <Navigate to="/library/teams" replace /> },
      { path: "/library/teams", element: <TeamsPage /> },
      { path: "/library/agents", element: <AgentsPage /> },
      { path: "/library/skills", element: <SkillsPage /> },
      { path: "/library/rubrics", element: <RubricsPage /> },
      { path: "/library/profiles", element: <ProfilesPage /> },
      { path: "/library/forums", element: <ForumsPage /> },
      { path: "/library/taxonomy", element: <TaxonomyPage /> },
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
      <TokenGate />
      <ToastViewport />
    </QueryClientProvider>
  );
}
