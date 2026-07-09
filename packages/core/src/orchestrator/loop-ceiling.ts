/**
 * Anti-runaway loop ceiling. Counts validator (verdict) calls per run and
 * blocks new ones beyond the configured ceiling. Distinct from cost
 * tracking (which is logged-not-enforced) — this prevents broken-rubric
 * loops from burning through token budgets. Default 6 per run.
 *
 * Override: pass `override=true` to retry_with_critique (the user can do this
 * via /pp:retry --budget-override).
 */

import { db } from "../db/database.js";
import { DEFAULT_LOOP_CEILING } from "../config.js";

export function loopCeilingStatus(run_id: string): {
  run_id: string;
  validator_calls: number;
  ceiling: number;
  remaining: number;
  blocked: boolean;
} {
  const row = db()
    .prepare(
      `SELECT COUNT(*) AS c FROM verdicts v
       JOIN attempts a ON a.id = v.attempt_id
       JOIN stages   s ON s.id = a.stage_id
       WHERE s.run_id = ?`
    )
    .get(run_id) as { c: number };

  const ceiling = DEFAULT_LOOP_CEILING;
  const validator_calls = row?.c ?? 0;
  const remaining = Math.max(0, ceiling - validator_calls);
  return {
    run_id,
    validator_calls,
    ceiling,
    remaining,
    blocked: validator_calls >= ceiling,
  };
}

/** Reflexion ×1 invariant + loop-ceiling check, in one place. */
export function checkRetryEligible(opts: {
  attempt_id: string;
  budget_override?: boolean;
  /**
   * Set true ONLY by the automatic Reflexion path (`stage-loop.ts`'s
   * automatic retry, not the manual `retryStage` post-hoc helper). When
   * true, the run-wide loop ceiling is NOT enforced — only the Reflexion ×1
   * invariant (`retry_index >= 1`) applies. This keeps the run-wide loop
   * ceiling from silently consuming the one automatic retry every stage is
   * entitled to (early-stage judge calls could otherwise exhaust the
   * ceiling before a later stage ever gets its automatic Reflexion pass).
   * The manual/operator retry route and the MCP `retry_with_critique` tool
   * MUST leave this unset/false — they keep the ceiling (with
   * `budget_override` as the deliberate, audited bypass) as an
   * operator-visible safety valve. Automatic call-count safety is instead
   * provided by the Reflexion ×1 invariant itself (at most one automatic
   * retry per stage); run-wide dollar-cost safety remains the budget
   * tripwires in RunSupervisor, which already include judge/verdict spend
   * (tallyJudgeUsage credits verdict cost to the same `run:<run_id>` scope
   * the tripwire reads).
   */
  automatic?: boolean;
}): { ok: true; parent_attempt_id: string } | { ok: false; reason: string } {
  const att = db()
    .prepare(`SELECT id, stage_id, retry_index, parent_attempt_id FROM attempts WHERE id = ?`)
    .get(opts.attempt_id) as
    | { id: string; stage_id: string; retry_index: number; parent_attempt_id: string | null }
    | undefined;
  if (!att) return { ok: false, reason: `attempt ${opts.attempt_id} not found` };

  // The Reflexion ×1 invariant binds the AUTOMATIC retry path. budget_override
  // is the operator's deliberate, audited bypass (the run-control retry
  // endpoint logs it) — it unlocks BOTH this check and the loop ceiling below.
  if (att.retry_index >= 1 && !opts.budget_override) {
    return { ok: false, reason: `Reflexion ×1 invariant: this attempt is already a retry (retry_index=${att.retry_index}). Pass budget_override=true (operator override) to force.` };
  }

  const stage = db()
    .prepare(`SELECT run_id FROM stages WHERE id = ?`)
    .get(att.stage_id) as { run_id: string } | undefined;
  if (!stage) return { ok: false, reason: `stage ${att.stage_id} not found` };

  // The run-wide loop ceiling only gates the MANUAL/operator retry path (and
  // the MCP retry_with_critique tool). The automatic Reflexion path is
  // exempt — see the `automatic` param doc above.
  if (!opts.budget_override && !opts.automatic) {
    const ceiling = loopCeilingStatus(stage.run_id);
    if (ceiling.blocked) {
      return {
        ok: false,
        reason: `loop ceiling reached: ${ceiling.validator_calls}/${ceiling.ceiling} validator calls in this run. Pass budget_override=true to force.`,
      };
    }
  }

  return { ok: true, parent_attempt_id: opts.attempt_id };
}
