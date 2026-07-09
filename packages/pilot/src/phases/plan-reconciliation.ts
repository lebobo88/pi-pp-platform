/**
 * Plan-time reconciliation: before a team-mode plan is persisted/executed,
 * make sure every taxonomy-section / profile-declared required artifact kind
 * has a stage in the plan capable of producing it. Without this, a profile
 * like `ai-agentic` paired with a team that has no AI-controls stages (e.g.
 * `feature-team`) is structurally unable to complete — VG-2 (artifact
 * availability) will deterministically block `finalizeRun(complete)` no
 * matter how many times stages are retried.
 *
 * Augmentation only ever APPENDS stages built from existing team/agent
 * assets (no new agent family) — team yaml files stay generic baselines;
 * this is a run-time-only augmentation layer, and does not mutate
 * `profile_snapshot_json` / `taxonomy_mapping_json` (Step 3 snapshot
 * consistency).
 */

import { getTeam, type TeamStage, type ClaudeTier } from "@pp/core";
import { resolveArtifactKind } from "./stage-loop.js";
import type { RunContext, StageSpec } from "../types.js";

const AI_CONTROLS_TEAM_NAME = "ai-controls-team";

/** Same mapping `run-pilot.ts`'s `teamStages()` uses — kept local to avoid a
 * pilot-internal cycle (run-pilot.ts imports this module). */
function stageSpecFromTeamStage(s: TeamStage): StageSpec {
  return {
    kind: s.kind,
    gate_type: s.gate_type,
    agent: s.generator.agent,
    artifact_kind: s.artifact_kind,
    teamStageModelTier: s.generator.model_tier as ClaudeTier | undefined,
    rubricHint: s.judge?.rubric,
    judgeModelPref: s.judge?.model_pref,
    skills: s.skills,
  };
}

export type PlanReconciliationResult =
  | { abort: false; stages: StageSpec[] }
  | { abort: true; reason: string };

/**
 * Reconcile `stages` (the resolved team plan) against `ctx.sections` +
 * `ctx.profile`'s required taxonomy sections / artifact kinds. Returns an
 * augmented stage list, or an abort result when a required artifact kind has
 * no producing stage available anywhere in the asset library even after
 * augmentation (a genuinely impossible requirement — surfaced at plan-build
 * time instead of failing VG-2 hours into the run).
 */
export function reconcilePlanWithRequirements(
  ctx: RunContext,
  stages: StageSpec[],
): PlanReconciliationResult {
  const requiredSections = new Set<string>([
    ...ctx.sections.map((s) => s.id),
    ...(ctx.profile?.required_taxonomy_sections ?? []),
  ]);
  const requiredKinds = new Set<string>([
    ...ctx.sections.flatMap((s) => s.required_artifacts),
    ...(ctx.profile?.required_artifacts ?? []),
  ]);
  // Kinds required by the *profile* only (an explicit, deliberate opt-in —
  // 14 built-in profiles total). Used below to scope the abort check.
  // Heuristic-only required kinds (e.g. "4.8"'s near-universal "diff", added
  // to almost every non-trivial request regardless of team, or any other
  // taxonomy-section default whose team simply doesn't cover that section)
  // are NOT abort triggers: they were never gated at plan-build time before
  // this change — VG-2 already enforces them (softly, at finalize) for
  // every standard/major run, and a huge fraction of legitimate non-coding
  // team runs (discovery/strategy/docs/ux/governance/retirement/...) would
  // otherwise abort immediately with zero stages executed just because the
  // heuristic mapper guessed a section from a stray keyword. Only a
  // profile's explicit required_artifacts are specific/rare/deliberate
  // enough to justify a hard plan-build abort.
  const profileRequiredKinds = new Set<string>(ctx.profile?.required_artifacts ?? []);

  // Fast path: nothing required beyond what a plan carries unconditionally.
  if (requiredKinds.size === 0 && !requiredSections.has("4.13")) {
    return { abort: false, stages };
  }

  const augmented = [...stages];

  const producedKinds = () => new Set<string>(
    augmented.flatMap((s) => (s.kind === "code" ? [resolveArtifactKind(s), "diff"] : [resolveArtifactKind(s)])),
  );

  // ── 4.13 (docs/appendices) coverage ───────────────────────────────────────
  if (requiredSections.has("4.13") && !augmented.some((s) => s.kind === "docs")) {
    augmented.push({ kind: "docs", gate_type: "docs_polish", agent: "docs-author" });
  }

  // ── 4.15 (AI system spec / agentic controls) coverage ─────────────────────
  const missingAfterDocs = [...requiredKinds].filter((k) => !producedKinds().has(k));
  if (missingAfterDocs.length > 0) {
    const found = getTeam({ name: AI_CONTROLS_TEAM_NAME, project_path: ctx.projectPath });
    if (found) {
      for (const teamStage of found.team.stages) {
        const kind = resolveArtifactKind({ kind: teamStage.kind, artifact_kind: teamStage.artifact_kind });
        if (missingAfterDocs.includes(kind) && !producedKinds().has(kind)) {
          augmented.push(stageSpecFromTeamStage(teamStage));
        }
      }
    }
  }

  // ── Final check: anything the PROFILE explicitly requires that is still
  // uncovered is a genuinely impossible requirement — abort rather than
  // start a run that VG-2 will deterministically fail later. Scoped to
  // profile-declared kinds only; see profileRequiredKinds above.
  const stillMissing = [...profileRequiredKinds].filter((k) => !producedKinds().has(k));
  if (stillMissing.length > 0) {
    return {
      abort: true,
      reason:
        `required artifact kind(s) [${stillMissing.join(", ")}] have no producing stage in the ` +
        `resolved plan (team="${ctx.teamName ?? "n/a"}", profile="${ctx.profileName ?? "n/a"}"), even ` +
        `after docs/AI-controls augmentation. This request cannot reach 'complete' as configured — ` +
        `choose a different team, drop the requirement from the profile, or add a stage that produces it.`,
    };
  }

  return { abort: false, stages: augmented };
}
