import { Page } from "@/layout/Page";
import { EmptyState } from "@/components/EmptyState";
import { IconRuns, IconEvolution } from "@/components/icons";

/**
 * Remaining route stubs. The read-only feature screens (dashboard, projects,
 * runs, budgets, library, system) are now real; these two are deferred to the
 * control-plane milestone, plus the 404 catch-all.
 */

export function NewRunPage() {
  return (
    <Page title="New run" description="Compose a request and dispatch it through the lifecycle.">
      <EmptyState
        icon={<IconRuns />}
        title="Run wizard"
        description="Request text, mode (single / best-of / team / review), profile, and tier caps. Built by the control-plane milestone."
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
        description="Propose / evaluate / commit cards routed to TheEights. Fixture: useEvolutionProposals(). Interactive review lands with the control-plane milestone."
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
