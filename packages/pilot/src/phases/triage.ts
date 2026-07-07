/**
 * Phase 1 — Triage.
 *
 * Classifies the request as trivial / standard / major. The core heuristic is
 * authoritative for scope; for non-trivial requests we additionally run a
 * cheap triage completion so the engine's view is captured on the event stream
 * (and, in pi mode, so a model can flag signals the keyword heuristic misses).
 * A caller-supplied scopeOverride always wins.
 */

import {
  boundRefinedScope,
  heuristicTriage,
  isProjectNearEmpty,
  parseScopeSuggestion,
} from "@pp/core";
import { loadRolePrompt, renderSystemPrompt } from "../prompts/loader.js";
import { emit, type RunContext } from "../types.js";
import type { Scope } from "@pp/core";

export async function runTriagePhase(
  ctx: RunContext,
  scopeOverride?: Scope,
): Promise<void> {
  const near_empty_dir = isProjectNearEmpty(ctx.projectPath);
  const heuristic = heuristicTriage({ request_text: ctx.requestText, near_empty_dir });
  let scope = scopeOverride ?? heuristic.scope;
  const signals = [...heuristic.signals];

  if (!scopeOverride && scope !== "trivial") {
    // Bounded refinement: the haiku completion may nudge the scope one rung up
    // or down from the heuristic anchor, but never below the greenfield floor.
    // On any failure or unparseable answer the heuristic scope stands.
    try {
      const role = loadRolePrompt("triage", { projectPath: ctx.projectPath });
      const res = await ctx.engine.runAuthoringCompletion({
        model: ctx.engine.catalog.resolveTier(role.tier ?? "haiku"),
        systemPrompt: renderSystemPrompt(role, { requestText: ctx.requestText }),
        userPrompt: ctx.requestText,
        signal: ctx.signal,
      });
      signals.push(`triage-completion:${res.model}`);
      const suggested = parseScopeSuggestion(res.text ?? "");
      if (suggested) {
        const refined = boundRefinedScope(heuristic.scope, suggested, heuristic.floor);
        if (refined !== scope) {
          signals.push(`triage-refined:${scope}->${refined} (±1, floor=${heuristic.floor})`);
          scope = refined;
        }
      }
    } catch {
      // Triage refinement is advisory; a failure never blocks the run.
    }
  }

  ctx.scope = scope;
  ctx.signals = signals;
  emit(ctx, "run.context", { phase: "triage", scope, signals });
}
