import { useParams } from "react-router";
import { Page } from "@/layout/Page";
import { EmptyState } from "@/components/EmptyState";
import {
  IconDashboard,
  IconProjects,
  IconRuns,
  IconProviders,
  IconBudgets,
  IconEvolution,
  IconLibrary,
  IconSystem,
} from "@/components/icons";

/**
 * Foundation route stubs. Each is a real, navigable page with the shared frame
 * and an EmptyState describing what a later feature agent will build here —
 * every one of these has fixtures available through the mock API and the query
 * hooks in src/api/queries, so screens can be filled in against mocks.
 */

export function DashboardPage() {
  return (
    <Page title="Dashboard" description="Live harness overview — active runs, budget, provider health.">
      <EmptyState
        icon={<IconDashboard />}
        title="Dashboard lands here"
        description="Active-run tiles, day budget meter, and provider health. Fixtures: useRuns(), useBudgets(), useProviders()."
      />
    </Page>
  );
}

export function ProjectsPage() {
  return (
    <Page title="Projects" description="Every project path the harness has seen.">
      <EmptyState
        icon={<IconProjects />}
        title="Projects list"
        description="A sortable table of projects with run counts and last-run time. Fixture: useProjects()."
      />
    </Page>
  );
}

export function RunsPage() {
  return (
    <Page title="Runs" description="Recent pair-programmer runs across all projects.">
      <EmptyState
        icon={<IconRuns />}
        title="Runs list"
        description="A dense, sortable run table filtered by the top-bar project picker. Fixture: useRuns()."
      />
    </Page>
  );
}

export function NewRunPage() {
  return (
    <Page title="New run" description="Compose a request and dispatch it through the lifecycle.">
      <EmptyState
        icon={<IconRuns />}
        title="Run wizard"
        description="Request text, mode (single / best-of / team / review), profile, and tier caps. Built by the M6 control agent."
      />
    </Page>
  );
}

export function RunDetailPage() {
  const { runId } = useParams();
  return (
    <Page title="Run detail" description={<span className="mono">{runId}</span>}>
      <EmptyState
        icon={<IconRuns />}
        title="Run tree"
        description="Stage/attempt/verdict tree, live log pane, best-of Borda panel, and diff viewer. Fixtures: useRun(runId) + the run SSE stream via SseManager + liveRunStore."
      />
    </Page>
  );
}

export function ProvidersPage() {
  return (
    <Page title="Providers & Models" description="Vendor credentials, health, and priced model catalog.">
      <EmptyState
        icon={<IconProviders />}
        title="Providers & models"
        description="Provider cards (masked keys, degraded flags) and the priced model table. Fixtures: useProviders(), useModels()."
      />
    </Page>
  );
}

export function BudgetsPage() {
  return (
    <Page title="Budgets" description="Rolling token and cost totals by scope.">
      <EmptyState
        icon={<IconBudgets />}
        title="Budgets"
        description="Day / run / model / tier meters with 80% and 100% tripwire ticks. Fixture: useBudgets()."
      />
    </Page>
  );
}

export function EvolutionPage() {
  return (
    <Page title="Evolution" description="Autogenesis proposals (T4) awaiting review.">
      <EmptyState
        icon={<IconEvolution />}
        title="Evolution proposals"
        description="Propose / evaluate / commit cards routed to TheEights. Fixture: useEvolutionProposals()."
      />
    </Page>
  );
}

export function LibraryTeamsPage() {
  return (
    <Page title="Library · Teams" description="Specialized team pipelines (project → user → built-in).">
      <EmptyState
        icon={<IconLibrary />}
        title="Teams"
        description="Team cards with their stage/gate/judge pipeline. Fixture: useTeams()."
      />
    </Page>
  );
}

export function LibraryRubricsPage() {
  return (
    <Page title="Library · Rubrics" description="Standard-aligned judging rubrics.">
      <EmptyState
        icon={<IconLibrary />}
        title="Rubrics"
        description="Rubric list with rendered markdown bodies. Fixtures: useRubrics(), useRubric(id)."
      />
    </Page>
  );
}

export function LibraryProfilesPage() {
  return (
    <Page title="Library · Profiles" description="Project profiles and their gate policy.">
      <EmptyState
        icon={<IconLibrary />}
        title="Profiles"
        description="Profile cards: required taxonomy, rubrics, validators. Fixtures: useProfiles(), useProfile(name)."
      />
    </Page>
  );
}

export function SystemPage() {
  return (
    <Page title="System" description="Daemon health, vendor smoke tests, and browser engines.">
      <EmptyState
        icon={<IconSystem />}
        title="System / doctor"
        description="The full doctor report: CLI versions, credentials, cross-vendor readiness. Fixture: useDoctor()."
      />
    </Page>
  );
}

export function NotFoundPage() {
  return (
    <Page title="Not found">
      <EmptyState title="404" description="No route matches this URL." />
    </Page>
  );
}
