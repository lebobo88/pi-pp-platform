import type {
  RunTree,
  RunRow,
  StageRow,
  AttemptRow,
  VerdictRow,
  ArtifactRow,
  MissabilityCheckRow,
  ReplayBundle,
} from "@shared/api-types";

/**
 * A realistic 5-stage feature-team run:
 *   1. spec           (single attempt, pass)
 *   2. design         (reflexion retry ×1: first attempt revised, retry passes)
 *   3. contracts      (single attempt, cross-vendor pass)
 *   4. implementation (best-of-3 candidate race → Borda pick, one loser)
 *   5. docs           (single attempt, pass)
 *
 * IDs and timestamps are stable so screens and snapshots are deterministic.
 */

export const MOCK_RUN_ID = "run_9fK2aLpQ7vX3";
const PROJECT = "C:/AiAppDeployments/acme-checkout";
const T0 = "2026-07-01T14:02:11.000Z";

const run: RunRow = {
  id: MOCK_RUN_ID,
  session_id: "sess_7712",
  project_path: PROJECT,
  request_text:
    "Add a coupon-code field to the checkout flow: validate server-side, apply discount to the order total, and surface an inline error for invalid codes.",
  team: "feature-team",
  mode: "team",
  forum: null,
  n: null,
  status: "surfaced",
  profile_snapshot_json: JSON.stringify({ name: "web-ui", cross_vendor_all_gates: false }),
  taxonomy_mapping_json: JSON.stringify({
    scope: "standard",
    sections: [{ id: "4.3" }, { id: "4.7" }, { id: "4.8" }],
  }),
  head_sha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
  tree_dirty_hash: "d41d8cd98f00b204e9800998ecf8427e",
  cli_versions_json: JSON.stringify({ node: "v22.20.0", git: "2.45.1" }),
  cli_flags_json: null,
  hydra_workflow_id: null,
  hydra_envelope_id: null,
  hydra_origin_squad: null,
  hydra_envelope_type: null,
  constitution_sha: "cst_88ac41",
  constitution_attestation_id: "att_5521",
  eights_episodic_handle: null,
  audit_bom_handle: null,
  started_at: T0,
  finished_at: null,
};

// ── Stages ────────────────────────────────────────────────────────────────

const stages: StageRow[] = [
  {
    id: "stg_spec",
    run_id: MOCK_RUN_ID,
    kind: "spec",
    gate_type: "spec",
    status: "passed",
    winner_attempt_id: "att_spec_1",
    started_at: "2026-07-01T14:02:12.000Z",
    finished_at: "2026-07-01T14:03:40.000Z",
    notes_json: null,
  },
  {
    id: "stg_design",
    run_id: MOCK_RUN_ID,
    kind: "design",
    gate_type: "design",
    status: "passed",
    winner_attempt_id: "att_design_2",
    started_at: "2026-07-01T14:03:41.000Z",
    finished_at: "2026-07-01T14:06:20.000Z",
    notes_json: JSON.stringify({ reflexion: true, retries: 1 }),
  },
  {
    id: "stg_contracts",
    run_id: MOCK_RUN_ID,
    kind: "contracts",
    gate_type: "contract",
    status: "passed",
    winner_attempt_id: "att_contract_1",
    started_at: "2026-07-01T14:06:21.000Z",
    finished_at: "2026-07-01T14:08:02.000Z",
    notes_json: null,
  },
  {
    id: "stg_impl",
    run_id: MOCK_RUN_ID,
    kind: "implementation",
    gate_type: "code_style",
    status: "passed",
    winner_attempt_id: "att_impl_b",
    started_at: "2026-07-01T14:08:03.000Z",
    finished_at: "2026-07-01T14:13:55.000Z",
    notes_json: JSON.stringify({ best_of: 3, borda_winner: "att_impl_b" }),
  },
  {
    id: "stg_docs",
    run_id: MOCK_RUN_ID,
    kind: "docs",
    gate_type: "docs_polish",
    status: "surfaced",
    winner_attempt_id: null,
    started_at: "2026-07-01T14:13:56.000Z",
    finished_at: null,
    notes_json: JSON.stringify({ surfaced_reason: "missability: changelog entry missing" }),
  },
];

// ── Attempts ──────────────────────────────────────────────────────────────

const attempts: AttemptRow[] = [
  {
    id: "att_spec_1",
    stage_id: "stg_spec",
    producer: "claude",
    model_id: "claude-opus-4-7",
    prompt_hash: "ph_spec_9a1",
    artifact_path: ".harness/runs/run_9fK2aLpQ7vX3/spec/feature_spec.md",
    tokens_in: 4120,
    tokens_out: 1880,
    cost_usd: 0.203,
    wall_ms: 41200,
    retry_index: 0,
    parent_attempt_id: null,
    status: "ok",
    attempted_tier: "opus",
    created_at: "2026-07-01T14:02:14.000Z",
  },
  // design: first attempt revised, retry passes (reflexion ×1)
  {
    id: "att_design_1",
    stage_id: "stg_design",
    producer: "claude",
    model_id: "claude-sonnet-4-6",
    prompt_hash: "ph_design_11",
    artifact_path: ".harness/runs/run_9fK2aLpQ7vX3/design/adr-0007.md",
    tokens_in: 5210,
    tokens_out: 2240,
    cost_usd: 0.049,
    wall_ms: 52800,
    retry_index: 0,
    parent_attempt_id: null,
    status: "ok",
    attempted_tier: "sonnet",
    created_at: "2026-07-01T14:03:44.000Z",
  },
  {
    id: "att_design_2",
    stage_id: "stg_design",
    producer: "claude",
    model_id: "claude-opus-4-7",
    prompt_hash: "ph_design_12",
    artifact_path: ".harness/runs/run_9fK2aLpQ7vX3/design/adr-0007.md",
    tokens_in: 6740,
    tokens_out: 2610,
    cost_usd: 0.276,
    wall_ms: 61400,
    retry_index: 1,
    parent_attempt_id: "att_design_1",
    status: "ok",
    attempted_tier: "opus",
    created_at: "2026-07-01T14:05:02.000Z",
  },
  {
    id: "att_contract_1",
    stage_id: "stg_contracts",
    producer: "codex",
    model_id: "gpt-5.3-codex",
    prompt_hash: "ph_contract_3",
    artifact_path: ".harness/runs/run_9fK2aLpQ7vX3/contracts/openapi.yaml",
    tokens_in: 3980,
    tokens_out: 1520,
    cost_usd: 0.025,
    wall_ms: 38900,
    retry_index: 0,
    parent_attempt_id: null,
    status: "ok",
    attempted_tier: null,
    created_at: "2026-07-01T14:06:24.000Z",
  },
  // implementation: best-of-3 candidates
  {
    id: "att_impl_a",
    stage_id: "stg_impl",
    producer: "claude",
    model_id: "claude-sonnet-4-6",
    prompt_hash: "ph_impl_a",
    artifact_path: ".harness/runs/run_9fK2aLpQ7vX3/impl/candidate-a.diff",
    tokens_in: 8120,
    tokens_out: 3940,
    cost_usd: 0.083,
    wall_ms: 74200,
    retry_index: 0,
    parent_attempt_id: null,
    status: "ok",
    attempted_tier: "sonnet",
    created_at: "2026-07-01T14:08:06.000Z",
  },
  {
    id: "att_impl_b",
    stage_id: "stg_impl",
    producer: "claude",
    model_id: "claude-opus-4-7",
    prompt_hash: "ph_impl_b",
    artifact_path: ".harness/runs/run_9fK2aLpQ7vX3/impl/candidate-b.diff",
    tokens_in: 8340,
    tokens_out: 4210,
    cost_usd: 0.379,
    wall_ms: 81900,
    retry_index: 0,
    parent_attempt_id: null,
    status: "ok",
    attempted_tier: "opus",
    created_at: "2026-07-01T14:08:07.000Z",
  },
  {
    id: "att_impl_c",
    stage_id: "stg_impl",
    producer: "gemini",
    model_id: "gemini-2.5-pro",
    prompt_hash: "ph_impl_c",
    artifact_path: ".harness/runs/run_9fK2aLpQ7vX3/impl/candidate-c.diff",
    tokens_in: 7980,
    tokens_out: 3610,
    cost_usd: 0.066,
    wall_ms: 69500,
    retry_index: 0,
    parent_attempt_id: null,
    status: "needs_review",
    attempted_tier: null,
    created_at: "2026-07-01T14:08:07.500Z",
  },
  {
    id: "att_docs_1",
    stage_id: "stg_docs",
    producer: "claude",
    model_id: "claude-haiku-4-5-20251001",
    prompt_hash: "ph_docs_1",
    artifact_path: ".harness/runs/run_9fK2aLpQ7vX3/docs/release-notes.md",
    tokens_in: 2210,
    tokens_out: 980,
    cost_usd: 0.006,
    wall_ms: 18400,
    retry_index: 0,
    parent_attempt_id: null,
    status: "ok",
    attempted_tier: "haiku",
    created_at: "2026-07-01T14:13:59.000Z",
  },
];

// ── Verdicts ──────────────────────────────────────────────────────────────

const verdicts: VerdictRow[] = [
  {
    id: "vd_spec_1",
    attempt_id: "att_spec_1",
    judge_producer: "codex",
    judge_model_id: "gpt-5.4",
    rubric_id: "feature-spec-quality@2",
    outcome: "pass",
    critique_md:
      "Spec is testable and scoped. Acceptance criteria use RFC 2119 language. **Pass** — no blocking gaps.",
    score_json: JSON.stringify({ clarity: 4, testability: 5, scope: 4 }),
    cross_vendor: 1,
    eights_memory_id: null,
    created_at: "2026-07-01T14:03:35.000Z",
  },
  {
    id: "vd_design_1",
    attempt_id: "att_design_1",
    judge_producer: "gemini",
    judge_model_id: "gemini-2.5-pro",
    rubric_id: "adr-madr-structure@1",
    outcome: "revise",
    critique_md:
      "ADR omits the **Consequences** section and does not weigh the server-side vs client-side validation trade-off. Add a rejected-alternatives note before acceptance.",
    score_json: JSON.stringify({ structure: 2, rigor: 3 }),
    cross_vendor: 1,
    eights_memory_id: null,
    created_at: "2026-07-01T14:04:58.000Z",
  },
  {
    id: "vd_design_2",
    attempt_id: "att_design_2",
    judge_producer: "gemini",
    judge_model_id: "gemini-2.5-pro",
    rubric_id: "adr-madr-structure@1",
    outcome: "pass",
    critique_md:
      "Consequences and rejected alternatives now present; trade-off is explicit. **Pass.**",
    score_json: JSON.stringify({ structure: 4, rigor: 4 }),
    cross_vendor: 1,
    eights_memory_id: null,
    created_at: "2026-07-01T14:06:18.000Z",
  },
  {
    id: "vd_contract_1",
    attempt_id: "att_contract_1",
    judge_producer: "claude",
    judge_model_id: "claude-opus-4-7",
    rubric_id: "openapi-3.1-stability@1",
    outcome: "pass",
    critique_md: "Schema validates against OpenAPI 3.1. Error responses are modeled. **Pass.**",
    score_json: JSON.stringify({ validity: 5, completeness: 4 }),
    cross_vendor: 1,
    eights_memory_id: null,
    created_at: "2026-07-01T14:07:58.000Z",
  },
  // best-of-3 verdicts (each candidate judged)
  {
    id: "vd_impl_a",
    attempt_id: "att_impl_a",
    judge_producer: "codex",
    judge_model_id: "gpt-5.4",
    rubric_id: "code-quality@3",
    outcome: "pass",
    critique_md: "Correct and readable. Slightly over-fetches on the discount lookup.",
    score_json: JSON.stringify({ correctness: 4, clarity: 4, tests: 3 }),
    cross_vendor: 1,
    eights_memory_id: null,
    created_at: "2026-07-01T14:12:40.000Z",
  },
  {
    id: "vd_impl_b",
    attempt_id: "att_impl_b",
    judge_producer: "codex",
    judge_model_id: "gpt-5.4",
    rubric_id: "code-quality@3",
    outcome: "pass",
    critique_md:
      "Best candidate: single-query discount resolution, complete unit tests, clean inline-error path. **Borda winner.**",
    score_json: JSON.stringify({ correctness: 5, clarity: 5, tests: 5 }),
    cross_vendor: 1,
    eights_memory_id: null,
    created_at: "2026-07-01T14:12:44.000Z",
  },
  {
    id: "vd_impl_c",
    attempt_id: "att_impl_c",
    judge_producer: "codex",
    judge_model_id: "gpt-5.4",
    rubric_id: "code-quality@3",
    outcome: "revise",
    critique_md:
      "Self-verify flagged an un-parameterized SQL string in the coupon lookup — routed to needs_review. Discount math is otherwise correct.",
    score_json: JSON.stringify({ correctness: 3, clarity: 4, tests: 3 }),
    cross_vendor: 1,
    eights_memory_id: null,
    created_at: "2026-07-01T14:12:49.000Z",
  },
];

// ── Artifacts ─────────────────────────────────────────────────────────────

const artifacts: ArtifactRow[] = [
  {
    id: "art_spec",
    run_id: MOCK_RUN_ID,
    stage_id: "stg_spec",
    taxonomy_section: "4.3",
    kind: "feature_spec",
    path: ".harness/runs/run_9fK2aLpQ7vX3/spec/feature_spec.md",
    sha256: "9a1c4f2e8b7d6a5c3f1e0d9c8b7a6f5e4d3c2b1a0f9e8d7c6b5a4f3e2d1c0b9a8",
    bytes: 4820,
    cell: "context",
    eights_memory_id: null,
    eights_handle: null,
    created_at: "2026-07-01T14:03:38.000Z",
  },
  {
    id: "art_adr",
    run_id: MOCK_RUN_ID,
    stage_id: "stg_design",
    taxonomy_section: "4.6",
    kind: "adr",
    path: ".harness/runs/run_9fK2aLpQ7vX3/design/adr-0007.md",
    sha256: "1f2e3d4c5b6a7988c0d1e2f3a4b5c6d7e8f9a0b1c2d3e4f5a6b7c8d9e0f1a2b3c",
    bytes: 6310,
    cell: "constraints",
    eights_memory_id: null,
    eights_handle: null,
    created_at: "2026-07-01T14:06:19.000Z",
  },
  {
    id: "art_openapi",
    run_id: MOCK_RUN_ID,
    stage_id: "stg_contracts",
    taxonomy_section: "4.7",
    kind: "openapi",
    path: ".harness/runs/run_9fK2aLpQ7vX3/contracts/openapi.yaml",
    sha256: "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    bytes: 3120,
    cell: "context",
    eights_memory_id: null,
    eights_handle: null,
    created_at: "2026-07-01T14:08:01.000Z",
  },
  {
    id: "art_impl",
    run_id: MOCK_RUN_ID,
    stage_id: "stg_impl",
    taxonomy_section: "4.8",
    kind: "diff",
    path: ".harness/runs/run_9fK2aLpQ7vX3/impl/candidate-b.diff",
    sha256: "0011223344556677889900112233445566778899001122334455667788990011",
    bytes: 5480,
    cell: "focus",
    eights_memory_id: null,
    eights_handle: null,
    created_at: "2026-07-01T14:13:50.000Z",
  },
];

export const mockRunTree: RunTree = { run, stages, attempts, verdicts, artifacts };

/** Section-6 missability check results for the run. */
export const mockMissabilityChecks: MissabilityCheckRow[] = [
  { id: "mc_1", run_id: MOCK_RUN_ID, check_id: "changelog-present", status: "fail", evidence_path: ".harness/runs/run_9fK2aLpQ7vX3/missability/changelog.json", created_at: "2026-07-01T14:13:57.000Z" },
  { id: "mc_2", run_id: MOCK_RUN_ID, check_id: "tests-cover-new-behavior", status: "pass", evidence_path: ".harness/runs/run_9fK2aLpQ7vX3/missability/tests.json", created_at: "2026-07-01T14:13:57.000Z" },
  { id: "mc_3", run_id: MOCK_RUN_ID, check_id: "no-secrets-in-diff", status: "pass", evidence_path: null, created_at: "2026-07-01T14:13:57.000Z" },
  { id: "mc_4", run_id: MOCK_RUN_ID, check_id: "acceptance-criteria-traced", status: "pass", evidence_path: null, created_at: "2026-07-01T14:13:57.000Z" },
  { id: "mc_5", run_id: MOCK_RUN_ID, check_id: "rollback-documented", status: "n/a", evidence_path: null, created_at: "2026-07-01T14:13:57.000Z" },
];

/** Reproducible-replay bundle — nested shape, mirrors core buildReplayBundle. */
export const mockReplayBundle: ReplayBundle = {
  run_id: MOCK_RUN_ID,
  request_text: run.request_text,
  project_path: run.project_path,
  team: run.team,
  mode: run.mode,
  forum: run.forum,
  n: run.n,
  status: run.status,
  head_sha: run.head_sha,
  tree_dirty_hash: run.tree_dirty_hash,
  profile_snapshot: run.profile_snapshot_json ? JSON.parse(run.profile_snapshot_json) : null,
  taxonomy_mapping: run.taxonomy_mapping_json ? JSON.parse(run.taxonomy_mapping_json) : null,
  cli_versions: { node: "v22.20.0", git: "2.45.1" },
  started_at: run.started_at,
  finished_at: run.finished_at,
  stages: stages.map((s) => ({
    id: s.id,
    kind: s.kind,
    gate_type: s.gate_type,
    status: s.status,
    attempts: attempts
      .filter((a) => a.stage_id === s.id)
      .map((a) => ({
        id: a.id,
        producer: a.producer,
        model_id: a.model_id,
        attempted_tier: a.attempted_tier,
        retry_index: a.retry_index,
        parent_attempt_id: a.parent_attempt_id,
        tokens_in: a.tokens_in,
        tokens_out: a.tokens_out,
        cost_usd: a.cost_usd,
        verdicts: verdicts
          .filter((v) => v.attempt_id === a.id)
          .map((v) => ({
            judge_producer: v.judge_producer,
            judge_model_id: v.judge_model_id,
            rubric_id: v.rubric_id,
            outcome: v.outcome,
            cross_vendor: v.cross_vendor === 1,
          })),
      })),
  })),
  artifacts: artifacts.map((a) => ({ kind: a.kind, path: a.path, sha256: a.sha256 })),
  tier_resolution: null,
  cli_flags: null,
  reproduction_notes: "Re-issue with `ppp replay run_9fK2aLpQ7vX3`. Head SHA and dirty-tree hash captured at start.",
};

/** Unified diff shown on the implementation stage's winning attempt. */
export const mockWinningDiff = `diff --git a/src/checkout/order.ts b/src/checkout/order.ts
index 3a1f0c2..8b4e9d1 100644
--- a/src/checkout/order.ts
+++ b/src/checkout/order.ts
@@ -12,6 +12,7 @@ export interface OrderTotals {
   subtotal: number;
   tax: number;
   shipping: number;
+  discount: number;
   total: number;
 }

@@ -34,9 +35,18 @@ export function computeTotals(order: Order): OrderTotals {
   const tax = round(subtotal * order.taxRate);
   const shipping = order.shippingCost;
-  const total = subtotal + tax + shipping;
-  return { subtotal, tax, shipping, total };
+  const discount = order.coupon ? resolveDiscount(order.coupon, subtotal) : 0;
+  const total = Math.max(0, subtotal + tax + shipping - discount);
+  return { subtotal, tax, shipping, discount, total };
 }
+
+function resolveDiscount(code: string, subtotal: number): number {
+  const coupon = couponRepo.findActive(code);
+  if (!coupon) throw new InvalidCouponError(code);
+  return coupon.kind === "percent"
+    ? round(subtotal * coupon.value)
+    : Math.min(coupon.value, subtotal);
+}
diff --git a/src/checkout/order.test.ts b/src/checkout/order.test.ts
index 1122aa3..44ff556 100644
--- a/src/checkout/order.test.ts
+++ b/src/checkout/order.test.ts
@@ -8,3 +8,11 @@ describe("computeTotals", () => {
     expect(computeTotals(order).total).toBe(4200);
   });
+
+  it("applies a percent coupon and clamps at zero", () => {
+    const order = { ...base, coupon: "SAVE20" };
+    expect(computeTotals(order).discount).toBeGreaterThan(0);
+    expect(computeTotals(order).total).toBeGreaterThanOrEqual(0);
+  });
 });
`;

/** ANSI-colored sample log for the winning attempt. */
export const mockAttemptLog: string[] = [
  "\x1b[2m14:08:07\x1b[0m \x1b[34m[engineer]\x1b[0m starting candidate-b (claude-opus-4-7)",
  "\x1b[2m14:08:09\x1b[0m reading src/checkout/order.ts",
  "\x1b[2m14:08:22\x1b[0m \x1b[33mplan:\x1b[0m add discount field, resolveDiscount(), inline-error path",
  "\x1b[2m14:09:41\x1b[0m writing src/checkout/order.ts",
  "\x1b[2m14:10:02\x1b[0m writing src/checkout/order.test.ts",
  "\x1b[2m14:11:15\x1b[0m \x1b[36m$ pnpm vitest run order.test.ts\x1b[0m",
  "\x1b[32m✓\x1b[0m src/checkout/order.test.ts (6 tests) 812ms",
  "\x1b[2m14:12:30\x1b[0m \x1b[32mself-verify passed\x1b[0m — no anti-patterns detected",
  "\x1b[2m14:12:44\x1b[0m committed 2 files (+31 −3)",
];
