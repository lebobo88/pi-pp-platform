/**
 * Phase 7 — Missability.
 *
 * Runs the Section-6 missability library with the required check ids from the
 * taxonomy mapping. A failing REQUIRED check downgrades the run to "surfaced"
 * (the required_check_ids are the inspector's gating set; other triggered
 * checks are recorded but advisory). Returns true when the run may proceed to
 * finalize as complete.
 */

import { runMissabilityChecks } from "@pp/core";
import { emit, type RunContext } from "../types.js";

export function runMissabilityPhase(ctx: RunContext): { passed: boolean; failedRequired: string[] } {
  const required = ctx.missabilityRequired as Parameters<typeof runMissabilityChecks>[0]["required_check_ids"];
  const res = runMissabilityChecks({ run_id: ctx.run_id, required_check_ids: required });

  const requiredSet = new Set(ctx.missabilityRequired);
  const failedRequired = res.results
    .filter((r) => r.status === "fail" && requiredSet.has(r.check_id))
    .map((r) => r.check_id);

  for (const r of res.results) {
    emit(ctx, "missability.result", { check_id: r.check_id, status: r.status, required: requiredSet.has(r.check_id), evidence: r.evidence });
  }

  const passed = failedRequired.length === 0;
  if (!passed) ctx.finalStatus = "surfaced";
  return { passed, failedRequired };
}
