/**
 * Phase 4 — Taxonomy mapping.
 *
 * Maps the request to the taxonomy sections + required artifacts + missability
 * check ids via the core heuristic, refines non-trivial requests with a mapper
 * completion (advisory), and persists the mapping on the run row.
 */

import { heuristicMapping, recordTaxonomyMapping } from "@pp/core";
import { loadRolePrompt, renderSystemPrompt } from "../prompts/loader.js";
import { emit, type RunContext } from "../types.js";

export async function runTaxonomyPhase(ctx: RunContext): Promise<void> {
  const mapping = heuristicMapping({ request_text: ctx.requestText, scope: ctx.scope });

  if (ctx.scope !== "trivial") {
    try {
      const role = loadRolePrompt("taxonomy-mapper");
      await ctx.engine.runAuthoringCompletion({
        model: ctx.engine.catalog.resolveTier(role.tier ?? "haiku"),
        systemPrompt: renderSystemPrompt(role, { requestText: ctx.requestText }),
        userPrompt: ctx.requestText,
        signal: ctx.signal,
      });
    } catch {
      // Advisory only; the heuristic mapping stands.
    }
  }

  ctx.sections = mapping.sections;
  ctx.missabilityRequired = mapping.missability_required;

  recordTaxonomyMapping({
    run_id: ctx.run_id,
    scope: mapping.scope,
    signals: mapping.signals,
    sections: mapping.sections,
    missability_required: mapping.missability_required,
  });

  emit(ctx, "run.context", {
    phase: "taxonomy",
    sections: mapping.sections.map((s) => s.id),
    missability_required: mapping.missability_required,
  });
}
