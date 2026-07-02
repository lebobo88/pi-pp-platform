/**
 * Phase 2 — Profile snapshot (with first-run bootstrap).
 *
 * Loads <project>/.harness/profile.yaml. When absent, detects a profile from
 * the project shape; on a confident match it auto-writes profile.yaml and
 * re-loads (the non-interactive high-confidence path), otherwise the run
 * proceeds in generic mode (profile = null).
 */

import {
  loadProjectProfile,
  detectProfile,
  writeProjectProfile,
  getBuiltinProfile,
} from "@pp/core";
import { emit, type RunContext } from "../types.js";

export function runProfilePhase(ctx: RunContext): void {
  let profile = loadProjectProfile(ctx.projectPath);

  if (!profile) {
    const detection = detectProfile(ctx.projectPath);
    if (detection.recommendation && (detection.confidence === "high" || detection.confidence === "medium")) {
      try {
        writeProjectProfile(ctx.projectPath, detection.recommendation, {
          source: "detected",
          runId: ctx.run_id,
          signals: detection.signals,
        });
        profile = getBuiltinProfile(detection.recommendation);
        emit(ctx, "run.context", {
          phase: "profile-bootstrap",
          wrote_profile: detection.recommendation,
          confidence: detection.confidence,
          signals: detection.signals,
        });
      } catch {
        // Bootstrap is best-effort; fall through to generic mode.
        profile = null;
      }
    }
  }

  ctx.profile = profile;
  ctx.profileName = profile?.name;
  emit(ctx, "run.context", {
    phase: "profile",
    profile: profile?.name ?? null,
    generic: profile === null,
  });
}

/** A short human-readable summary of the profile for prompt injection. */
export function profileSummary(ctx: RunContext): string | undefined {
  const p = ctx.profile;
  if (!p) return undefined;
  const bits: string[] = [`name: ${p.name}`, p.description];
  if (p.required_taxonomy_sections?.length) {
    bits.push(`required sections: ${p.required_taxonomy_sections.join(", ")}`);
  }
  if (p.model_tier_policy?.default_cap) {
    bits.push(`tier cap: ${p.model_tier_policy.default_cap}`);
  }
  return bits.filter(Boolean).join("\n");
}
