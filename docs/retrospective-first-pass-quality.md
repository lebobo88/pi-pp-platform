# Retrospective: first-pass quality in the pair-programmer harness

**Date:** 2026-07-06
**Dataset:** old harness `~/.pair-programmer/state.db` (2,072 runs, 2,322 stages, 2,609 attempts, 2,306 verdicts, $219.88 recorded generator spend) queried read-only, plus the pi-pp-platform daemon's snake-calc runs, plus code exploration of `packages/{core,pilot,engine,server}`.
**Status:** analysis only — no behavior changes have been made. Recommendations at the end are ranked and await review.

---

## 1. Executive summary

The instinctive framing — "generation is sloppy, so judges make us retry a lot" — is **not what the data shows**. Three separate problems compound, and the biggest one isn't generation quality at all:

1. **Post-verdict machinery, not judges, causes most non-completion.** 658 stages ended `surfaced`; **542 of them (82%) had a latest verdict of `pass`**. The judge approved the work and the stage still surfaced — killed by missability checks, artifact validators, or finalize/regate bugs. Several missability checks have a **100% failure rate** (`deprecation-sunset` 302/302, `steam-ai-disclosure-file`, `lootbox-*`, `middleware-licensing-threshold` 243/243 each): they demand artifacts no pipeline stage ever produces, so any run that requires them cannot complete. This is the same failure class fixed for trivial scope in e8662ab — the data shows it was endemic at every scope in the old harness.
2. **Judge verdicts are self-reported labels, not derived from scores — and it shows.** 25.5% of `pass` verdicts (485/1,901) contain a dimension score **below** the rubric's 0.7 pass bar; 14.2% of non-pass verdicts (45/317) score **all dimensions ≥ 0.7**. Judges also return off-scale values (completeness avg **1.48**, safety 1.16 — on a rubric whose scale is [0,1]) and nothing validates or normalizes them. The pass/revise oscillation observed on snake-calc (same artifact: pass→revise→pass→revise across 7 judgings, scores 0.59–0.90) is the visible symptom of thresholds existing only as prose.
3. **True first-pass rates are fine for docs, weak for code, and confounded by judge pairing.** Overall first-verdict pass rate is 85.4% (1,761/2,063), but: code 64%, spec 53%, security 30%. And the generator×judge vendor pairing dominates the numbers: same-vendor pairs pass at 97% (codex→codex) and 79% (claude→claude), while cross-vendor pairs pass at 42–60%. Cross-vendor judges are systematically ~2× harsher, so "which generator model is better" cannot be read off these numbers without controlling for the judge.

Retry economics: Reflexion ×1 rescues 64% of failures overall, but only **47% at code gates** — the weakest gate is also the hardest to rescue with a critique-augmented same-approach retry (supporting model *rotation* on retry, which is already the agreed Task 9 direction).

Judge cost is fully invisible: 2,306 judge calls, $0 attributed (Phase 2b fixes this).

---

## 2. The numbers

### 2.1 First-verdict outcome by retry index (all gates)

| retry_index | pass | revise | fail | first-pass rate |
|---|---|---|---|---|
| 0 (first attempt) | 1,761 | 201 | 101 | **85.4%** |
| 1 (Reflexion) | 96 | 36 | 18 | 64.0% |
| 2 (override) | 8 | 2 | 1 | 72.7% |

### 2.2 First-pass rate by gate type (retry_index=0)

| gate | pass | total | rate |
|---|---|---|---|
| design | 877 | 907 | 96.7% |
| docs_polish | 42 | 48 | 87.5% |
| contract | 234 | 263 | 89.0% |
| code_style | 397 | 491 | 80.9% |
| **code** | 108 | 169 | **63.9%** |
| **spec** | 76 | 144 | **52.8%** |
| **security** | 3 | 10 | **30.0%** |

### 2.3 Generator × judge vendor pairing (code/code_style/implementation, retry 0)

| generator | judge | pass rate | n |
|---|---|---|---|
| codex | codex | **97%** | 190 |
| claude | claude | **79%** | 334 |
| claude | gemini | 60% | 15 |
| codex | gemini | 50% | 34 |
| claude | codex | **42%** | 88 |

Same-vendor judging is far more lenient than cross-vendor. Per-model "quality" tables (opus-4-7 90% vs fable-5 53% etc.) are confounded by which judge lane each model's stages were routed to; do not use them for model selection without controlling for the judge.

### 2.4 Where surfaced stages actually come from

| gate | surfaced | of which latest verdict = pass |
|---|---|---|
| design | 380 | **374** |
| code | 135 | 79 |
| contract | 79 | 70 |
| code_style | 43 | 17 |
| spec | 21 | 2 |

Missability check library: 1,387 `fail` rows; the worst offenders fail **100% of the time they run** (`deprecation-sunset` 302/302, `analytics-semantics` 300/302, `ai-evals-hitl` 296/302, all game-cert checks 243/243). Artifact validations: 326 `violation` vs 811 `verified` (29% violation rate) plus 52 `execution_error`.

### 2.5 Verdict/label integrity

- 485 / 1,901 `pass` verdicts (25.5%) have ≥1 dimension < 0.7.
- 45 / 317 non-pass verdicts (14.2%) have every dimension ≥ 0.7.
- Off-scale scores accepted silently: `completeness` avg 1.48, `safety` 1.16, `adherence` 1.13, `correctness` 1.03 on pass verdicts. A `_cross_vendor` boolean also leaks into `score_json` as a fake dimension.
- 25 attempts hold both pass and non-pass verdicts on the identical artifact (re-gate flips); snake-calc's final attempt flipped 3× across 7 judgings.

### 2.6 Retry effectiveness by gate (retry_index=1 pass rate)

design 82% · code_style 76% · contract 75% · spec 62% · **code 47%**.

Retries are also not cheaper: code-gate attempts average 262s (first) vs 200s (retry), and each failed cycle pays generator + judge again.

### 2.7 Judge cost blind spot

2,306 judge calls across the dataset with zero ledger rows. `model:` budget scopes contain only generator spend ($145.49 opus-4-8, $68.13 fable-5). All by-model, by-day, and per-run costs are undercounted by the judge share. (Phase 2b, already planned, fixes this.)

---

## 3. Root causes (confirmed in code)

Ordered by measured impact:

**RC1 — Missability/validator gauntlet demands artifacts nothing produces.**
542 surfaced-despite-pass stages. Checks like `deprecation-sunset` are marked required by taxonomy mappings whose pipelines have no stage that emits the evidence. e8662ab fixed the trivial-scope instance in the platform; the standard/major instances (and the check-to-producer coverage gap generally) remain unaudited. *Locus:* taxonomy `missability_required` mapping vs the check library; `run_missability_checks`.

**RC2 — Pass/revise is the judge's self-reported label; thresholds are unenforced prose.**
`validateCritiqueResult` (packages/core/src/mcp/critique-schema.ts) checks JSON shape only; `score_json` is never compared to the rubric's ≥0.7/<0.5 bands; values outside [0,1] are accepted; stage-loop branches on `verdict.outcome === "pass"` only. Explains §2.5 in full. *Locus:* critique-schema.ts + stage-loop outcome branch.

**RC3 — The generator never sees the rubric it will be judged against.**
`renderSystemPrompt` (packages/pilot/src/prompts/loader.ts:373) injects contract, upstream artifacts, role, profile, skills — but no rubric; `assets/agents-src/engineer.md` contains zero rubric references. The rubric is resolved only inside `judge()` (stage-loop.ts:498), after generation. First-pass misses are structural whenever a rubric demands something not obvious from the request (RFC-2119 phrasing, 8-state matrices, deprecation policies). Spec's 53% first-pass rate against a highly-mechanical rubric (`musts_clear`, `shoulds_qualified`…) is the clearest signature: those dimensions are trivially satisfiable *if the generator knows they're graded*.

**RC4 — Cross-vendor judge asymmetry is unmeasured and uncorrected.**
§2.3: cross-vendor lanes are ~2× harsher than same-vendor lanes. The cross-vendor invariant is intentional for elevated gates, but the harshness delta is neither calibrated (no shared anchor examples per rubric) nor reflected in retry policy.

**RC5 — Reflexion retry loses judge context.**
`reflexion()` (stage-loop.ts:683) re-baselines after attempt 0's auto-commit, so the retry judge grades only the incremental diff, with no `contextMd` (no prior critique, no cumulative view). It can re-flag resolved issues or miss regressions — consistent with code-gate retries rescuing only 47%.

**RC6 — Triage and profile detection misclassify exactly the requests that matter.**
`heuristicTriage` (core/orchestrator/taxonomy.ts:45) is keyword+size scoring; the haiku refinement is advisory and cannot move scope; greenfield "create an app" has no keyword (snake-calc → `trivial`). `detectProfileFromFilesystem` (profile-detect.ts:368) reads only the root `package.json` (monorepos fall to low confidence) and request-text game routing fires only when filesystem confidence is low/none (Tauri app → game-dev-web).

**RC7 — Rubric/tier choice is not request-type aware.**
A greenfield build was graded on `minimality` (first verdict: "ambitious… does not meet the pass bar on minimality", correctness 0.35) and generated by `deepseek-v4-pro`. Rubric selection (`pickDefaultRubric`, gates.ts) and tier policy consider gate type and profile, never greenfield-vs-patch.

---

## 4. Ranked recommendations

Each item: locus, cost (S/M/L), expected effect. **None are implemented; awaiting review.**

| # | Recommendation | Locus | Cost | Expected effect |
|---|---|---|---|---|
| R1 | **Audit the missability/validator gauntlet for producibility.** For every check a taxonomy mapping can mark required, assert some stage/artifact kind can produce its evidence; never-producible checks become advisory (logged) exactly as e8662ab did for trivial scope. Data: any check with a lifetime failure rate ≥95% is a config bug, not a quality signal. | taxonomy mapping + check library, `run_missability_checks` | M | Eliminates the largest single cause of surfaced runs (542 pass-but-surfaced stages) |
| R2 | **Derive outcome from scores deterministically.** Clamp/validate scores to [0,1] (reject off-scale with one judge retry), strip pseudo-dimensions (`_cross_vendor`), compute pass/revise/fail from the rubric's bands, treat the judge's label as advisory (log disagreements). | critique-schema.ts, stage-loop verdict branch | S–M | Kills oscillation mechanically; makes score data trustworthy for future calibration |
| R3 | **Show the generator its rubric.** Inject the resolved rubric (or a distilled definition-of-done) into `renderSystemPrompt`; resolve rubric in `runStage` before `generate()` (already possible — `evaluateGate` is pure). | prompts/loader.ts, stage-loop.ts | S | Directly attacks spec 53% / code 64% first-pass; mechanical rubric dims become near-free passes |
| R4 | **Give the retry judge cumulative context.** Pass cumulative diff (stage-start→HEAD) plus the prior critique as `contextMd` to `critique()` on Reflexion. | stage-loop `reflexion()` → engine `critique()` | S | Raises the 47% code-retry rescue rate; prevents re-flagging fixed issues |
| R5 | **Fix triage for greenfield + give the LLM refinement bounded authority.** Add greenfield/new-app detection (empty-or-near-empty target dir, "create/build a/an … app" patterns) → floor at `standard`, prefer `major`; let the haiku refinement move scope within ±1 of the heuristic instead of advisory-only. | taxonomy.ts `heuristicTriage`, pilot triage.ts | S | Stops trivial-scoped app builds; right-sizes gates before anything else runs |
| R6 | **Monorepo + request-aware profile detect.** Glob `packages/*/package.json` (and pnpm-workspace.yaml members) for framework signals; when request-text signal is strong (e.g. game keywords) and filesystem says generic-web, blend instead of ignoring. | profile-detect.ts | M | Correct profiles → correct rubrics/gotchas/validators for monorepos and hybrid apps |
| R7 | **Greenfield-aware rubric weighting + tier floor.** For greenfield scope: swap `minimality` for `scope-fidelity` (did it build what was asked, no more), and floor the generator tier at the ladder's top tier for `major` greenfield stages. | gates.ts rubric pick, tier-resolver.ts | M | Removes the minimality tax on app creation; puts strongest models on hardest work |
| R8 | **Calibrate the cross-vendor lane.** Add 2–3 anchor examples (known-pass, known-revise) to each rubric so judges of any vendor share a reference; track per-judge-model harshness (pass-rate vs peer average) in the DB as an ongoing metric. | rubric bodies + judge policy | M–L | Narrows the 42%-vs-97% pairing gap without abandoning cross-vendor integrity |

Sequencing note: R1+R2 are pure correctness fixes to the harness's own accounting (defensible to do first); R3–R5 are the highest-leverage first-try-quality changes; R6–R8 are calibration deepenings that benefit from the cleaner data R2 produces.

---

## 5. Reproduction

All queries run read-only against `~/.pair-programmer/state.db` (`file:...?mode=ro`). Key ones:

```sql
-- first-pass rate by retry index (first verdict per attempt)
WITH firstv AS (SELECT attempt_id, outcome, MIN(created_at) FROM verdicts GROUP BY attempt_id)
SELECT a.retry_index, f.outcome, COUNT(*) FROM firstv f JOIN attempts a ON a.id=f.attempt_id
GROUP BY a.retry_index, f.outcome;

-- surfaced-despite-pass
WITH latest AS (SELECT a.stage_id, v.outcome,
  ROW_NUMBER() OVER (PARTITION BY a.stage_id ORDER BY v.created_at DESC) rn
  FROM verdicts v JOIN attempts a ON a.id=v.attempt_id)
SELECT s.gate_type, l.outcome, COUNT(*) FROM stages s
JOIN latest l ON l.stage_id=s.id AND l.rn=1
WHERE s.status='surfaced' GROUP BY s.gate_type, l.outcome;

-- label/score disconnect: pass verdicts with min(score)<0.7 — see §2.5 (computed in Python over score_json)

-- always-failing missability checks
SELECT check_id, SUM(status='fail') f, COUNT(*) t FROM missability_checks
GROUP BY check_id HAVING f*1.0/t > 0.95 ORDER BY f DESC;
```
