---
name: pair-programmer
description: Master reference for the pair-programmer harness. Defines the full request lifecycle — triage, profile snapshot, taxonomy mapping, judge routing with cross-vendor policy, Reflexion x1, missability gate, master-plan patching, and run finalization.
version: 1
injection: none
priority: 50
max_chars: 6000
---
# Pair Programmer harness — driver protocol

You are driving the pair-programmer harness. Every request that flows through the harness follows this protocol. The harness's durable state lives in a local daemon reachable via three MCP servers:

- `pp_harness` — orchestration (start_run, record_attempt, record_verdict, finalize_run, gate_eligible_judges, run_missability_checks, apply_master_plan_patch, …)
- `pp_codex`   — wraps OpenAI Codex CLI (`generate`, `critique`)
- `pp_gemini`  — wraps Google Gemini CLI (`generate`, `critique`)

Both vendors are required for cross-vendor gates. `doctor` reports the configured matrix; if `cross_vendor_ready=false`, security/spec/design/contract gates will refuse to run.

## Cross-references (read on demand)

- `taxonomy-adherence.md` — every task maps to ≥1 of the 16 sections; trivial = changelog only.
- `judge-policy.md` — base tier table, content-keyword upgrades, profile-aware upgrades, candidate-order randomization, Borda for N≥3.
- `artifact-conventions.md` — file layout under `<run_id>/`.
- `rubric-application.md` — how to invoke `get_rubric` and emit structured rubric scores.
- `profile-aware-gating.md` — how `<project>/.harness/profile.yaml` modifies gates.
- `master-plan-patching.md` — protocol for the `master-plan-patcher` and `run-finalizer` agents.

## Lifecycle (full)

**Step semantics (read once, apply to every step below).** Each step is one of two shapes:

- **"Delegate to `<agent>`"** ⇒ you MUST delegate to that sub-agent. Do NOT replicate its tool calls in the driver. If delegation itself fails (the agent type is unavailable, the agent crashes, or the response is malformed), `finalize_run(status="aborted", summary_md=<failure context>)` and STOP. Do NOT compensate by calling the agent's MCP tools yourself.
- **"Call `<tool>`"** ⇒ this is a driver-callable tool (the driver's small allowlist: start_run, start_stage, gate_eligible_judges, record_taxonomy_mapping, archive_artifact, get_stage_finalize_readiness, finalize_stage, finalize_run, run_missability_checks, budget_status, retry_with_critique). Call it directly. If it errors, halt per the failure handling rules below. Do NOT silently retry on a different surface or substitute a sub-agent.

The driver MUST NOT call any `codex.*`, `gemini.*`, or `record_*` / `apply_master_plan_patch` / `retry_with_critique` (without a sub-agent shell) tool directly — those flow through sub-agents only.

1. **Triage.** Delegate to the `triage` agent. Pass `request_text`. It returns `{ class: "trivial" | "standard" | "major", signals: string[] }`. Trivial → minimum-artifact (changelog) path; major → consider escalating to team mode.

2. **Profile snapshot (with first-run bootstrap).** Delegate to the `profile-loader` agent. It calls `get_profile` (with `project_path = cwd`).

   - If the loader returns `source: "project"` or `source: "builtin"` → capture the snapshot and continue to step 3.
   - If the loader returns `source: "needs_bootstrap"`, branch on `detection.confidence`:
     - **`high`** → auto-write. Announce one line to the user before proceeding (`"Detected <recommendation> profile (signals: <signals>). Writing <project>/.harness/profile.yaml. Run pp profile <other> to switch."`), call `write_profile` with `name = detection.recommendation`, `source = "detected"`, `signals = detection.signals`, and the active `run_id`. Then re-invoke `profile-loader` so the next step sees `source: "project"`.
     - **`medium` | `low`** → ask the user via an interactive choice. Show the recommendation, the signals, the alternatives, and offer: pick the recommendation / pick an alternative / pick any of the 16 built-in profiles / `skip` (run in null-profile / generic mode for this run only). On a profile pick, call `write_profile` with `source = "user-selected"`, the chosen `name`, and the run_id. On `skip`, proceed with `snapshot = null`.
     - **`none`** → no signals. Ask the user to pick a profile from `list_profiles` or say `skip`. On a pick, call `write_profile` with `source = "user-selected"`. On `skip`, proceed with `snapshot = null`.
   - **Non-interactive runs** (CI, scripted, no human in the loop): if `confidence` is `high`, auto-write as above; if `confidence` is anything else, fail the run with this exact error: `"[pp] no <project>/.harness/profile.yaml and detection confidence is <confidence>. Bootstrap once interactively (run pp run from a TTY) or commit a profile.yaml. Detected: <recommendation>. Signals: <signals>. Alternatives: <alternatives>."` Do not silently fall back to generic mode.

   Capture the final snapshot (or `null` after explicit `skip`) for later steps. `null` = generic mode.

3. **Start the run.** Call `start_run` with `request_text`, `project_path = cwd`, `mode` (`single` | `best_of` | `team` | `review`), and any `team`/`forum`/`n` set by the calling command. The daemon also persists the profile snapshot internally (loaded at run start) so replay is faithful regardless of whether the driver passed it. Capture `run_id` and `artifact_dir`.

4. **Taxonomy mapping.** Delegate to the `taxonomy-mapper` agent. It returns `{ scope, signals, sections: [{id, title, rationale, required_artifacts}], missability_required }`. Persist via `record_taxonomy_mapping`.

5. **Stage loop.** For each stage in dependency order (default by triage class — see `artifact-conventions.md`):
   - Call `start_stage` with `kind` and `gate_type`. Capture `stage_id`.
   - Call `gate_eligible_judges` with `gate_type`, `generator_producer`, `generator_model` when known, `prompt_keywords` (the user's request), the `profile.name` if any, and `artifact_kind` if known. If `generator_model` is omitted, the daemon infers Codex/Gemini defaults where possible. It returns `{ required_cross_vendor, base_tier, upgraded, rubric_id, allowed_judges }`.
   - Delegate to the generator agent (`engineer`, `spec-author`, `architect`, `designer`, etc., per the team yaml or default). The agent calls `codex.generate` (or Gemini, per binding), archives the result via `archive_artifact`, and records the attempt via `record_attempt`.
   - Delegate to `judge-router`. Capture its route object: `{ judge_agent, preferred_producers, rubric_id, decision_reason }`.
   - Then delegate to the chosen judge agent (`judge-cross-vendor` or `judge-same-vendor`) with the attempt / artifact context plus `rubric_id` (or `rubric_md` if already resolved). That judge agent fetches the rubric if needed, runs the critique tool, and records the verdict via `record_verdict`.
   - **If the judge sub-agent returns `judge_tool_failed=true`** (instead of a verdict): the judge's underlying CLI failed persistently even after the agent's retry-once. Do NOT invoke Reflexion (Reflexion is for a generator that produced a flawed artifact; this is an environment failure on the *judge* side). Archive the failure context to `<artifact_dir>/critique_failures/<stage_id>.json` (write the full `{ judge_tool_failed, reason, vendor, model, exit_code, stderr_tail, attempts, failure_archive_path }` payload via `archive_artifact` with `kind: "critique_failure"`). Then call `finalize_stage(status="surfaced")` and `finalize_run(status="aborted", summary_md=<judge tool failure context, including the failure_archive_path so the user can find the stderr>)`. STOP. Do NOT advance to the next stage. Tell the user the judge bridge is broken and point at `failure_archive_path`. **Never fabricate a passing verdict to "unblock" the pipeline** — halting is correct.
   - On `outcome=fail` (or `revise`): delegate to `reflexion-coach`. The coach calls `retry_with_critique` to verify the ×1 invariant and the loop ceiling, then returns `{ ok, parent_attempt_id, retry_prompt }`. The **driver** — not the coach — must re-invoke the generator with `retry_prompt`, record the retry attempt with `retry_index=1` and `parent_attempt_id`, then re-run the judge. Do not treat the coach's narrative output as proof that the retry occurred; verify the daemon ledger now contains the retry attempt and its new verdict before advancing. The daemon rejects the third generator call automatically.
   - After any judge `pass` (initial or retry), call `get_stage_finalize_readiness(stage_id)` **before** attempting `finalize_stage(status="passed")`.
     - If it returns `next_action="run_tdd_pre_check" | "run_tdd_post_check" | "run_artifact_validate"`, call that tool immediately, then re-call `get_stage_finalize_readiness(stage_id)`.
     - If readiness now returns `can_pass=true`, call `finalize_stage(status="passed", winner_attempt_id=…)` and continue.
     - If readiness returns `next_action="retry_or_surface"`, treat the first blocker `message` as the critique and enter the same Reflexion ×1 flow as a failing verdict. If the retry slot is already spent, or the retry still does not produce `can_pass=true`, finalize the stage as `surfaced` and BREAK.
     - If readiness returns `next_action="surface_stage"`, or it still cannot pass after the required gate tool was run, `finalize_stage(status="surfaced")` and BREAK.
   - Do **not** call `finalize_stage(status="passed")` speculatively and wait for a `TddGateViolation` / `ValidatorGateViolation` exception to tell you what branch you should have taken. That exception path is defense-in-depth, not the normal control flow.

6. **Missability.** Delegate to `missability-inspector`. It calls `run_missability_checks(run_id)` (passing any `missability_required` from step 4 as `required_check_ids`). Any `fail` → `finalize_run(status="surfaced", summary_md=…)`, report to user, STOP.

7. **Master-plan patch.** Delegate to `master-plan-patcher`. It reads `PROJECT_MASTER.md` (calling `ensure_master_plan` first), maps each artifact's taxonomy section to a master-plan section, and calls `apply_master_plan_patch` per section.

8. **Finalize.** Delegate to `run-finalizer`. It writes `run.summary.md`, archives any losers (best-of-N), and calls `finalize_run(status="complete", summary_md=…)`.

9. **Report to the user.** Show:
   - Artifact paths under `<project>/.harness/<run_id>/`.
   - Verdict outcomes (and rubric ids).
   - Total tokens / cost via `budget_status` with `scope="run:<run_id>"`.
   - Master-plan delta (which sections were patched).
   - One-paragraph summary of what changed.

## Invariants you MUST uphold

- **Every artifact written to disk goes through `archive_artifact`.** The daemon scans for secrets, computes the sha256, and refuses to overwrite a file that has been manually edited since the last archive (returns `manual_edit_detected` unless `force_overwrite=true`).
- **Generator and judge MUST use different model ids and — when the gate requires it — different vendors.** Always call `gate_eligible_judges` first; honor `required_cross_vendor=true`. Codex same-vendor is now conditional because `pp_codex.critique` is hard-pinned to `gpt-5.4`; if the generator also used `gpt-5.4`, the daemon upgrades to cross-vendor.
- **Reflexion is ×1 only.** `retry_with_critique` enforces this server-side; the third call is rejected. Surface the run instead of looping.
- **Loop ceiling is enforced.** Default 6 validator calls per run; exceeding it blocks further `retry_with_critique` calls. Override only with explicit user consent (`budget_override=true`) and a documented reason.
- **Run flows are user-explicit only.** Do not start a harness run from a regular conversational request; the user must invoke one explicitly.
- **All harness MCP calls are write-once per logical event.** Don't re-call `record_attempt` for the same attempt; for retries, create a new attempt with `parent_attempt_id` set and `retry_index=1`.
- **`get_stage_finalize_readiness` is the preflight; `finalize_stage` is the commit.** Always consult readiness first when you intend to finalize a stage as `passed`. The daemon exception path is a guardrail, not your branching primitive.

## When something goes wrong

- MCP call errors → print verbatim, then `finalize_run(status="aborted")`.
- Cross-vendor required but vendor matrix incomplete → STOP and tell the user to set `OPENAI_API_KEY` + `GEMINI_API_KEY` (or run the relevant CLI auth) and retry.
- Loop ceiling reached → finalize as `surfaced`; do not pretend the run completed.
- Missability fail → finalize as `surfaced` with the evidence path; the run is incomplete by design.
- Judge tool failed (`judge_tool_failed=true` from the judge sub-agent) → archive the failure context to `<artifact_dir>/critique_failures/<stage_id>.json`, finalize the stage as `surfaced` and the run as `aborted` with the failure context in `summary_md`, STOP. Do NOT invoke Reflexion. Do NOT fabricate a verdict. The user must fix the bridge (model id, auth, network, command-line length) and re-run.
- **A sub-agent returns a result that *says* it succeeded, but the daemon has no record** (e.g., the verdict isn't in `get_run`, the artifact isn't in `archive_artifact`'s registry, the patch doesn't show in `master_plan_status`). Treat this as a sub-agent-contract violation equivalent to `judge_tool_failed=true`: archive the agent's narrative output to `<artifact_dir>/contract_violations/<stage_id>.json`, finalize the stage as `surfaced` and the run as `aborted`, STOP. The daemon ledger is authoritative — do NOT accept the agent's narration as proof of progress.
- **A sub-agent returns `tools_missing`** (because its frontmatter `tools:` list is incomplete or its invocation didn't expose a required tool). Surface the failure to the user verbatim, finalize the run as `aborted`, and flag the agent definition as needing repair. Do NOT retry the agent with a stripped-down workflow that bypasses the missing tool.
