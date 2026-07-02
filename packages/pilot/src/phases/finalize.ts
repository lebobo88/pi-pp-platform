/**
 * Phase 9 — Finalize.
 *
 * Builds a structured summary (the "What changed" + "What's next" sections are
 * a finalize precondition — the old summary-format-check hook), calls
 * finalizeRun, then runs autogenesis (analyzeAndPropose). Returns the effective
 * status the daemon actually wrote (VG-7 may downgrade complete→surfaced).
 */

import { finalizeRun, analyzeAndPropose, type FinalizeRunOutput } from "@pp/core";
import { emit, type RunContext } from "../types.js";

export type StageReport = { kind: string; outcome: string; stage_id?: string };

/** Assemble the summary_md, enforcing the required section headers. */
export function buildSummary(ctx: RunContext, stages: StageReport[]): string {
  const changed = stages
    .filter((s) => s.outcome === "passed")
    .map((s) => `- ${s.kind}: passed`)
    .join("\n");
  const surfaced = stages.filter((s) => s.outcome !== "passed");
  const next =
    surfaced.length > 0
      ? surfaced.map((s) => `- ${s.kind}: ${s.outcome} — needs follow-up`).join("\n")
      : "- No open follow-ups; the pipeline completed cleanly.";

  return [
    `# Run ${ctx.run_id}`,
    "",
    `Request: ${ctx.requestText}`,
    "",
    "## What changed",
    "",
    changed || "- (no stages passed)",
    "",
    "## What's next",
    "",
    next,
    "",
  ].join("\n");
}

export async function runFinalizePhase(
  ctx: RunContext,
  stages: StageReport[],
): Promise<FinalizeRunOutput> {
  const status = ctx.finalStatus === "complete" ? "complete" : ctx.finalStatus === "surfaced" ? "surfaced" : "aborted";
  const summary_md = buildSummary(ctx, stages);

  const result = finalizeRun({ run_id: ctx.run_id, status, summary_md });

  if (result.downgraded) {
    ctx.finalStatus = "surfaced";
  } else {
    ctx.finalStatus = result.effective_status;
  }

  // Autogenesis: sweep for recurring drift and propose evolutions. Best-effort.
  try {
    const proposals = await analyzeAndPropose({ run_id: ctx.run_id, project_path: ctx.projectPath });
    if (proposals.length > 0) {
      emit(ctx, "run.context", { phase: "autogenesis", proposals: proposals.map((p) => p.proposal_id) });
    }
  } catch {
    // Ecosystem/autogenesis is never allowed to fail a finalize.
  }

  emit(ctx, "run.finalized", {
    status: result.effective_status,
    requested_status: result.requested_status,
    downgraded: result.downgraded,
    surfaced_stage_count: result.surfaced_stage_count,
  });

  return result;
}
