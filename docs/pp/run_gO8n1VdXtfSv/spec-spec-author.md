# Provider visibility + live-view discoverability — Feature Spec

**Spec ID:** `spec-provider-visibility-live-view-discoverability`
**Version:** 1.1.0
**Status:** Draft
**Owner:** Platform / UI

---

## 1. Overview

### 1.1 Problem

In `pi-pp-platform`, the same `model_id` can be served by multiple providers. Concretely, `gpt-5.4` is currently reachable through at least `azure-openai-responses`, `github-copilot`, and `openai-codex`. Any UI surface that displays a model id without also naming its resolving provider is ambiguous: two attempts labeled "gpt-5.4" can differ in vendor family, in pricing, in rate-limit posture, and in what a "cross-vendor" judge verdict actually verifies.

Additionally, `/runs/:id/live` — the SSE-driven Observatory view — is not discoverable from the Runs list or the Dashboard's Active Runs card. Operators must know the URL shape or navigate through the run-detail page.

### 1.2 Goal

1. Propagate the resolving **provider** for both generator attempts and judge verdicts end-to-end (wire → pilot persistence → server serializer → UI).
2. Render provider alongside model in every UI surface that currently shows a bare model id.
3. Expose `/runs/:id/live` from the Runs list and the Dashboard's Active Runs card.

### 1.3 Non-goals

- No `apiPaths` additions or renames.
- No breaking changes to existing wire types; **all wire changes are additive optionals**.
- No changes to provider-selection logic itself (`providerForModel`, judge selection, budget guardrails).
- No changes to how catalog `catalog.json` or generated `assets/catalog.json` are produced.
- No new SQLite tables; only additive `ADD COLUMN` operations consistent with the additive-only schema invariant.
- No visual redesign of run detail, Observatory, Runs list, or Dashboard — only the specific insertions/annotations named in §7.
- No retroactive backfill of `provider` / `judge_provider` on historical DB rows.

---

## 2. Definitions

- **Provider (a.k.a. `provider_id`)**: the fully-qualified provider id string as understood by `providerForModel` and the catalog, e.g. `azure-openai-responses`, `github-copilot`, `openai-codex`, `anthropic-messages`, `openrouter`.
- **Model (a.k.a. `model_id`)**: the catalog `model_id` string, e.g. `gpt-5.4`, `claude-sonnet-4.6`.
- **Vendor family**: the coarser bucket used by `VendorChip` (e.g. `openai`, `anthropic`, `google`). The wire contract does not change how vendor family is derived; the UI continues to derive it as it does today.
- **Attempt**: a single generator invocation within a stage. Persisted to the `attempts` table (or the equivalent used by `@pp/core`).
- **Verdict**: a single judge decision recorded against one attempt. Persisted to the `verdicts` table (or equivalent).
- **Historical row**: any attempt or verdict recorded before this feature is deployed, therefore having `NULL` for the new `provider` / `judge_provider` columns.
- **Present**: with respect to a wire field, "present" means the field key exists on the payload and its value is a non-empty string. "Absent" means the key is omitted (`undefined`). `null` and `""` are neither present nor absent per §4.3.
- **Same commit**: within a single git commit or a single squash-merged PR head commit — i.e. the versioned atom that lands on the default branch.

---

## 3. Scope

### 3.1 In scope

- `shared/api-types.ts` additive optionals on three SSE event shapes and two REST row shapes.
- `packages/pilot` stage loop: emit + persist `provider` on attempts; emit + persist `judge_provider` on verdicts.
- `packages/core` schema: additive `ADD COLUMN` for `attempts.provider` and `verdicts.judge_provider`.
- `packages/server` run-detail serializer: thread both columns into the REST response rows, and pass through the new SSE fields unchanged.
- `ui`: render `provider` on attempt cards, verdict banner, Observatory `AttemptMetaGrid` gen line + judge pairing line, and `GateFeed` gen/verdict detail lines; extend `AttemptMeta` in `liveRunStore.ts`; ingest new fields from SSE frames.
- `ui` Runs list: per-row live-view affordance for `running` and `queued`, present-but-unobtrusive for finished runs.
- `ui` Dashboard Active Runs card: per-row live link alongside the existing run-detail link.
- `ui` unit tests for `liveRunStore.ts` covering new-field capture + replay idempotency.

### 3.2 Out of scope

- Any change to `apiPaths` in `shared/api-types.ts`.
- Any new REST endpoint or SSE stream.
- Provider-selection algorithm changes.
- Retroactive backfill of `provider` / `judge_provider` on historical rows — historical rows MUST render cleanly without them (§7).
- Rebranding or redesign of `VendorChip`.
- Any change to gate rubrics or verdict semantics.

---

## 4. Wire contract changes (`shared/api-types.ts`)

### 4.1 SSE event shape additions

The following fields MUST be added to the payload `data` objects of the named SSE events. All additions are **optional** (`?:`) so historical replays and older publishers remain valid.

#### 4.1.1 `AttemptStartedEvent`

- `data.provider?: string` — the provider id resolved by `providerForModel` for the attempt's model, at the moment the attempt was launched.

#### 4.1.2 `AttemptCompletedEvent`

- `data.provider?: string` — MUST be the same provider id as the corresponding `AttemptStartedEvent` for that `attempt_id`. Emitted for reader convenience so a consumer that joined mid-run does not need to correlate to the `started` frame.

#### 4.1.3 `VerdictRecordedEvent`

- `data.judge_provider?: string` — the provider id resolved for the judge model that produced this verdict.

### 4.2 REST row shape additions (`GET /runs/:id`)

The run-detail response contains, per the current contract, an array-shaped attempt-row type (with `model`, `tokens_in`, `tokens_out`, `cost_usd`, etc.) and a verdict-row type. Both are extended:

#### 4.2.1 Attempt row (the `AttemptRow`-like shape)

- Add `provider?: string`.

#### 4.2.2 Verdict row

- Add `judge_provider?: string`.

### 4.3 Rules

- **REQ-W-1**: All four field additions MUST be optional (`?: string`). No existing field MUST be marked required in this change.
- **REQ-W-2**: No entry in `apiPaths` MUST be added, removed, or renamed. This change is types-only within `shared/api-types.ts`.
- **REQ-W-3**: `provider` and `judge_provider` MUST be strings when present. Empty string `""` MUST NOT be emitted; if the provider is unknown or unresolved, the field MUST be omitted from the payload entirely (see also §5.1 REQ-P-4 and §5.2 REQ-P-7). `null` MUST NOT be emitted.
- **REQ-W-4**: The `provider` string, when present, MUST be the exact provider id as returned by `providerForModel` and as recorded in the catalog (e.g. `github-copilot`), **without any UI-derived transformation** (no downcasing beyond what `providerForModel` returns, no label mapping, no whitespace trimming). No exception.
- **REQ-W-5**: When both `AttemptStartedEvent.data.provider` and `AttemptCompletedEvent.data.provider` are present for the same `attempt_id`, they MUST be equal (byte-for-byte string equality).
- **REQ-W-6**: The type additions in §4.1 and §4.2 MUST land in the same commit (per §2 definition) as the pilot emit changes (§5) and the server serializer changes (§6). Rationale: `shared/api-types.ts` is the wire contract per AGENTS.md, so emitters and types cannot drift across commits. No exception. Verified by AC-X-1.

### 4.4 Acceptance criteria

- **AC-W-1**: `pnpm -r build && pnpm -r typecheck` succeeds with the additive field declarations present.
- **AC-W-2**: A consumer written against the pre-change types compiles against the post-change types with no code changes. Structural check: all four field additions are optional (`?:`) and no existing field's required/optional status changes. Verified by inspection of the `shared/api-types.ts` diff during code review.
- **AC-W-3**: `apiPaths` has zero-line diff in this change. Verified by `git diff shared/api-types.ts` in code review showing no changed lines within the `apiPaths` object literal.
- **AC-W-4**: The `shared/api-types.ts` diff shows exactly four new optional string fields at the locations described in §4.1 and §4.2, and no other exported shape changes.

---

## 5. Pilot changes (`packages/pilot`)

### 5.1 Provider capture on attempts

In the stage loop, `genProvider` is already computed via `providerForModel` prior to the `attempt.started` emit.

- **REQ-P-1**: The pilot MUST include `provider: genProvider` on the `data` payload of the `attempt.started` SSE frame whenever `genProvider` is a non-empty string.
- **REQ-P-2**: The pilot MUST include `provider: genProvider` on the `data` payload of the `attempt.completed` SSE frame for the same attempt whenever `genProvider` is a non-empty string.
- **REQ-P-3**: The pilot MUST persist `genProvider` on the attempt record in the same write path that today stores `model`, `tokens_in`, `tokens_out`, and `cost_usd`. Persisted column name: `provider` on the `attempts` table (or the additive-column equivalent per §5.3).
- **REQ-P-4**: If `providerForModel` returns `undefined`, empty string, or otherwise non-string (defensive case; SHOULD NOT happen in practice for a launched attempt), the pilot MUST omit the field from both SSE frames, MUST persist `NULL` (not `""`), and SHOULD log a warning at `warn` level identifying the model id — except when the surrounding write path is already logging the same condition, to avoid duplicate log lines. The attempt itself MUST still be recorded.

### 5.2 Provider capture on verdicts

In the judge/verdict path, the judge model is already selected and its provider is known at emission time (via `providerForModel` on the judge model id).

- **REQ-P-5**: The pilot MUST include `judge_provider` on the `data` payload of every `verdict.recorded` SSE frame, using the provider id resolved for the judge model that produced the verdict, whenever that resolution yields a non-empty string.
- **REQ-P-6**: The pilot MUST persist `judge_provider` on the verdict record in the same write path that today stores the judge model. Persisted column name: `judge_provider` on the `verdicts` table (or the additive-column equivalent per §5.3).
- **REQ-P-7**: The same defensive rule as REQ-P-4 applies for the judge provider: if unresolvable, the field MUST be omitted from the emit, MUST be persisted as `NULL`, and SHOULD be logged as a warning — except when the surrounding write path is already logging the same condition.

### 5.3 Schema (`packages/core`)

Per the additive-only SQLite schema invariant.

- **REQ-P-8**: `packages/core` MUST add a guarded `ALTER TABLE attempts ADD COLUMN provider TEXT` (or the equivalent additive pattern used elsewhere in the schema module — `CREATE TABLE IF NOT EXISTS` at fresh init; conditional `ADD COLUMN` on existing DBs).
- **REQ-P-9**: `packages/core` MUST add the analogous guarded `ALTER TABLE verdicts ADD COLUMN judge_provider TEXT`.
- **REQ-P-10**: Both columns MUST be declared `TEXT` and MUST be nullable (no `NOT NULL`, no default), because historical rows will not have them.
- **REQ-P-11**: The migration MUST be idempotent: running it twice against the same DB MUST NOT error and MUST NOT change the schema on the second run.
- **REQ-P-12**: The migration MUST NOT drop, rename, or retype any existing column, and MUST NOT create any new table.

### 5.4 Acceptance criteria

- **AC-P-1**: A NEW run started against the changed pilot produces an `attempts` row with `provider` populated (non-null, non-empty string) for every attempt whose model resolves via `providerForModel`, and a `verdicts` row with `judge_provider` populated for every verdict whose judge model resolves. Verified by `packages/pilot` vitest.
- **AC-P-2**: A pre-existing DB from before this change, when opened by the new binary, gains the two columns via the additive migration on first open, without data loss; existing rows have `NULL` in both new columns. Verified by an integration test in `packages/core` that seeds a schema without the columns, opens it with the new code, and asserts (a) both columns exist and (b) prior rows still count and are still readable.
- **AC-P-3**: The pilot vitest suite (with `PP_SKIP_CLI_VERSIONS=1`) is green.
- **AC-P-4**: A test asserts that for a run where the resolved `genProvider` is `github-copilot` and the resolved judge provider is `anthropic-messages`, the persisted `attempts.provider` and `verdicts.judge_provider` match exactly (byte-for-byte string equality).
- **AC-P-5**: A test asserts that the `attempt.started` and `attempt.completed` frames for the same `attempt_id` carry the same `provider` string (REQ-W-5).
- **AC-P-6**: A test asserts that when `providerForModel` returns `undefined` for the generator or judge model in a mocked run, the corresponding SSE frame omits the field, the DB column is `NULL`, and a warning is logged. Verified in `packages/pilot` vitest with a mocked catalog.
- **AC-P-7**: Running the schema migration twice in succession against the same DB succeeds both times and yields the same `PRAGMA table_info(attempts)` and `PRAGMA table_info(verdicts)` output — verifying REQ-P-11.

---

## 6. Server serializer (`packages/server`)

### 6.1 Threading providers into REST

`GET /runs/:id` in `packages/server` serializes attempt and verdict rows from the DB into the wire shapes defined in `shared/api-types.ts`.

- **REQ-S-1**: The run-detail serializer MUST include `attempts[i].provider` in the response when the corresponding DB column is non-null and non-empty.
- **REQ-S-2**: The run-detail serializer MUST include `verdicts[i].judge_provider` in the response when the corresponding DB column is non-null and non-empty.
- **REQ-S-3**: When the DB column is `NULL` or empty (historical rows), the serializer MUST omit the field from the JSON payload (not emit `null`, not emit `""`). This matches the "optional, may be absent" contract in §4 (REQ-W-3) and lets the UI's absence check work uniformly across REST and SSE.
- **REQ-S-4**: No other field in the response MUST change shape. No new REST endpoint MUST be added.
- **REQ-S-5**: The server MUST NOT include any provider credentials, tokens, or secret material in the run-detail response. `provider` is a public catalog id (e.g. `github-copilot`), never a token. Verified by AC-S-2 (below) and by the pre-existing daemon secret scan (AGENTS.md hard rule on write-only provider keys).

### 6.2 SSE republishing

The server relays pilot SSE frames to clients on its two existing SSE streams.

- **REQ-S-6**: The server MUST pass through the new `provider` and `judge_provider` fields on `attempt.started`, `attempt.completed`, and `verdict.recorded` frames unchanged. No filtering, no renaming, no case transformation.

### 6.3 Acceptance criteria

- **AC-S-1**: A vitest in `packages/server` seeds one attempt with `provider = 'github-copilot'` and one attempt with `provider = NULL` (historical), calls the run-detail handler, and asserts (a) the first attempt row has `provider: 'github-copilot'`, (b) the second attempt row has no `provider` key at all (property-absence check, not `=== null` check).
- **AC-S-2**: The same test asserts no key on any response object in the payload matches `/token|secret|api[_-]?key/i`, reinforcing REQ-S-5.
- **AC-S-3**: An SSE pass-through test asserts that a pilot-emitted `attempt.started` frame carrying `data.provider = 'openai-codex'` is republished on the server's SSE stream with `data.provider = 'openai-codex'` unchanged.
- **AC-S-4**: `pnpm -r test` in `packages/server` is green.

---

## 7. UI changes (`ui`)

### 7.1 Rendering rules — provider display

- **REQ-U-1**: Every UI surface that currently displays a bare `model_id` from an attempt or verdict, and that also displays the vendor family via `VendorChip`, MUST render the resolving `provider` string on the same visual line as (or in the visual group with) the model id and `VendorChip`. "Same visual line or visual group" means within the same flex/inline row without an intervening block-level break at the browser's default typography scale. No exception; verified by AC-U-1.
- **REQ-U-2**: When `provider` is present on the row, it MUST be rendered as a distinct textual token adjacent to the `VendorChip`, using a `VendorChip` instance whose vendor derivation is applied to the provider id. Rationale: `VendorChip` already handles color and iconography per vendor family, so passing the provider id through the same derivation yields consistent styling.
- **REQ-U-3**: When `provider` is absent on the row (historical data), the UI MUST render the row without any placeholder text, dash-fill, "unknown" label, `null`/`undefined` string, or empty chip. Verified by AC-U-2.
- **REQ-U-4**: The UI MUST NOT alter or reformat the provider string (no case change, no punctuation transform); it MUST render it as received from the wire.

### 7.2 Run detail — attempt cards

The current attempt card renders a line composed of the vendor chip, model id, and a family label — schematically `[vendor-chip] · [model] · [family]` (e.g. `claude · claude-sonnet-4.6 · sonnet`).

- **REQ-U-5**: The attempt card MUST render the provider between the vendor chip and the model id, schematically `[vendor-chip] · [provider-chip] · [model] · [family]` (e.g. `claude · github-copilot · claude-sonnet-4.6 · sonnet`).
- **REQ-U-6**: The attempt card MUST hide the provider slot entirely when `provider` is absent (per REQ-U-3). No blank space MUST be reserved beyond normal flex/inline-gap collapsing.

### 7.3 Run detail — verdict banner

The verdict banner currently shows the judge model and a "cross-vendor" indicator.

- **REQ-U-7**: The verdict banner MUST render the judge provider adjacent to the judge model id whenever `judge_provider` is present on the verdict row.
- **REQ-U-8**: The banner MUST retain its existing "cross-vendor" indicator; the addition of `judge_provider` MUST NOT change the semantics of, or the derivation of, the cross-vendor flag.
- **REQ-U-9**: When `judge_provider` is absent, the banner MUST omit the provider annotation and MUST render exactly as it does today.

### 7.4 Observatory — `AttemptMetaGrid`

`AttemptMetaGrid` renders per-attempt meta rows: a "gen" line for the generator, and a "judge pairing" line for the judge.

- **REQ-U-10**: The gen line MUST render the provider alongside the model id when `provider` is present on the `AttemptMeta` object (see §7.7).
- **REQ-U-11**: The judge pairing line MUST render the judge provider alongside the judge model id when `judge_provider` is available for the verdict associated with the attempt.
- **REQ-U-12**: Both lines MUST omit the provider annotation when the corresponding field is absent, per REQ-U-3.

### 7.5 Observatory — `GateFeed`

`GateFeed` renders a chronological feed of gen and verdict events with a "detail" text line under each entry.

- **REQ-U-13**: The gen entry's detail text MUST include the provider when present. Rendering location within the detail line: adjacent to the model id (order MAY be provider-then-model or model-then-provider at implementation discretion, provided §7.1 REQ-U-1 is satisfied).
- **REQ-U-14**: The verdict entry's detail text MUST include the judge provider when present, adjacent to the judge model id.
- **REQ-U-15**: When either field is absent, the corresponding detail text MUST render without placeholder — same rule as REQ-U-3.

### 7.6 Runs list — live-view affordance

The Runs list page currently renders one row per run with a link to `/runs/:id`.

- **REQ-U-16**: For every run row whose `status` is `running` or `queued`, the Runs list MUST render an additional affordance on the row that navigates to `/runs/:id/live`. Affordance form MAY be a text link, an icon button, or a labeled button at implementation discretion, provided it is reachable by keyboard (`tab`-focusable, `Enter`-activatable) and has an accessible name of "Live" or "Live view" or equivalent (see REQ-U-19).
- **REQ-U-17**: For every run row whose `status` is any other value (finished / failed / cancelled / etc.), the Runs list MUST also expose the live-view affordance, because the `/runs/:id/live` route can replay past runs. This affordance MAY be styled less prominently (e.g. de-emphasized color, smaller icon) than the running/queued case, but it MUST remain keyboard-reachable and MUST have the same accessible name.
- **REQ-U-18**: The live-view affordance MUST NOT replace the existing link to `/runs/:id`. Both affordances MUST be present per row.
- **REQ-U-19**: The live-view affordance MUST have an accessible name (via visible text, `aria-label`, or `title`) that unambiguously identifies it as leading to the live view. Verified by AC-U-6.

### 7.7 Dashboard — Active Runs card

The Dashboard's Active Runs card renders per-row entries for currently-active runs, each already linking to `/runs/:id`.

- **REQ-U-20**: Each active-run row on the Dashboard's Active Runs card MUST expose a link to `/runs/:id/live` in addition to the existing link to `/runs/:id`. Both links MUST be present; the existing link MUST NOT be replaced or hidden.
- **REQ-U-21**: The added live link MUST have an accessible name per REQ-U-19.

### 7.8 `liveRunStore.ts` — SSE ingest

`liveRunStore.ts` maintains an `AttemptMeta` shape per attempt id and a `gateEvents` list.

- **REQ-U-22**: The `AttemptMeta` type MUST be extended with `provider?: string`.
- **REQ-U-23**: The store's `ingest()` MUST capture `data.provider` from `attempt.started` events into `AttemptMeta.provider` for the corresponding `attempt_id`.
- **REQ-U-24**: The store's `ingest()` MUST also capture `data.provider` from `attempt.completed` events into `AttemptMeta.provider`. If a value was already set by the `started` event, the value from `completed` MUST NOT overwrite it with a differing value; per REQ-W-5 the two MUST already be equal, so the second write is either a no-op or a redundant identical write.
- **REQ-U-25**: The store's `ingest()` MUST capture `data.judge_provider` from `verdict.recorded` events into the corresponding `gateEvents` entry's detail record (structural placement at implementer discretion, provided §7.5 REQ-U-14 can read it).
- **REQ-U-26**: When any of the three events lacks the new field, `ingest()` MUST leave the existing store value untouched (no writing `undefined`, no clearing an already-set value).

### 7.9 Acceptance criteria

- **AC-U-1**: In a new run started against the changed stack, the run-detail attempt card for an attempt whose `provider` is `github-copilot` renders the provider chip immediately adjacent to the vendor chip and model id per §7.2, with no intervening block-level break. Verified by a `ui` unit or integration test that mounts the attempt card with fixture data and asserts the DOM order and lack of block-level separators.
- **AC-U-2**: The same test mounts the attempt card with `provider` absent from the fixture and asserts there is no chip, no placeholder text, and no reserved empty slot in the rendered DOM.
- **AC-U-3**: In a new run, the verdict banner for a verdict with `judge_provider = 'anthropic-messages'` renders the judge provider adjacent to the judge model id; the "cross-vendor" indicator remains present and behaves as today. Verified by a `ui` test.
- **AC-U-4**: On the Observatory page, `AttemptMetaGrid` gen and judge-pairing lines render provider annotations when the corresponding fields are present in the fixture, and omit them cleanly when absent. Verified by `ui` tests.
- **AC-U-5**: `GateFeed` gen and verdict detail lines render provider annotations when present and omit them cleanly when absent. Verified by `ui` tests.
- **AC-U-6**: The Runs list renders a live-view affordance on every row (running, queued, and finished). Each affordance is keyboard-reachable (`tab`-focusable), activatable with `Enter`, has an accessible name matching `/live/i`, and navigates to `/runs/:id/live`. Verified by a `ui` unit test using Testing Library and one manual smoke check documented in the PR description (see §11 AC-X-3).
- **AC-U-7**: The Dashboard's Active Runs card renders both the existing `/runs/:id` link and a new `/runs/:id/live` link on every active-run row. Both are keyboard-reachable and named per REQ-U-19. Verified by a `ui` unit test.
- **AC-U-8**: A `liveRunStore.test.ts` case feeds a synthetic sequence — `run.started` → `attempt.started (attempt_id=a1, provider='github-copilot')` → `attempt.completed (attempt_id=a1, provider='github-copilot')` → `verdict.recorded (attempt_id=a1, judge_provider='anthropic-messages')` — and asserts:
    1. After the `attempt.started`, `store.attempts.a1.provider === 'github-copilot'`.
    2. After the `attempt.completed`, `store.attempts.a1.provider === 'github-copilot'` (unchanged, per REQ-U-24).
    3. After the `verdict.recorded`, the corresponding `gateEvents` entry carries `judge_provider === 'anthropic-messages'`.
    4. Feeding the same three frames a second time (replay idempotency) leaves the store byte-identical to the state after the first pass; verified by structural deep-equal.
- **AC-U-9**: A `liveRunStore.test.ts` case feeds the same sequence but with `provider` and `judge_provider` fields absent from the frames, and asserts (a) `store.attempts.a1.provider === undefined`, (b) the `gateEvents` entry has no `judge_provider` key or its `judge_provider === undefined`, (c) no exception is thrown. Verifies REQ-U-26 and REQ-U-3's data-shape prerequisite.

---

## 8. Cross-cutting rules

- **REQ-X-1**: The daemon secret-scan gate (pre-write, per the AGENTS.md hard rule on write-only keys) MUST continue to run on generated artifacts. Nothing in this feature MUST cause the scanner to be bypassed, weakened, or skipped.
- **REQ-X-2**: The pilot SHOULD NOT ship the provider id in an artifact filename or artifact body when doing so would leak information that isn't already public. `provider` is a public catalog id (e.g. `github-copilot`), so this is a defensive style rule rather than a security boundary — SHOULD, not MUST, with the explicit exception that artifact-content generators MAY reference the provider id if it materially aids debugging.
- **REQ-X-3**: The wire type change (§4), pilot emit change (§5), server serializer change (§6), and their supporting tests MUST all land in the same commit (per §2). The UI changes (§7) and their supporting tests MAY land in either the same commit or a strictly-subsequent commit on the same branch, at implementer discretion, because the UI code path degrades gracefully (REQ-U-3) if the backend hasn't shipped yet. Verified by AC-X-1.
- **REQ-X-4**: The additive SQLite migration (§5.3) MUST run at DB open on both new and existing databases, and MUST NOT block the daemon from starting if it succeeds. Verified by AC-P-7 (idempotency) plus AC-P-2 (open-existing-DB behavior).
- **REQ-X-5**: Neither the wire types, the pilot emits, the server serializer, nor the UI MUST emit or render any secret material (API keys, tokens, refresh tokens). `provider` is a public catalog id, never a credential. Verified by AC-S-2.
- **REQ-X-6**: For any run recorded after this change ships, replaying its SSE stream via the existing replay mechanism MUST produce the same UI state as observing the run live. Verified by AC-U-8's replay-idempotency step.

---

## 9. Acceptance-check consolidation

The following global gates apply to the entire change and are the shared exit criteria for the feature.

- **AC-X-1**: `pnpm -r build && pnpm -r typecheck && pnpm -r test` is green with `PP_SKIP_CLI_VERSIONS=1` set in the environment. This is the top-level gate per AGENTS.md ("must be green before a change is considered done"). Verifies REQ-X-3 by construction: if the types, emitters, and serializers are not in the same commit, typecheck fails.
- **AC-X-2**: A new end-to-end smoke run started against the changed stack shows provider chips on attempt cards in both `/runs/:id` (REST) and `/runs/:id/live` (SSE), and shows judge-provider annotations on the verdict banner in both views. Recorded manually in the PR description.
- **AC-X-3**: The Runs list and Dashboard live-view affordances resolve to a working `/runs/:id/live` in a manual smoke click. Recorded manually in the PR description; alternatively covered by AC-U-6 and AC-U-7 unit tests.
- **AC-X-4**: A run recorded before this change ships (loaded from an existing SQLite DB) renders in `/runs/:id` and `/runs/:id/live` with no placeholder text, no `undefined` strings, and no broken layout. Recorded manually in the PR description using at least one pre-existing DB row per AC-P-2.
- **AC-X-5**: `apiPaths` is byte-identical before and after this change. Verified by `git diff shared/api-types.ts` (referencing REQ-W-2 and AC-W-3).

---

## 10. Risks & mitigations

- **Risk:** Historical rows and mid-flight runs across a rolling deploy could produce mixed present/absent provider states in the UI. **Mitigation:** REQ-U-3 (omit cleanly when absent) applied uniformly; AC-U-2 and AC-X-4 verify.
- **Risk:** The additive migration fails on an existing DB with unusual schema drift. **Mitigation:** REQ-P-11 (idempotency) + AC-P-2 (open-existing-DB test) + AC-P-7 (double-run test).
- **Risk:** A future refactor makes the wire type additions required instead of optional, breaking historical replay. **Mitigation:** REQ-W-1 documented as normative; AC-W-2 makes structural regression detectable.
- **Risk:** The UI adds a live-view link that navigates to a route missing for some runs. **Mitigation:** The `/runs/:id/live` route already exists in `ui` today (this feature only adds discoverability), so no new route work is required; verified by manual smoke AC-X-3.

---

## 11. Open questions

- **Q-1:** For the Observatory `AttemptMetaGrid` judge-pairing line, does the provider annotation apply only to the elevated-gate cross-vendor case, or to all verdicts? **Resolution:** Applies to all verdicts uniformly (REQ-U-11); the cross-vendor case is separately indicated via the existing cross-vendor flag (REQ-U-8). No exception; if a design refinement later needs to differentiate, that MAY be handled in a follow-up spec.
- **Q-2:** For runs list rows with `status` values not covered by the running/queued/finished-family enumeration (e.g. a future `paused` state), is the live affordance present? **Resolution:** Yes, per REQ-U-17 the affordance is present on every row regardless of status; only the prominence styling MAY vary between "active-like" (running/queued) and "not-active-like" (everything else). No exception.
- **Q-3:** Should the persisted `provider` column be a foreign key into a providers table? **Resolution:** No. Providers are enumerated in the generated catalog (`assets/catalog.json`), not in SQLite. Adding a foreign key would violate the additive-only-schema invariant (would require a new table) and the "catalog files are generated" rule. `provider` remains a free-form `TEXT` column whose values are validated at emit time by `providerForModel`. No exception.

---

## 12. Change log

- **1.1.0** (revision responding to critique #1)
    - Sharpened REQ-W-3 to explicitly forbid both `null` and `""`, with a normative pointer to §5.1 REQ-P-4 / §5.2 REQ-P-7.
    - Removed subjective qualifier "without any UI-derived transformation" ambiguity by enumerating forbidden transforms in REQ-W-4 and marking it "no exception."
    - Added AC-W-3 verification method for the zero-diff `apiPaths` assertion (was implicit).
    - Added AC-P-6 to verify defensive omission when `providerForModel` returns undefined (was under-covered).
    - Added AC-P-7 to explicitly verify migration idempotency (REQ-P-11 previously had no direct AC).
    - Added AC-S-2 to verify REQ-S-5 (no-credentials-in-response) via a scanning assertion (previously had no direct AC).
    - Rewrote REQ-U-1 to define "same visual line or visual group" concretely (was "visually adjacent," which was ambiguous).
    - Added REQ-U-19 and REQ-U-21 to define accessible-name requirements on the new live-view affordances, with AC-U-6 verifying accessible name and keyboard reachability.
    - Downgraded former "SHOULD be visually less prominent" for finished-run live affordance to a `MAY` in REQ-U-17, since prominence is a design-taste call, not a testable requirement.
    - Rewrote REQ-X-2 to remove the `MUST NOT`/soft-requirement conflict flagged in critique: now correctly styled as SHOULD with an explicit named exception.
    - Added REQ-X-3 explicit statement about which changes MUST land in the same commit vs MAY land later, closing the gap flagged in critique for same-commit process requirements. AC-X-1 verifies via typecheck.
    - Added definition of "present" / "absent" / "same commit" to §2 to remove ambiguity in normative statements.
    - Added definition of "Historical row" in §2 to make REQ-U-3 and AC-P-2 unambiguous.
    - Downgraded former "MUST be visually prominent" (previously REQ-U-25 in draft 1.0.0) to descriptive language on affordance placement — the requirement is now "keyboard-reachable and named" (REQ-U-19), which is testable.
    - Removed "MUST remain within its current column budget" and "MUST remain within its current height/width envelope" phrasings (subjective) — replaced with concrete requirements REQ-U-6 (no reserved empty slot when absent) and REQ-U-18 / REQ-U-20 (both existing and new links present, existing not replaced), which are structurally testable.

- **1.0.0** — Initial draft.