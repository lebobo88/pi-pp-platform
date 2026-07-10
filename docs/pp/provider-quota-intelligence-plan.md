# Implementation spec: provider quota/credit intelligence + harness attempt-waste fixes

Status: approved plan (2026-07-10). Source investigation: run_hXKxSneI8pDg failure loop.

## Root cause being fixed

pi-ai (0.80.3) never throws on HTTP 429 / 402 / `insufficient_quota` — it resolves the
completion with `stopReason:"error"` and the real cause in `AssistantMessage.errorMessage`
(`pi-ai/dist/utils/event-stream.js:60-74`, `api/openai-responses.js:111-119`). The engine
never reads `errorMessage` (`packages/engine/src/envelope.ts:90-114`), so provider quota /
credit exhaustion is recorded as:

- generator attempts with 0 tokens, empty diff, `status:"ok"` (stage-loop.ts:552 hardcodes ok);
- judge critiques failing as "empty output" → `stop_reason:"invalid_output"` → stage aborts
  and surfaces (`packages/engine/src/critique.ts:73-131`);
- `doctorProbe` reporting an exhausted provider healthy (`packages/engine/src/doctor.ts:42-57`).

## Behavioral invariants that MUST hold

- Reflexion ×1 retry per stage (quality loop). Infra/error retries introduced here use
  `retry_index=0`, are never judged, and never consume the Reflexion slot.
- Cross-vendor judging for elevated gates. New filters (cooldown, excludeProviders) only
  shrink an already-eligible pool; an empty pool still halts — never fabricate a verdict.
- Budget tripwires unchanged; manual-retry override semantics unchanged (by design).
- Additive-only SQLite schema changes. This plan needs ZERO schema changes: `"error"` is
  already in `ATTEMPT_STATUS` (packages/core/src/config.ts:119) and `notes_json` exists.
- Write-only provider keys: balance probes read keys server-side only; never echo a key.
- Only packages/engine imports @earendil-works/pi-*.
- shared/api-types.ts is the wire contract: any endpoint/payload change updates its types
  AND `apiPaths` in the same commit.

## Engineer execution constraints (Hydra candidate worktrees)

- **VERIFIED FACT** (do not re-derive, do not stall on it): pi-ai 0.80.3's
  `AssistantMessage` carries `errorMessage?: string` alongside
  `stopReason: StopReason` (which includes `"error"`) — see
  `node_modules/@earendil-works/pi-ai/dist/types.d.ts:276-289`. The error event
  resolves (never rejects) via `dist/utils/event-stream.js:60-74`. Provider error
  strings are built by `dist/utils/error-body.js` `formatProviderError` and look like
  `"OpenAI API error (429): {...insufficient_quota...}"`. Note the local fake
  (`packages/engine/src/fake.ts`) constructs AssistantMessage WITHOUT errorMessage —
  extend the fake, don't trust it as the contract.
- Candidate worktrees have **no node_modules and pnpm is sandbox-blocked**. Do NOT
  attempt `pnpm install/build/test` — implement and verify by reading. The harness
  smoke (operator-configured `.harness/smoke_cmd.json`) runs
  install + build + core/pilot suites after judging; the operator runs the full
  `pnpm -r build && pnpm -r typecheck && pnpm -r test` gate after merge. Write tests
  as specified; they will be executed by the smoke/operator gate, not by you.

## Workstream 1 — surface provider errors truthfully

1. `packages/engine/src/envelope.ts` (`buildGenResult` :90-114): when
   `msg.stopReason === "error"`, carry `msg.errorMessage` into `GenResult` (additive field
   `error_message`). Add classifier (mirror pi-ai `utils/retry.js` text patterns):
   - `insufficient_quota | billing | out of budget | usage limit` → `quota_exhausted`
   - `429 | rate limit | too many requests` → `rate_limited`
   - else → `provider_error`
   Expose as `error_class` on GenResult.
2. `packages/engine/src/critique.ts`: if the completion resolves with `stopReason:"error"`,
   skip the JSON-validation retry loop — fail immediately with the classified reason; the
   failure archive txt must record provider, model, error class, and errorMessage tail
   (not just "empty output"). Return a distinguishable stop_reason (`provider_error`) vs
   genuine `invalid_output`. Hardening: pass explicit `maxTokens`
   (env `PP_CRITIQUE_MAX_TOKENS`, default ~32k, capped by model.maxTokens) and `timeoutMs`
   (env `PP_CRITIQUE_TIMEOUT_MS`, default 300000) — `withTimeout` currently never arms
   (llm.ts:60).
3. `packages/engine/src/generate-completion.ts` / `generate-session.ts`: propagate
   error class + message into GenResult (session path: provider-error sessions end with 0
   mutating tool calls; cross-check `stop_reason:"no_tool_calls"` + 0 tokens).
4. `packages/engine/src/doctor.ts` `doctorProbe` (:42-57): inspect
   `msg.stopReason === "error"` / `errorMessage` — quota-exhausted must be `ok:false` with
   the real reason.
5. `packages/pilot/src/phases/stage-loop.ts` `generate()` → `recordAttempt` (:541-559):
   stop hardcoding `status:"ok"`. Record `status:"error"` when GenResult carries an error
   class OR output is empty (completion: empty text; coding: zeroChange + no_tool_calls);
   `status:"timeout"` on timeout. Persist
   `{error_class, error_message, stop_reason, files_changed}` in `notes_json` (additive
   keys; verify gates.ts:346-349 parseNotes consumers tolerate them).

## Workstream 2 — provider health, limits & balance display

1. New `packages/engine/src/provider-health.ts`: in-memory per-provider registry updated
   from every completion/session result:
   `{ health: ok|rate_limited|quota_exhausted|error|unknown, last_error, last_error_at, cooldown_until? }`.
   Rate-limit → cooldown (honor retry-after text when present; default 10 min).
   Quota-exhausted → cooldown until a successful manual probe. `isProviderAvailable(p)` =
   not `PP_DISABLE_<P>` (catalog.ts:58-62) AND not in cooldown. A successful
   `POST /providers/:vendor/test` probe clears cooldown.
2. Balance probes (in doctor.ts, plain fetch):
   - DeepSeek: `GET https://api.deepseek.com/user/balance` (Authorization: Bearer key) →
     `{amount, currency, as_of}`.
   - OpenAI/Anthropic: no public balance endpoint — display last-known health instead.
   - openai-codex / github-copilot: plan-based limits, no API — surface the captured
     "usage limit reached" message + retry-after text.
3. Wire: `shared/api-types.ts` `ProviderStatus` (:256-276) additive fields: `health`,
   `last_error`, `last_error_at`, `cooldown_until`, `balance?: {amount, currency, as_of}`.
   Mapper `packages/server/src/wire.ts:62-78`. Prefer enriching existing
   `GET /api/v1/providers` + `POST /providers/:vendor/test`; if adding
   `GET /providers/:vendor/balance`, update `apiPaths` same commit.
4. UI `ui/src/features/providers/ProvidersPage.tsx` (:716-770): status chip driven by
   `health`, balance display where present, last-error tooltip, cooldown countdown; "Test"
   clears state on success.

## Workstream 3 — stop burning attempts on exhausted providers

1. Judge failover — `stage-loop.ts` `judge()` (:599-712) + `judge-policy.ts`:
   - Add `excludeProviders?` to `JudgeSelectInput`; eligibility additionally filters
     providers in cooldown via the health registry.
   - Bounded candidate loop: (a) selected judge; (b) on provider_error/invalid_output and
     escalated → de-escalate to the provider's default pool model; (c) re-select excluding
     the failed provider (max 2 providers total); (d) exhausted → existing
     archiveCritiqueFailure + gate.blocked + abort. Emit a bus frame per failover hop
     `{failover:true, from_model, to_model}`. Record verdicts under the model that actually judged.
2. Errored-attempt guard — `stage-loop.ts` `runStage()` (:347-355): a `status:"error"`
   attempt is NOT judged and does NOT consume Reflexion. One infra retry at the same tier
   (`retry_index=0`, `parent_attempt_id` chained); when error class is quota/rate, rotate
   the generation pool to skip the cooled-down provider
   (generation-model.ts:148-164 + availability filter). Two consecutive errored attempts →
   surface with the real reason; zero judge calls; Reflexion intact.
   `reflexion()`'s existing zeroChange→surface stays.
3. Smart /pp:retry — `post-hoc.ts` (:241-258): if the latest attempt has a real artifact
   (`status != 'error'`, not "commit none") AND no non-retracted verdict → route to
   `regateStage` instead of `reflexion()`; response surfaces `action: "retry"|"gate"`
   (run-control.ts). Add `retry?` passthrough to regateStage's judge call (currently
   hardcoded false). `reconstruct()` prefers latest non-error attempt
   (`ORDER BY (status='error') ASC, created_at DESC`).

## Workstream 4 — budget caps configurability (reduced scope)

Verify `platform_settings.budget_caps` (settings.ts:36-38) has a REST read/update surface
+ UI; add if missing (wire-contract rule applies). No default cap. No change to manual
retry override semantics.

## Workstream 5 — tests

- Engine (vitest): critique provider-error short-circuit + real-cause archive +
  maxTokens/timeout; envelope errorMessage propagation + classifier; doctor
  resolve-with-error → ok:false; provider-health cooldown set/clear + availability.
- Pilot (vitest, PP_SKIP_CLI_VERSIONS=1; extend test/helpers.ts makeScriptedEngine to
  script error-resolving completions and record judge model per call): errored attempt →
  status error, no judge call, no Reflexion consumed, one infra retry rotating provider;
  double-error → surfaced with real reason; judge failover order
  (escalated → de-escalated → next provider → abort); retryStage routes to gate when latest
  attempt unverdicted; fail-verdict retry still regenerates.
- Server (vitest): providers endpoint new fields; retry route action; budget-caps route if added.
- Core (node --test): loop-ceiling-automatic.unit.mjs stays green.
- Gate: `pnpm -r build && pnpm -r typecheck && pnpm -r test`.

## Pre-coding verifications

1. Exact `errorMessage` string shapes per provider (validate classifier against the real
   archives in `.harness/critique_failures/`).
2. Whether a budget_caps REST route already exists.
3. DeepSeek /user/balance response shape.
4. pi-ai completeSimple maxTokens → max_output_tokens mapping (Responses API).
5. recordVerdict per-attempt uniqueness under within-judge() re-judging (regate already
   records second verdicts — expected fine).
