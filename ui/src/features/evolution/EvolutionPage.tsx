import { useState } from "react";
import type { EvolutionProposal, EvolutionDecision } from "@shared/api-types";
import { Page } from "@/layout/Page";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { EmptyState } from "@/components/EmptyState";
import { StatusChip } from "@/components/StatusChip";
import { CopyButton } from "@/components/CopyButton";
import { Pill } from "@/features/common/chips";
import { cn } from "@/lib/cn";
import { useEvolutionProposals } from "@/api/queries/system";
import { useReviewProposal } from "@/api/mutations/misc";
import { ApiClientError } from "@/api/client";
import { toast } from "@/stores/uiStore";
import { formatRelative } from "@/lib/format";
import { isHighRiskRubric, confirmationPhrase, confirmationSatisfied } from "@/lib/riskRubric";

const STATUS_TONE: Record<string, "run" | "pass" | "fail" | "warn" | "dim" | "judge"> = {
  pending: "warn",
  approved: "run",
  committed: "pass",
  rejected: "fail",
  rolled_back: "dim",
};

/** Map recurrence count to a priority band. */
function signalBand(count: number): { label: string; tone: "fail" | "warn" | "dim" } {
  if (count >= 4) return { label: "P1", tone: "fail" };
  if (count >= 2) return { label: "P2", tone: "warn" };
  return { label: "P3", tone: "dim" };
}

/** Split "rubric:owasp-asvs@2" → { kind: "rubric", id: "owasp-asvs@2" }. */
function affected(rid: string): { kind: string; id: string } {
  const [kind, ...rest] = rid.split(":");
  return { kind: kind ?? "resource", id: rest.join(":") || rid };
}

const FILTERS = ["all", "pending", "approved", "committed", "rejected", "rolled_back"] as const;

const PAST_TENSE: Record<EvolutionDecision, string> = {
  approve: "approved",
  reject: "rejected",
  commit: "committed",
  rollback: "rolled back",
};

export function EvolutionPage() {
  const { data: proposals, isLoading } = useEvolutionProposals();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("all");
  const [reviewing, setReviewing] = useState<EvolutionProposal | null>(null);

  const rows = (proposals ?? []).filter((p) => filter === "all" || p.status === filter);

  return (
    <Page
      title="Evolution"
      description="Autogenesis proposals (T4) — propose → evaluate → commit, routed to TheEights."
      actions={
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as (typeof FILTERS)[number])}
          className="h-7 rounded-sm border border-line-2 bg-bg-2 px-2 text-[12px] text-ink-1 outline-none hover:border-ink-3"
        >
          {FILTERS.map((f) => (
            <option key={f} value={f}>{f.replace(/_/g, " ")}</option>
          ))}
        </select>
      }
    >
      {isLoading ? (
        <EmptyState title="Loading proposals…" compact />
      ) : rows.length === 0 ? (
        <EmptyState title="No proposals" description="Autogenesis surfaces a proposal when a drift pattern recurs across runs." />
      ) : (
        <div className="space-y-3">
          {rows.map((p) => (
            <ProposalCard key={p.id} proposal={p} onReview={() => setReviewing(p)} />
          ))}
        </div>
      )}

      <ReviewDialog proposal={reviewing} onClose={() => setReviewing(null)} />
    </Page>
  );
}

function ProposalCard({ proposal, onReview }: { proposal: EvolutionProposal; onReview: () => void }) {
  const band = signalBand(proposal.signal_count);
  const target = affected(proposal.resource_rid);
  const highRisk = isHighRiskRubric(proposal.resource_rid);

  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Pill title="affected resource">{target.kind}</Pill>
          <span className="mono text-ink-1">{target.id}</span>
          {highRisk && <Pill tone="judge" title="high-risk standards family">high-risk</Pill>}
        </span>
      }
      actions={<StatusChip tone={STATUS_TONE[proposal.status] ?? "dim"} label={proposal.status.replace(/_/g, " ")} />}
    >
      <div className="mb-2 flex items-center gap-2">
        <StatusChip tone={band.tone} label={`${band.label} · ${proposal.signal_count} signals`} />
        <span className="text-[11px] text-ink-3">risk {proposal.risk_class}</span>
        <span className="text-[11px] text-ink-3">· {formatRelative(proposal.created_at)}</span>
      </div>
      <p className="text-[13px] text-ink-1">{proposal.proposed_change}</p>
      <p className="mt-2 text-[12px] text-ink-3"><span className="text-ink-2">Evidence:</span> {proposal.justification}</p>
      {proposal.eights_proposal_id && (
        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-ink-3">
          <span className="mono">eights: {proposal.eights_proposal_id}</span>
          <CopyButton value={proposal.eights_proposal_id} title="Copy TheEights id" />
        </div>
      )}

      <div className="mt-3 flex items-center gap-2 border-t border-line-1 pt-2">
        {(proposal.status === "pending" || proposal.status === "approved" || proposal.status === "committed") ? (
          <Button size="sm" variant="primary" onClick={onReview}>Review</Button>
        ) : (
          <span className="text-[11px] text-ink-3">Closed — no actions.</span>
        )}
      </div>
    </Card>
  );
}

function ReviewDialog({ proposal, onClose }: { proposal: EvolutionProposal | null; onClose: () => void }) {
  const review = useReviewProposal();
  const [typed, setTyped] = useState("");
  const [content, setContent] = useState("");
  const [contentError, setContentError] = useState<string | null>(null);

  if (!proposal) return null;
  const highRisk = isHighRiskRubric(proposal.resource_rid);
  const phrase = confirmationPhrase(proposal.resource_rid);
  const phraseOk = confirmationSatisfied(proposal.resource_rid, typed);
  const target = affected(proposal.resource_rid);

  const close = () => {
    setTyped("");
    setContent("");
    setContentError(null);
    onClose();
  };

  const act = (decision: EvolutionDecision) => {
    setContentError(null);
    review.mutate(
      {
        id: proposal.id,
        decision,
        note: typed || undefined,
        // The server REQUIRES reviewer-authored content on commit — the
        // analyzer detects drift but authors no patch.
        content: decision === "commit" ? content || undefined : undefined,
      },
      {
        onSuccess: (u) => {
          toast({
            tone: "success",
            title: `Proposal ${PAST_TENSE[decision]}`,
            message: u.target_path ? `${u.status} → ${u.target_path}` : `${u.id} → ${u.status}`,
          });
          close();
        },
        onError: (e) => {
          if (e instanceof ApiClientError && e.status === 501) {
            toast({ tone: "error", title: "Commit unavailable", message: "daemon predates local evolution commit" });
            return;
          }
          if (e instanceof ApiClientError && e.status === 422 && decision === "commit") {
            setContentError(
              e.fieldErrors?.["content"] ??
                (e.message === "content_required"
                  ? "Reviewer-authored replacement content is required to commit."
                  : e.message),
            );
            return;
          }
          toast({ tone: "error", title: "Review failed", message: e instanceof Error ? e.message : "" });
        },
      },
    );
  };

  const options: EvolutionDecision[] =
    proposal.status === "pending" ? ["approve", "reject"] : proposal.status === "approved" ? ["commit"] : ["rollback"];
  const showCommitEditor = options.includes("commit");
  // Any mutation of a high-risk standards target — approve, commit, or
  // rollback — requires the typed confirmation phrase.
  const needsPhrase = (d: EvolutionDecision) => highRisk && d !== "reject";

  return (
    <Modal
      open={!!proposal}
      onClose={close}
      width={showCommitEditor ? 640 : 520}
      title={<span className="mono">{proposal.resource_rid}</span>}
      footer={
        <>
          <Button variant="ghost" onClick={close}>Cancel</Button>
          {options.map((d) => {
            const highRiskBlocked = needsPhrase(d) && !phraseOk;
            const blocked = review.isPending || highRiskBlocked;
            return (
              <Button
                key={d}
                variant={d === "reject" || d === "rollback" ? "danger" : "primary"}
                disabled={blocked}
                onClick={() => act(d)}
                data-testid={`review-${d}`}
                title={highRiskBlocked ? `Type "${phrase}" to confirm` : undefined}
              >
                {d}
              </Button>
            );
          })}
        </>
      }
    >
      <p className="text-[13px] text-ink-1">{proposal.proposed_change}</p>
      <p className="mt-2 text-[12px] text-ink-3">{proposal.justification}</p>

      {showCommitEditor && (
        <div className="mt-3">
          <label className="block text-[12px] text-ink-2" htmlFor="commit-content">
            Replacement content for the target override
          </label>
          <p className="mt-0.5 text-[11px] text-ink-3">
            Committing writes this body to the proposal's project override for{" "}
            <span className="mono">{target.id}</span>. The proposal's suggestion above is guidance — the
            analyzer authors no patch, so the reviewer supplies the content.
          </p>
          <textarea
            id="commit-content"
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              setContentError(null);
            }}
            data-testid="commit-content"
            rows={8}
            spellCheck={false}
            placeholder={`# ${target.id}\n\n(reviewer-authored override body)`}
            className={cn(
              "mono mt-1.5 w-full resize-y rounded-sm border bg-bg-2 px-2 py-1.5 text-[12px] leading-relaxed text-ink-1 outline-none",
              contentError ? "border-fail" : "border-line-2 focus:border-accent",
            )}
          />
          {contentError && (
            <p className="mt-1 text-[11px] text-fail" data-testid="commit-content-error">
              {contentError}
            </p>
          )}
        </div>
      )}

      {highRisk && (proposal.status === "pending" || proposal.status === "approved" || proposal.status === "committed") && (
        <div className="mt-3 rounded-md border border-[color-mix(in_srgb,var(--fail)_45%,transparent)] bg-[color-mix(in_srgb,var(--fail)_8%,transparent)] p-3">
          <p className="text-[12px] text-ink-1">
            This mutates a <span className="text-fail">high-risk</span> standards rubric. Type
            <span className="mono text-accent"> {phrase} </span> to enable{" "}
            {proposal.status === "committed" ? "rollback" : proposal.status === "approved" ? "commit" : "approval"}.
          </p>
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            data-testid="review-confirm-input"
            placeholder={phrase}
            className={cn(
              "mono mt-2 w-full rounded-sm border bg-bg-2 px-2 py-1.5 text-[12px] text-ink-1 outline-none",
              phraseOk ? "border-pass" : "border-line-2 focus:border-accent",
            )}
          />
        </div>
      )}
    </Modal>
  );
}
