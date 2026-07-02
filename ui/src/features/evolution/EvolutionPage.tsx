import type { EvolutionProposal, EvolutionDecision } from "@shared/api-types";
import { Page } from "@/layout/Page";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { StatusChip } from "@/components/StatusChip";
import { CopyButton } from "@/components/CopyButton";
import { Pill } from "@/features/common/chips";
import { useEvolutionProposals } from "@/api/queries/system";
import { useReviewProposal } from "@/api/mutations/misc";
import { toast } from "@/stores/uiStore";
import { formatRelative } from "@/lib/format";

const STATUS_TONE: Record<string, "run" | "pass" | "fail" | "warn" | "dim" | "judge"> = {
  pending: "warn",
  approved: "run",
  committed: "pass",
  rejected: "fail",
  rolled_back: "dim",
};

const RISK_TONE: Record<string, "warn" | "fail" | "dim"> = {
  low: "dim",
  medium: "warn",
  high: "fail",
};

export function EvolutionPage() {
  const { data: proposals, isLoading } = useEvolutionProposals();

  return (
    <Page title="Evolution" description="Autogenesis proposals (T4) — propose → evaluate → commit, routed to TheEights.">
      {isLoading ? (
        <EmptyState title="Loading proposals…" compact />
      ) : (proposals ?? []).length === 0 ? (
        <EmptyState title="No proposals" description="Autogenesis surfaces a proposal when a drift pattern recurs across runs." />
      ) : (
        <div className="space-y-3">
          {(proposals ?? []).map((p) => (
            <ProposalCard key={p.id} proposal={p} />
          ))}
        </div>
      )}
    </Page>
  );
}

function ProposalCard({ proposal }: { proposal: EvolutionProposal }) {
  const review = useReviewProposal();
  const pending = proposal.status === "pending" || proposal.status === "approved";

  const act = (decision: EvolutionDecision) => {
    review.mutate(
      { id: proposal.id, decision },
      {
        onSuccess: (updated) => toast({ tone: "success", title: `Proposal ${decision}`, message: `${updated.id} → ${updated.status}` }),
        onError: (e) => toast({ tone: "error", title: "Review failed", message: e instanceof Error ? e.message : "" }),
      },
    );
  };

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <span className="mono text-ink-1">{proposal.resource_rid}</span>
          <Pill tone={RISK_TONE[proposal.risk_class] === "fail" ? "judge" : "default"} title="risk class">{proposal.risk_class}</Pill>
        </span>
      }
      actions={<StatusChip tone={STATUS_TONE[proposal.status] ?? "dim"} label={proposal.status.replace(/_/g, " ")} />}
    >
      <p className="text-[13px] text-ink-1">{proposal.proposed_change}</p>
      <p className="mt-2 text-[12px] text-ink-3">
        <span className="text-ink-2">Why:</span> {proposal.justification}
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-ink-3">
        <span className="mono">{proposal.signal_count} signals</span>
        <span>·</span>
        <span>{formatRelative(proposal.created_at)}</span>
        {proposal.eights_proposal_id && (
          <>
            <span>·</span>
            <span className="mono">eights: {proposal.eights_proposal_id}</span>
            <CopyButton value={proposal.eights_proposal_id} title="Copy TheEights proposal id" />
          </>
        )}
      </div>

      <div className="mt-3 flex items-center gap-2 border-t border-line-1 pt-2">
        {proposal.status === "pending" && (
          <>
            <Button size="sm" variant="primary" disabled={review.isPending} onClick={() => act("approve")}>Approve</Button>
            <Button size="sm" variant="danger" disabled={review.isPending} onClick={() => act("reject")}>Reject</Button>
          </>
        )}
        {proposal.status === "approved" && (
          <Button size="sm" variant="primary" disabled={review.isPending} onClick={() => act("commit")}>Commit</Button>
        )}
        {proposal.status === "committed" && (
          <Button size="sm" variant="ghost" disabled={review.isPending} onClick={() => act("rollback")}>Roll back</Button>
        )}
        {!pending && proposal.status !== "committed" && (
          <span className="text-[11px] text-ink-3">No actions available.</span>
        )}
      </div>
    </Card>
  );
}
