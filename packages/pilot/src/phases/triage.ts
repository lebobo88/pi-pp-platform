/**
 * Phase 1 — Triage.
 *
 * Classifies the request as trivial / standard / major. The core heuristic is
 * authoritative for scope; for non-trivial requests we additionally run a
 * cheap triage completion so the engine's view is captured on the event stream
 * (and, in pi mode, so a model can flag signals the keyword heuristic misses).
 * A caller-supplied scopeOverride always wins.
 */

import { heuristicTriage } from "@pp/core";
import { loadRolePrompt, renderSystemPrompt } from "../prompts/loader.js";
import { emit, type RunContext } from "../types.js";
import type { Scope } from "@pp/core";

export async function runTriagePhase(
  ctx: RunContext,
  scopeOverride?: Scope,
): Promise<void> {
  const heuristic = heuristicTriage({ request_text: ctx.requestText });
  let scope = scopeOverride ?? heuristic.scope;
  const signals = [...heuristic.signals];

  if (!scopeOverride && scope !== "trivial") {
    // Best-effort refinement. We do not let the completion downgrade below the
    // heuristic's floor — the heuristic is the guardrail — but we record its
    // narrative on the stream for the operator.
    try {
      const role = loadRolePrompt("triage");
      const res = await ctx.engine.runAuthoringCompletion({
        model: ctx.engine.catalog.resolveTier(role.tier ?? "haiku"),
        systemPrompt: renderSystemPrompt(role, { requestText: ctx.requestText }),
        userPrompt: ctx.requestText,
        signal: ctx.signal,
      });
      signals.push(`triage-completion:${res.model}`);
    } catch {
      // Triage refinement is advisory; a failure never blocks the run.
    }
  }

  ctx.scope = scope;
  ctx.signals = signals;
  emit(ctx, "run.context", { phase: "triage", scope, signals });
}
