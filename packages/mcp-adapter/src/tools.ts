/**
 * pp_harness tool registry — the MCP-facing surface, ported faithfully from the
 * pair-programmer daemon's harness-server.ts but delegating to @pp/core.
 *
 * Each tool is tagged `full` or `stub`:
 *   - full: delegates to a @pp/core function (read/record/compute). Works fully.
 *   - stub: the implementation lives in the driver / engine / pilot / ecosystem
 *     (anything that STARTS generation or critique, mutates best-of-N worktrees,
 *     or requires a live ecosystem peer). Registered so `listTools` stays
 *     compatible, but the handler returns {error:"not_available_in_adapter", hint}.
 */
import { z } from "zod";
import {
  // runs
  startRun, ensureRun, startStage, recordAttempt, recordVerdict, retractVerdict,
  finalizeStage, finalizeRun, archiveArtifact, listRuns, getRun, budgetStatus, doctor,
  recordTaxonomyMapping, getStageFinalizeReadiness,
  // gates
  evaluateGate, listAllowedJudges, type GateType, type Profile,
  // taxonomy
  heuristicTriage, heuristicMapping, TAXONOMY_SECTIONS, COMPLETION_CHECKLIST,
  // master plan
  applyMasterPlanPatch, masterPlanStatus, ensureMasterPlan,
  // agents.md
  applyAgentsMdPatch, agentsMdStatus, ensureAgentsMd, ensureAgentsAndClaudeMd, AGENTS_MD_SECTIONS,
  // missability
  runMissabilityChecks, CHECK_DEFINITIONS, type CheckId,
  // best-of-n (pure compute + record only; worktree ops are stubbed)
  diffEntropy, bordaCount, recordSmokeStatus,
  // tdd
  runTddCheck, getLatestTddCheck,
  // artifact validators
  runArtifactValidator, getLatestArtifactValidation, VALIDATOR_KINDS,
  // profiles
  loadProjectProfile, getBuiltinProfile, listBuiltinProfiles, writeProjectProfile,
  BUILTIN_PROFILES, BUILTIN_PROFILE_NAMES, type ProfileName,
  // teams / forums / templates
  getTeam, listTeams, listForums, getForum, getDesignTemplate, TEMPLATES_BY_KIND,
  // agents library / skills / team recommendation
  listAgents, getAgent, listSkills, getSkill, recommendTeams,
  // constitution
  ensureConstitution, readConstitution, forbiddenPatterns,
  // replay / janitor / rubrics
  buildReplayBundle, runJanitor, getRubric, listRubrics,
  // loop ceiling / profile detect / lock (added to core barrel for M7a)
  loopCeilingStatus, checkRetryEligible, detectProfile, forceUnlock,
  // config
  RUN_MODE, STAGE_STATUS, ATTEMPT_STATUS, VERDICT_OUTCOME, RUN_STATUS,
  CLAUDE_TIER_MODELS, COPILOT_CLAUDE_TIER_MODELS, TIER_ORDER,
} from "@pp/core";

// ─── Structured "not available in adapter" result ────────────────────────────

function notAvailable(hint: string) {
  return { error: "not_available_in_adapter" as const, hint };
}

// ─── Input schemas (ported from harness-server.ts) ───────────────────────────

const StartRunSchema = z.object({
  request_text: z.string().min(1),
  project_path: z.string().min(1),
  mode: z.enum(RUN_MODE),
  team: z.string().optional(),
  forum: z.string().optional(),
  n: z.number().int().min(1).max(8).optional(),
  session_id: z.string().optional(),
  hydra_workflow_id: z.string().optional(),
  hydra_envelope_id: z.string().optional(),
  hydra_origin_squad: z.string().optional(),
  hydra_envelope_type: z.string().optional(),
});

const EnsureRunSchema = z.object({
  project_path: z.string().min(1),
  request_text: z.string().min(1),
  kind: z.string().min(1).optional(),
});

const ForceUnlockSchema = z.object({ project_path: z.string().min(1) });

const StartStageSchema = z.object({
  run_id: z.string().min(1),
  kind: z.string().min(1),
  gate_type: z.string().min(1),
});

const AttemptNotesSchema = z.object({
  findings_closed: z.array(z.object({
    id: z.string().min(1), file: z.string().min(1), lines: z.string().min(1), claim: z.string().min(1),
  })).optional(),
  findings_unaddressed: z.array(z.object({ id: z.string().min(1), reason: z.string().min(1) })).optional(),
  anti_pattern_hits: z.array(z.object({
    file: z.string().min(1), line: z.number().int().nonnegative(), pattern: z.string().min(1),
  })).optional(),
  touched_hashes_path: z.string().optional(),
  candidate_index: z.number().int().optional(),
}).strict();

const RecordAttemptSchema = z.object({
  stage_id: z.string().min(1),
  producer: z.string().min(1),
  model_id: z.string().min(1),
  prompt_hash: z.string().optional(),
  artifact_path: z.string().optional(),
  tokens_in: z.number().int().nonnegative().optional(),
  tokens_out: z.number().int().nonnegative().optional(),
  cost_usd: z.number().nonnegative().optional(),
  wall_ms: z.number().int().nonnegative().optional(),
  retry_index: z.number().int().min(0).max(2).optional(),
  parent_attempt_id: z.string().optional(),
  status: z.enum(ATTEMPT_STATUS).optional(),
  attempt_slot_id: z.string().optional(),
  attempted_tier: z.enum(["opus", "sonnet", "haiku"]).optional(),
  notes: AttemptNotesSchema.optional(),
  agent_type: z.string().min(1).optional(),
});

const RetractVerdictSchema = z.object({
  verdict_id: z.string().min(1),
  reason: z.string().min(8),
  superseded_by: z.string().optional(),
});

const RecordVerdictSchema = z.object({
  attempt_id: z.string().min(1),
  judge_producer: z.string().min(1),
  judge_model_id: z.string().min(1),
  rubric_id: z.string().optional(),
  outcome: z.enum(VERDICT_OUTCOME),
  critique_md: z.string().optional(),
  score_json: z.union([
    z.record(z.string(), z.unknown()),
    z.string().transform((s) => { try { return JSON.parse(s); } catch { return {}; } }),
  ]).optional(),
})
  .refine(
    v => v.outcome !== "pass" || (typeof v.critique_md === "string" && v.critique_md.trim().length >= 80),
    { message: "outcome=pass requires critique_md of at least 80 non-whitespace chars (anti-vacuous-pass guard)" },
  )
  .refine(
    v => {
      if (v.outcome !== "pass") return true;
      const s = v.score_json;
      return !!s && typeof s === "object" && !Array.isArray(s) && Object.keys(s as Record<string, unknown>).length > 0;
    },
    { message: "outcome=pass requires non-empty score_json with at least one rubric dimension (anti-vacuous-pass guard)" },
  );

const FinalizeStageSchema = z.object({
  stage_id: z.string().min(1),
  status: z.enum(STAGE_STATUS),
  winner_attempt_id: z.string().optional(),
});

const GetStageFinalizeReadinessSchema = z.object({ stage_id: z.string().min(1) });

const FinalizeRunSchema = z.object({
  run_id: z.string().min(1),
  status: z.enum(["complete", "surfaced", "aborted"] as const),
  summary_md: z.string().optional(),
});

const ArchiveArtifactSchema = z.object({
  run_id: z.string().min(1),
  stage_id: z.string().optional(),
  taxonomy_section: z.string().optional(),
  kind: z.string().optional(),
  relative_path: z.string().min(1),
  bytes: z.string(),
  encoding: z.enum(["utf8", "base64"] as const).optional(),
  force_overwrite: z.boolean().optional(),
  evidence_ref: z.string().optional(),
});

const ListRunsSchema = z.object({
  project_path: z.string().optional(),
  status: z.enum(RUN_STATUS).optional(),
  limit: z.number().int().min(1).max(500).optional(),
  cursor: z.string().optional(),
});

const GetRunSchema = z.object({ run_id: z.string().min(1) });
const BudgetStatusSchema = z.object({ scope: z.string().optional() });

const ListPriorCritiquesSchema = z.object({
  stage_kind: z.string().min(1),
  project_path: z.string().min(1),
  k: z.number().int().min(1).max(20).optional(),
});

const AuditStatusSchema = z.object({ run_id: z.string().min(1) });

const RequestStrategicFramingSchema = z.object({
  run_id: z.string().min(1),
  project_path: z.string().min(1),
  request_text: z.string().min(1),
  profile: z.string().optional(),
});
const RequestBrandReviewSchema = z.object({
  run_id: z.string().min(1),
  project_path: z.string().min(1),
  surface_description: z.string().min(1),
  copy_excerpt: z.string().min(1),
});
const RequestVisualAdvisorySchema = z.object({
  run_id: z.string().min(1),
  project_path: z.string().min(1),
  surface_description: z.string().min(1),
  layout_excerpt: z.string().min(1),
});
const ReportHydraCompletionSchema = z.object({ run_id: z.string().min(1) });
const HydraEnvelopeQuerySchema = z.object({ workflow_id: z.string().min(1) });

const ListEvolutionProposalsSchema = z.object({
  project_path: z.string().min(1),
  status: z.enum(["pending", "approved", "rejected", "committed", "rolled_back"]).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});
const ReviewEvolutionProposalSchema = z.object({
  proposal_id: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
});
const AnalyzeAutogenesisSchema = z.object({
  run_id: z.string().min(1),
  project_path: z.string().min(1),
});

const GATE_TYPES = ["spec", "design", "security", "contract", "code_style", "docs_polish", "lint_class"] as const;
const GateEligibleJudgesSchema = z.object({
  gate_type: z.enum(GATE_TYPES),
  generator_producer: z.string().min(1),
  generator_model: z.string().min(1).optional(),
  prompt_keywords: z.string().optional(),
  profile: z.enum(BUILTIN_PROFILE_NAMES as unknown as [string, ...string[]]).optional(),
  artifact_kind: z.string().optional(),
  rubric_hint: z.string().min(1).optional(),
});

const TriageRequestSchema = z.object({
  request_text: z.string().min(1),
  diff_loc: z.number().int().nonnegative().optional(),
  files_touched: z.number().int().nonnegative().optional(),
});
const TaxonomyMapRequestSchema = TriageRequestSchema.extend({
  scope: z.enum(["trivial", "standard", "major"]).optional(),
});
const RecordTaxonomyMappingSchema = z.object({
  run_id: z.string().min(1),
  scope: z.enum(["trivial", "standard", "major"]),
  signals: z.array(z.string()),
  sections: z.array(z.object({
    id: z.string(), title: z.string(), rationale: z.string(),
    required_artifacts: z.array(z.string()),
  })),
  missability_required: z.array(z.string()),
});

const MasterPlanPatchSchema = z.object({
  run_id: z.string().min(1),
  project_path: z.string().min(1),
  section: z.string().min(1),
  kind: z.enum(["create", "update", "append"]),
  content_md: z.string().min(1),
});
const MasterPlanStatusSchema = z.object({ project_path: z.string().min(1) });
const EnsureMasterPlanSchema = z.object({ project_path: z.string().min(1) });
const EnsureConstitutionSchema = z.object({ project_path: z.string().min(1) });
const ConstitutionStatusSchema = z.object({ project_path: z.string().min(1) });

const AgentsMdPatchSchema = z.object({
  run_id: z.string().min(1),
  project_path: z.string().min(1),
  section: z.enum(AGENTS_MD_SECTIONS as unknown as [string, ...string[]]),
  kind: z.enum(["create", "update", "append"]),
  content_md: z.string().min(1),
});
const AgentsMdStatusSchema = z.object({ project_path: z.string().min(1) });
const EnsureAgentsMdSchema = z.object({
  project_path: z.string().min(1),
  profile: z.string().optional(),
  conventions: z.array(z.string()).optional(),
  build_commands: z.array(z.string()).optional(),
  extra_sections: z.array(z.object({ heading: z.string(), body: z.string() })).optional(),
  also_claude_md: z.boolean().optional(),
});
const EmptySchema = z.object({});

const RunMissabilitySchema = z.object({
  run_id: z.string().min(1),
  required_check_ids: z.array(z.string()).optional(),
});
const LoopCeilingSchema = z.object({ run_id: z.string().min(1) });
const RetryWithCritiqueSchema = z.object({
  attempt_id: z.string().min(1),
  critique_md: z.string().min(1),
  budget_override: z.boolean().optional(),
});

const StartBestOfStageSchema = z.object({
  run_id: z.string().min(1),
  kind: z.string().min(1),
  gate_type: z.string().min(1),
  n: z.number().int().min(2).max(8),
});
const DiffEntropySchema = z.object({ candidate_texts: z.array(z.string()).min(2) });
const BordaSchema = z.object({
  candidate_ids: z.array(z.string()).min(2),
  rankings: z.array(z.array(z.string())).min(1),
});
const RecordSmokeStatusSchema = z.object({
  stage_id: z.string().min(1),
  candidate_index: z.number().int().min(1).max(8),
  status: z.enum(["pass", "fail", "infra_error", "skipped"]),
  reason: z.string().optional(),
});

const TddPreCheckSchema = z.object({ stage_id: z.string().min(1) });
const TddPostCheckSchema = z.object({ stage_id: z.string().min(1) });
const GetTddCheckSchema = z.object({ stage_id: z.string().min(1), phase: z.enum(["pre", "post"]) });

const ArtifactValidateSchema = z.object({
  stage_id: z.string().min(1),
  kind: z.enum(VALIDATOR_KINDS),
  artifact_path: z.string().optional(),
});
const GetArtifactValidationSchema = z.object({
  stage_id: z.string().min(1),
  validator_kind: z.enum(VALIDATOR_KINDS),
  artifact_id: z.string().optional(),
});

const ArchiveWinnerSchema = z.object({
  run_id: z.string().min(1),
  stage_id: z.string().min(1),
  stage_kind: z.string().min(1),
  winner_candidate_index: z.number().int().min(1),
  candidate_paths: z.array(z.string()).min(1),
});
const TeardownCandidatesSchema = z.object({
  project_path: z.string().min(1),
  candidate_paths: z.array(z.string()).min(1),
  run_id: z.string().min(1),
  stage_kind: z.string().min(1),
  allow_data_loss: z.boolean().optional(),
});

const GetProfileSchema = z.object({ project_path: z.string().min(1) });
const GetBuiltinProfileSchema = z.object({ name: z.enum(BUILTIN_PROFILE_NAMES as unknown as [string, ...string[]]) });
const GetRubricSchema = z.object({ id: z.string().min(1) });
const DetectProfileSchema = z.object({ project_path: z.string().min(1) });
const WriteProfileSchema = z.object({
  project_path: z.string().min(1),
  name: z.enum(BUILTIN_PROFILE_NAMES as unknown as [string, ...string[]]),
  source: z.enum(["detected", "user-selected"]),
  run_id: z.string().optional(),
  signals: z.array(z.string()).optional(),
});
const GetTeamSchema = z.object({ name: z.string().min(1), project_path: z.string().min(1) });
const ListTeamsSchema = z.object({ project_path: z.string().min(1) });
const ListAgentsSchema = z.object({ project_path: z.string().optional() });
const GetAgentSchema = z.object({ id: z.string().min(1), project_path: z.string().optional() });
const ListSkillsSchema = z.object({ project_path: z.string().optional() });
const GetSkillSchema = z.object({ id: z.string().min(1), project_path: z.string().optional() });
const RecommendTeamSchema = z.object({
  request_text: z.string().min(1),
  project_path: z.string().optional(),
  profile: z.string().optional(),
  scope: z.enum(["trivial", "standard", "major"]).optional(),
});
const JanitorSchema = z.object({ dry_run: z.boolean().optional() });
const GetDesignTemplateSchema = z.object({ kind: z.string().min(1) });
const GetForumSchema = z.object({ id: z.string().min(1) });
const ReplaySchema = z.object({ run_id: z.string().min(1) });

const VisualRegressionCaptureSchema = z.object({
  run_id: z.string().min(1),
  phase: z.enum(["before", "after"]),
  urls: z.array(z.string().min(1)).min(1),
  base_url: z.string().optional(),
  viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  full_page: z.boolean().optional(),
});
const VisualRegressionDiffSchema = z.object({ run_id: z.string().min(1) });
const BrowserValidationStartSchema = z.object({
  run_id: z.string().min(1),
  base_url: z.string().optional(),
  routes: z.array(z.string().min(1)).min(1),
});
const BrowserValidationFinalizeSchema = z.object({
  run_id: z.string().min(1),
  stage_id: z.string().min(1),
  engine: z.enum(["chrome-mcp", "playwright"]),
  base_url: z.string().optional(),
  gif_path: z.string().optional(),
  engine_status: z.enum(["ran", "unavailable"]).default("ran"),
  unavailable_reason: z.string().optional(),
  findings: z.array(z.object({
    route: z.string(),
    step: z.string(),
    status: z.enum(["pass", "warn", "fail"]),
    console_errors: z.array(z.string()).default([]),
    network_errors: z.array(z.object({ url: z.string(), status: z.number().int() })).default([]),
    screenshot_path: z.string().optional(),
    expected_statuses: z.array(z.number().int().min(400).max(599)).optional(),
  })).default([]),
});

// ─── Tool registry ───────────────────────────────────────────────────────────

export type ToolAvailability = "full" | "stub";
export type ToolDef = {
  name: string;
  description: string;
  schema: z.ZodTypeAny;
  availability: ToolAvailability;
  handler: (args: unknown) => Promise<unknown> | unknown;
};

/** Build a stub tool that advertises the real schema but is not runnable here. */
function stub(name: string, description: string, schema: z.ZodTypeAny, hint: string): ToolDef {
  return { name, description, schema, availability: "stub", handler: () => notAvailable(hint) };
}

const ECOSYSTEM_HINT =
  "This tool talks to the Hydra/TheEights ecosystem peer and is served by the running platform, not the stateless MCP adapter. Use the platform API.";
const PILOT_HINT =
  "This tool drives best-of-N worktree/generation orchestration owned by the run pilot. Use the platform API.";
const BROWSER_HINT =
  "This tool launches a browser/visual-capture engine owned by the platform's validator agents. Use the platform API.";

export const TOOLS: ToolDef[] = [
  // ── Run lifecycle (full) ──
  { name: "start_run", availability: "full",
    description: "Allocate a run row in the harness DB and create the per-run artifact directory. Returns run_id and absolute artifact_dir path.",
    schema: StartRunSchema, handler: (a) => startRun(StartRunSchema.parse(a)) },
  { name: "force_unlock", availability: "full",
    description: "Operator-only: force-release a stranded per-project advisory lock at <project>/.harness/.lock after validating the holder PID is dead. Returns {released, was_stale, holder?}.",
    schema: ForceUnlockSchema, handler: (a) => forceUnlock(ForceUnlockSchema.parse(a).project_path) },
  { name: "ensure_run", availability: "full",
    description: "Idempotent run-context bootstrap for Hydra-style dispatchers. Returns {run_id, created}. Reuses an open run on the same project_path+kind or allocates a new 'single'-mode run.",
    schema: EnsureRunSchema, handler: (a) => ensureRun(EnsureRunSchema.parse(a)) },
  { name: "start_stage", availability: "full",
    description: "Open a stage row inside an active run. gate_type drives the validator policy.",
    schema: StartStageSchema, handler: (a) => startStage(StartStageSchema.parse(a)) },
  { name: "record_attempt", availability: "full",
    description: "Log a generation attempt against an open stage. Pass tokens_in/out and cost_usd for budget tallying; retry_index>=1 with parent_attempt_id for Reflexion retries.",
    schema: RecordAttemptSchema, handler: (a) => recordAttempt(RecordAttemptSchema.parse(a)) },
  { name: "record_verdict", availability: "full",
    description: "Log a judge verdict against an attempt. cross_vendor is computed from judge_producer vs the attempt's producer. outcome is pass|fail|revise.",
    schema: RecordVerdictSchema, handler: (a) => recordVerdict(RecordVerdictSchema.parse(a)) },
  { name: "retract_verdict", availability: "full",
    description: "Mark a prior verdict as retracted (cross-vendor false positive / judge hallucination / operator override). The row stays for audit; downstream gates skip retracted rows.",
    schema: RetractVerdictSchema, handler: (a) => retractVerdict(RetractVerdictSchema.parse(a)) },
  { name: "get_stage_finalize_readiness", availability: "full",
    description: "Read-only preflight for finalize_stage(status='passed'). Returns {can_pass, recommended_status, next_action, blockers[]}.",
    schema: GetStageFinalizeReadinessSchema, handler: (a) => getStageFinalizeReadiness(GetStageFinalizeReadinessSchema.parse(a).stage_id) },
  { name: "finalize_stage", availability: "full",
    description: "Close a stage row with status passed|surfaced|skipped. winner_attempt_id is required when status=passed.",
    schema: FinalizeStageSchema, handler: (a) => finalizeStage(FinalizeStageSchema.parse(a)) },
  { name: "finalize_run", availability: "full",
    description: "Close a run with status complete|surfaced|aborted; optionally writes run.summary.md. Returns {effective_status, requested_status, downgraded, surfaced_stage_count}.",
    schema: FinalizeRunSchema, handler: (a) => finalizeRun(FinalizeRunSchema.parse(a)) },
  { name: "archive_artifact", availability: "full",
    description: "Write artifact bytes under <project>/.harness/<run_id>/ and register it. Bytes are secret-scanned before writing; supports base64 encoding and manual-edit detection.",
    schema: ArchiveArtifactSchema, handler: (a) => archiveArtifact(ArchiveArtifactSchema.parse(a)) },
  { name: "list_runs", availability: "full",
    description: "List recent runs, optionally filtered by project_path and/or status. Returns up to `limit` rows (default 50). Pass `cursor` (base64url of \"<started_at>|<id>\" of the last row seen) to page past a previous listing.",
    schema: ListRunsSchema, handler: (a) => listRuns(ListRunsSchema.parse(a)).items },
  { name: "get_run", availability: "full",
    description: "Return the full tree for a run: run row, all stages, attempts, verdicts, and artifacts.",
    schema: GetRunSchema, handler: (a) => getRun(GetRunSchema.parse(a).run_id) },

  // ── Ecosystem / Hydra (stub) ──
  stub("list_prior_critiques", "Cross-run reflexion lookup from TheEights episodic memory (up to k prior critiques on the same stage_kind).", ListPriorCritiquesSchema, ECOSYSTEM_HINT),
  stub("request_strategic_framing", "Emit a CSuiteDecisionPacket envelope to the executive squad for strategic framing.", RequestStrategicFramingSchema, ECOSYSTEM_HINT),
  stub("request_brand_review", "Emit a CreativeBrief (brand-voice-check) to the marketing-strategy squad.", RequestBrandReviewSchema, ECOSYSTEM_HINT),
  stub("request_visual_advisory", "Emit a CreativeBrief (visual-direction-advisory) to the creative squad.", RequestVisualAdvisorySchema, ECOSYSTEM_HINT),
  stub("report_hydra_completion", "Emit a DECISION_RECORD envelope for a finalized Hydra-invoked run.", ReportHydraCompletionSchema, ECOSYSTEM_HINT),
  stub("hydra_envelope_query", "Read envelopes Hydra/other squads wrote into TheEights' envelope store for a workflow_id.", HydraEnvelopeQuerySchema, ECOSYSTEM_HINT),
  stub("audit_status", "Query the audit-chain state for a past run (verify against TheEights).", AuditStatusSchema, ECOSYSTEM_HINT),

  // ── Autogenesis / evolution (stub) ──
  stub("list_evolution_proposals", "List pending/filtered autogenesis evolution proposals for a project.", ListEvolutionProposalsSchema, ECOSYSTEM_HINT),
  stub("review_evolution_proposal", "Approve or reject a pending evolution proposal.", ReviewEvolutionProposalSchema, ECOSYSTEM_HINT),
  stub("analyze_autogenesis", "Run the recurring-drift analyzer for a project and emit proposals.", AnalyzeAutogenesisSchema, ECOSYSTEM_HINT),

  // ── Budget / doctor (full) ──
  { name: "budget_status", availability: "full",
    description: "Return budget rows. Pass scope (run:<id>, day:YYYY-MM-DD, model:<id>) to filter; otherwise the 100 most-recent scopes.",
    schema: BudgetStatusSchema, handler: (a) => budgetStatus(BudgetStatusSchema.parse(a).scope) },
  { name: "doctor", availability: "full",
    description: "Health-check: DB reachability, configured vendors, judge capability summaries, cross_vendor readiness. Pass smoke:true to exercise the (injectable) critique smoke; smoke is skipped in the adapter unless an engine attached a provider.",
    schema: z.object({ smoke: z.boolean().optional() }),
    handler: (a) => doctor({ smoke: !!(a as { smoke?: boolean }).smoke }) },

  // ── Triage / taxonomy (full) ──
  { name: "triage_request", availability: "full",
    description: "Heuristic classifier returning {scope: trivial|standard|major, signals[]}.",
    schema: TriageRequestSchema, handler: (a) => heuristicTriage(TriageRequestSchema.parse(a)) },
  { name: "map_taxonomy", availability: "full",
    description: "Heuristic taxonomy mapper returning {scope, sections[], missability_required}.",
    schema: TaxonomyMapRequestSchema, handler: (a) => heuristicMapping(TaxonomyMapRequestSchema.parse(a)) },
  { name: "record_taxonomy_mapping", availability: "full",
    description: "Persist the taxonomy mapping for a run (runs.taxonomy_mapping_json + a per-run artifact).",
    schema: RecordTaxonomyMappingSchema, handler: (a) => recordTaxonomyMapping(RecordTaxonomyMappingSchema.parse(a)) },
  { name: "list_taxonomy_sections", availability: "full",
    description: "Return the 16 taxonomy_blueprint.md sections (4.1..4.16).",
    schema: EmptySchema, handler: () => TAXONOMY_SECTIONS },
  { name: "completion_checklist", availability: "full",
    description: "Return Section 10's 15 verbatim completion-checklist items.",
    schema: EmptySchema, handler: () => COMPLETION_CHECKLIST },

  // ── Master plan (full) ──
  { name: "ensure_master_plan", availability: "full",
    description: "Create <project>/PROJECT_MASTER.md from the 20-section template if absent. Idempotent.",
    schema: EnsureMasterPlanSchema, handler: (a) => ensureMasterPlan(EnsureMasterPlanSchema.parse(a).project_path) },
  { name: "apply_master_plan_patch", availability: "full",
    description: "Patch a section of PROJECT_MASTER.md and record prev/new sha. kind=create|update|append.",
    schema: MasterPlanPatchSchema, handler: (a) => applyMasterPlanPatch(MasterPlanPatchSchema.parse(a)) },
  { name: "master_plan_status", availability: "full",
    description: "Return which of the 20 sections are populated + Section 10's 15-item checklist.",
    schema: MasterPlanStatusSchema, handler: (a) => masterPlanStatus(MasterPlanStatusSchema.parse(a).project_path) },

  // ── Constitution (full) ──
  { name: "ensure_constitution", availability: "full",
    description: "Scaffold <project>/CONSTITUTION.md from the template if absent. Idempotent. Returns {path, created, sha}.",
    schema: EnsureConstitutionSchema, handler: (a) => ensureConstitution(EnsureConstitutionSchema.parse(a).project_path) },
  { name: "constitution_status", availability: "full",
    description: "Return {exists, path, sha, forbidden_patterns?} for CONSTITUTION.md without modifying it.",
    schema: ConstitutionStatusSchema,
    handler: (a) => {
      const p = ConstitutionStatusSchema.parse(a).project_path;
      const c = readConstitution(p);
      if (!c) return { exists: false, path: null, sha: null, forbidden_patterns: [] };
      return { exists: true, path: c.path, sha: c.sha, forbidden_patterns: forbiddenPatterns(p) };
    } },

  // ── AGENTS.md (full) ──
  { name: "ensure_agents_md", availability: "full",
    description: "Create <project>/AGENTS.md (and optionally CLAUDE.md) from the harness template if absent. Idempotent.",
    schema: EnsureAgentsMdSchema,
    handler: (a) => {
      const p = EnsureAgentsMdSchema.parse(a);
      const extras = { profile: p.profile, conventions: p.conventions, build_commands: p.build_commands, extra_sections: p.extra_sections };
      return p.also_claude_md ? ensureAgentsAndClaudeMd(p.project_path, extras) : ensureAgentsMd(p.project_path, extras);
    } },
  { name: "apply_agents_md_patch", availability: "full",
    description: "Patch one of the six canonical AGENTS.md sections and record prev/new sha. kind=create|update|append.",
    schema: AgentsMdPatchSchema, handler: (a) => applyAgentsMdPatch(AgentsMdPatchSchema.parse(a)) },
  { name: "agents_md_status", availability: "full",
    description: "Return existence, size, line count (over_adherence_cliff>200), per-section populated flags, and CLAUDE.md @import status.",
    schema: AgentsMdStatusSchema, handler: (a) => agentsMdStatus(AgentsMdStatusSchema.parse(a).project_path) },

  // ── Missability (full) ──
  { name: "list_missability_checks", availability: "full",
    description: "Return the missability check library (id + human name).",
    schema: EmptySchema, handler: () => CHECK_DEFINITIONS.map(c => ({ id: c.id, name: c.name })) },
  { name: "run_missability_checks", availability: "full",
    description: "Run the missability library against a run's archived artifacts. required_check_ids forces checks to run.",
    schema: RunMissabilitySchema,
    handler: (a) => {
      const p = RunMissabilitySchema.parse(a);
      return runMissabilityChecks({ run_id: p.run_id, required_check_ids: p.required_check_ids as CheckId[] | undefined });
    } },

  // ── Loop ceiling / reflexion (full) ──
  { name: "loop_ceiling_status", availability: "full",
    description: "Return the validator-call count for a run vs the ceiling (default 6). blocked=true means retry_with_critique refuses without budget_override.",
    schema: LoopCeilingSchema, handler: (a) => loopCeilingStatus(LoopCeilingSchema.parse(a).run_id) },
  { name: "retry_with_critique", availability: "full",
    description: "Reflexion ×1 eligibility check. Returns {ok, parent_attempt_id} or {ok:false, reason}. The driver performs the actual regeneration.",
    schema: RetryWithCritiqueSchema,
    handler: (a) => {
      const p = RetryWithCritiqueSchema.parse(a);
      return checkRetryEligible({ attempt_id: p.attempt_id, budget_override: p.budget_override });
    } },

  // ── Best-of-N: pure compute + record (full); worktree ops (stub) ──
  stub("start_best_of_stage", "Open a stage and pre-allocate N candidate git worktrees; the run pilot fans out the generators.", StartBestOfStageSchema, PILOT_HINT),
  { name: "diff_entropy", availability: "full",
    description: "Pairwise Jaccard similarity over candidate texts. Returns {max_similarity, pairwise, warning}.",
    schema: DiffEntropySchema, handler: (a) => diffEntropy(DiffEntropySchema.parse(a)) },
  { name: "borda_count", availability: "full",
    description: "Borda-count tournament over candidate ids using one or more best-first rankings. Returns {winner, scores}.",
    schema: BordaSchema, handler: (a) => bordaCount(BordaSchema.parse(a)) },
  { name: "record_smoke_status", availability: "full",
    description: "Persist a best-of-N candidate's runtime smoke outcome (pass|fail|infra_error|skipped).",
    schema: RecordSmokeStatusSchema, handler: (a) => recordSmokeStatus(RecordSmokeStatusSchema.parse(a)) },
  stub("archive_winner_and_losers", "Auto-commit + git merge --no-ff the best-of-N winner and archive losers.", ArchiveWinnerSchema, PILOT_HINT),
  stub("teardown_candidates", "Remove best-of-N candidate worktrees/branches after preserving registered artifacts.", TeardownCandidatesSchema, PILOT_HINT),

  // ── TDD gate (full) ──
  { name: "tdd_pre_check", availability: "full",
    description: "TDD execution gate, pre-code phase: run the tests_pre manifest's test_command and compare to expected_pre_outcome.",
    schema: TddPreCheckSchema, handler: (a) => runTddCheck({ stage_id: TddPreCheckSchema.parse(a).stage_id, phase: "pre" }) },
  { name: "tdd_post_check", availability: "full",
    description: "TDD execution gate, post-code phase: re-run the tests_pre manifest against the coded tree and compare to expected_post_outcome.",
    schema: TddPostCheckSchema, handler: (a) => runTddCheck({ stage_id: TddPostCheckSchema.parse(a).stage_id, phase: "post" }) },
  { name: "get_tdd_check", availability: "full",
    description: "Return the latest tdd_checks row for (stage_id, phase) or null.",
    schema: GetTddCheckSchema, handler: (a) => { const p = GetTddCheckSchema.parse(a); return { check: getLatestTddCheck(p.stage_id, p.phase) }; } },

  // ── Artifact validators (full) ──
  { name: "artifact_validate", availability: "full",
    description: "Run a structural validator (e.g. adr_structure_lint) over an archived artifact. Persists an artifact_validations row.",
    schema: ArtifactValidateSchema, handler: (a) => runArtifactValidator(ArtifactValidateSchema.parse(a)) },
  { name: "get_artifact_validation", availability: "full",
    description: "Return the latest artifact_validations row for (stage_id, validator_kind[, artifact_id]) or null.",
    schema: GetArtifactValidationSchema,
    handler: (a) => { const p = GetArtifactValidationSchema.parse(a); return { check: getLatestArtifactValidation(p.stage_id, p.validator_kind, p.artifact_id ?? null) }; } },

  // ── Profiles (full) ──
  { name: "get_profile", availability: "full",
    description: "Read <project>/.harness/profile.yaml. Returns the parsed profile or null if absent.",
    schema: GetProfileSchema, handler: (a) => loadProjectProfile(GetProfileSchema.parse(a).project_path) },
  { name: "get_builtin_profile", availability: "full",
    description: "Return one of the built-in profile templates by name.",
    schema: GetBuiltinProfileSchema, handler: (a) => getBuiltinProfile(GetBuiltinProfileSchema.parse(a).name as ProfileName) },
  { name: "list_profiles", availability: "full",
    description: "Return the built-in profile templates (id + description).",
    schema: EmptySchema, handler: () => listBuiltinProfiles() },
  { name: "detect_profile", availability: "full",
    description: "Sniff a project for framework/packaging signals and recommend a built-in profile. Pure (reads files only).",
    schema: DetectProfileSchema, handler: (a) => detectProfile(DetectProfileSchema.parse(a).project_path) },
  { name: "write_profile", availability: "full",
    description: "Persist a built-in profile to <project>/.harness/profile.yaml with a provenance header.",
    schema: WriteProfileSchema,
    handler: (a) => {
      const p = WriteProfileSchema.parse(a);
      if (!(p.name in BUILTIN_PROFILES)) throw new Error(`write_profile: unknown profile name "${p.name}"`);
      return writeProjectProfile(p.project_path, p.name as ProfileName, { source: p.source, runId: p.run_id, signals: p.signals });
    } },

  // ── Tier maps (full) ──
  { name: "get_claude_tier_models", availability: "full",
    description: "Return the canonical Claude tier→model-id map + order.",
    schema: EmptySchema, handler: () => ({ tiers: CLAUDE_TIER_MODELS, order: TIER_ORDER }) },
  { name: "get_copilot_claude_tier_models", availability: "full",
    description: "Return the GitHub Copilot-specific Claude tier→model-id map + order.",
    schema: EmptySchema, handler: () => ({ tiers: COPILOT_CLAUDE_TIER_MODELS, order: TIER_ORDER }) },

  // ── Rubrics (full) ──
  { name: "get_rubric", availability: "full",
    description: "Return the markdown body + metadata for a rubric by id (e.g. 'wcag-2.2-aa@1').",
    schema: GetRubricSchema, handler: (a) => getRubric(GetRubricSchema.parse(a).id) },
  { name: "list_rubrics", availability: "full",
    description: "List all standard-aligned rubrics (id, kind, version, title, source_url).",
    schema: EmptySchema, handler: () => listRubrics() },

  // ── Teams (full) ──
  { name: "team_get", availability: "full",
    description: "Resolve a team yaml by name (project → user → builtin). Returns {team, origin}.",
    schema: GetTeamSchema, handler: (a) => getTeam(GetTeamSchema.parse(a)) },
  { name: "team_list", availability: "full",
    description: "List all available teams (project + user + builtin, first-resolution wins).",
    schema: ListTeamsSchema, handler: (a) => listTeams(ListTeamsSchema.parse(a)) },
  { name: "recommend_team", availability: "full",
    description: "Deterministically score every discoverable team against a request (profile compat, triage signals, keyword hints) and return the top 5 with reasons. Pure heuristics — no model calls.",
    schema: RecommendTeamSchema, handler: (a) => {
      const p = RecommendTeamSchema.parse(a);
      return recommendTeams({ ...p, project_path: p.project_path ?? process.cwd() });
    } },

  // ── Agents (full) ──
  { name: "list_agents", availability: "full",
    description: "List all agent prompts (project → user → builtin, first-resolution wins). Returns AgentSummary[]: {id,name,description,category,model,tier,teams,origin}.",
    schema: ListAgentsSchema, handler: (a) => listAgents(ListAgentsSchema.parse(a)) },
  { name: "get_agent", availability: "full",
    description: "Resolve one agent prompt by id (project → user → builtin). Returns the summary plus {body} (frontmatter-stripped markdown), or null.",
    schema: GetAgentSchema, handler: (a) => getAgent(GetAgentSchema.parse(a)) },

  // ── Skills (full) ──
  { name: "list_skills", availability: "full",
    description: "List all skills (project → user → builtin, first-resolution wins; flat <id>.md or <id>/SKILL.md). Returns SkillSummary[]: {id,name,description,origin,injection,applies_to_stages,applies_to_agents,applies_to_profiles,priority}.",
    schema: ListSkillsSchema, handler: (a) => listSkills(ListSkillsSchema.parse(a)) },
  { name: "get_skill", availability: "full",
    description: "Resolve one skill by id (project → user → builtin). Returns the summary plus {body,version,max_chars,applies_to_gate_types}, or null.",
    schema: GetSkillSchema, handler: (a) => getSkill(GetSkillSchema.parse(a)) },

  // ── Design templates (full) ──
  { name: "get_design_template", availability: "full",
    description: "Return a markdown template for a design artifact kind (screen_state_matrix, permission_aware_ux, ...).",
    schema: GetDesignTemplateSchema, handler: (a) => getDesignTemplate(GetDesignTemplateSchema.parse(a).kind) },
  { name: "list_design_templates", availability: "full",
    description: "Return the available design template kinds.",
    schema: EmptySchema, handler: () => Object.keys(TEMPLATES_BY_KIND) },

  // ── Forums (full) ──
  { name: "list_forums", availability: "full",
    description: "List the 10 governance forums (Section 8).",
    schema: EmptySchema, handler: () => listForums() },
  { name: "get_forum", availability: "full",
    description: "Get a forum's full pipeline (stages, gate types, rubric ids, required missability checks).",
    schema: GetForumSchema, handler: (a) => getForum(GetForumSchema.parse(a).id) },

  // ── Ops (full) ──
  { name: "janitor", availability: "full",
    description: "Run the janitor: mark >6h runs 'crashed', sweep stale candidate worktrees/branches/locks. dry_run returns the sweep plan without mutating. Idempotent.",
    schema: JanitorSchema, handler: (a) => runJanitor({ dry_run: JanitorSchema.parse(a).dry_run === true }) },
  { name: "replay", availability: "full",
    description: "Build a replay bundle for a run: prompt set, model/CLI versions, HEAD SHA, profile, taxonomy mapping, stage/attempt/verdict tree.",
    schema: ReplaySchema, handler: (a) => buildReplayBundle(ReplaySchema.parse(a).run_id) },

  // ── Gate router (full) ──
  { name: "gate_eligible_judges", availability: "full",
    description: "Return the judge tier policy for a gate: required_cross_vendor, base_tier, upgrade reason, recommended rubric_id, and allowed judges.",
    schema: GateEligibleJudgesSchema,
    handler: (a) => {
      const p = GateEligibleJudgesSchema.parse(a);
      const decision = evaluateGate({
        gate_type: p.gate_type as GateType,
        generator_producer: p.generator_producer,
        generator_model: p.generator_model,
        prompt_keywords: p.prompt_keywords,
        profile: p.profile as Profile | undefined,
        artifact_kind: p.artifact_kind,
        rubric_hint: p.rubric_hint,
      });
      const judges = listAllowedJudges(decision, p.generator_producer);
      return { ...decision, allowed_judges: judges };
    } },

  // ── Visual / browser validation (stub) ──
  stub("visual_regression_capture", "Capture before/after screenshots via headless Chromium.", VisualRegressionCaptureSchema, BROWSER_HINT),
  stub("visual_regression_diff", "Diff matched before/after PNGs and render an HTML report.", VisualRegressionDiffSchema, BROWSER_HINT),
  stub("browser_validation_start", "Allocate the per-run browser-validation artifact directory.", BrowserValidationStartSchema, BROWSER_HINT),
  stub("browser_validation_finalize", "Persist browser-validation findings and render the report.", BrowserValidationFinalizeSchema, BROWSER_HINT),
];

/** Convenience: names of tools by availability, for docs/tests. */
export function toolCoverage(): { full: string[]; stub: string[] } {
  const full: string[] = [];
  const stub: string[] = [];
  for (const t of TOOLS) (t.availability === "full" ? full : stub).push(t.name);
  return { full, stub };
}
