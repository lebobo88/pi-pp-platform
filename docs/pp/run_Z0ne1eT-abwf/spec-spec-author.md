# Live Run Store — Observability Overlay Extension

- **RFC ID:** SPEC-LRSTORE-OBS-002
- **Kind:** feature-spec
- **Owner:** UI · Observability
- **Status:** Draft (target: implement now)
- **Scope (files this run):** `ui/src/stores/liveRunStore.ts` and its vitest suite `ui/src/stores/liveRunStore.test.ts` only. No other file MUST be created or modified.
- **Out of scope (this run):** `shared/api-types.ts`, `packages/server`, `packages/pilot`, `packages/core`, `packages/engine`, `packages/mcp-adapter`, `assets/**`, any other `ui/**` file.
- **Related wire contract (read-only for this run):** `shared/api-types.ts` — the store MUST import at least `RunPhase`, `AttemptStartedEvent`, `AttemptCompletedEvent`, and the existing SSE envelope type carrying `ev.ts` (ISO-8601 string) and `ev.seq` (nonnegative integer, monotonic and gap-free per `run_id`).

## 1. Purpose & Problem Statement

The live-run store is the single UI-side ingestion point for the server's per-run SSE stream. It MUST become the substrate the observability overlay renders: a phase timeline, a per-attempt metadata table, an append-only gate-event ring, a bounded cumulative cost series, and a last-event heartbeat. Because the server's SSE hub replays its ring buffer from `Last-Event-ID: 0` on reconnect, the store MUST also treat every observed frame as *potentially replayed* and dedupe on `ev.seq` (monotonic per run) rather than on wall-clock arrival.

This RFC is the normative specification for that extension. It is intentionally additive: every field and behavior already present on `LiveRunOverlay` (`status`, `stageStatus`, `stageWinner`, `attemptStatus`, `verdicts`, `borda`, `costUsd`, `tokensIn`, `tokensOut`, `version` bump, rAF-batched `notify()`, attempt `output` log buffering) MUST remain bit-identical from the perspective of existing consumers.

## 2. Definitions & References

- **RFC 2119** normative keywords apply (MUST / MUST NOT / SHOULD / SHOULD NOT / MAY).
- **Envelope** — every SSE frame received by the store carries at minimum `{ type, run_id, ts, seq, data }` at the envelope level, where `ts` is an ISO-8601 string and `seq` is a nonnegative integer that is monotonic and gap-free per `run_id` from the server ring buffer.
- **Overlay** — the immutable-per-`version` snapshot object returned by `getOverlay(runId)`; consumers subscribe via `subscribe(runId, cb)` and receive rAF-coalesced notifications.
- **Replay** — the SSE reconnect path in which the server re-emits every frame from seq 0 up to head; the store MUST render an identical overlay after replay as it did before disconnect.
- **Pending started-meta** — attempt metadata received on `attempt.started` that lacks an `attempt_id`; held at most one per `stage_id`, reconciled on the next `attempt.completed` for that stage.
- **Applied frame** — a frame that passed the §4.1 dedupe gate AND caused (or was permitted to cause) a state mutation.

## 3. Types (normative)

The following TypeScript types MUST be exported from `ui/src/stores/liveRunStore.ts` alongside the existing exports. Field names, optionality, and value domains are normative.

```ts
export type PhaseTimelineEntry = {
  phase: RunPhase;                     // from shared/api-types.ts
  startedAt: string;                   // ISO — the ev.ts of the first frame that observed this phase
  lastAt: string;                      // ISO — the ev.ts of the most recent frame observed for this phase
  status: 'active' | 'done';           // exactly one entry MUST have status 'active' while a run is live
  detail?: string;                     // human-readable one-liner distilled from frame data (see §5.1)
};

export type AttemptMeta = {
  attemptId: string;                   // canonical key; equals the map key in overlay.attempts
  stageId: string;
  agent?: string;
  model?: string;
  tier?: string;                       // e.g. 'econ' | 'mid' | 'flagship' as surfaced by the pilot
  retryIndex?: number;                 // 0 for the first attempt, 1 for Reflexion retry, etc.
  candidateIndex?: number;             // 0-based index within a multi-candidate stage
  seed?: number;
  startedAt?: string;                  // ev.ts of the attempt.started frame that produced this record
  completedAt?: string;                // ev.ts of the attempt.completed frame
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;                    // ABSOLUTE per-attempt cost; overwrite on each observation, never accumulate
  stopReason?: string;
  toolCallCount?: number;
  filesChanged?: number;
  materializedFiles?: number;
  zeroChange?: boolean;
  status: 'running' | 'ok';            // set to 'running' at started, 'ok' at completed
};

export type GateEventKind =
  | 'gen'
  | 'hook'
  | 'artifact'
  | 'judge'
  | 'verdict'
  | 'reflexion'
  | 'smoke'
  | 'validation'
  | 'missability'
  | 'borda'
  | 'surfaced';

export type GateEvent = {
  seq: number;                         // the envelope ev.seq of the source frame; stable ordering key
  at: string;                          // envelope ev.ts (ISO)
  kind: GateEventKind;
  stageId?: string;
  attemptId?: string;
  outcome?: string;                    // stable per kind (see §5.3)
  detail?: string;                     // short human string; MUST NOT contain secrets
};

export type LiveRunOverlay = {
  // --- existing fields (unchanged) ---
  runId: string;
  version: number;                     // bumped on any structural change; drives rAF-batched notify
  status: RunStatus;
  stageStatus: Record<string, StageStatusEntry>;
  stageWinner: Record<string, string | null>;
  attemptStatus: Record<string, AttemptStatusEntry>;
  attemptLog: Record<string, string[]>;
  verdicts: VerdictRecord[];
  borda: BordaRow[];
  costUsd: number;                     // cumulative run cost (unchanged semantics)
  tokensIn: number;
  tokensOut: number;

  // --- new observability fields (this RFC) ---
  phaseTimeline: PhaseTimelineEntry[];
  attempts: Record<string, AttemptMeta>;
  gateEvents: GateEvent[];             // append-only ring, cap 200 (see §5.3)
  costSeries: number[];                // cap 120 (see §5.4)
  lastEventTs: string | null;          // updated from every applied frame's ev.ts
  lastAppliedSeq: number;              // highest ev.seq successfully applied; -1 sentinel means nothing seen
};
```

Existing type names (`RunStatus`, `StageStatusEntry`, `AttemptStatusEntry`, `VerdictRecord`, `BordaRow`) are those already exported by the current `liveRunStore.ts`; this RFC MUST NOT rename or repurpose them.

## 4. Replay Idempotency (core invariant)

### 4.1 Dedupe gate

- The store MUST maintain a per-run `lastAppliedSeq: number`.
- On every ingested frame, the store MUST inspect `ev.seq` FIRST, before any other mutation, log append, or version bump.
- If `ev.seq` is a finite nonnegative integer AND `ev.seq <= lastAppliedSeq`, the frame MUST be ignored entirely: no field update, no version bump, no notify, no log-line append, no `lastEventTs` update, no `costSeries` push.
- If the frame is applied, the store MUST update `lastAppliedSeq = max(lastAppliedSeq, ev.seq)` as part of the same synchronous mutation batch as the rest of the frame's effects.
- Frames whose `ev.seq` is missing or is not a finite nonnegative integer MUST be applied but MUST NOT change `lastAppliedSeq`. This is a defensive concession for test doubles and transitional server builds; it MUST NOT be relied on by production senders.

### 4.2 Initial value

- On store creation for a new `runId`, `lastAppliedSeq` MUST be initialized to `-1` so that the very first legitimate frame (`ev.seq === 0`) passes the dedupe gate.

### 4.3 Consequences (informative, non-normative)

Because §4.1 removes replayed frames before any mutation, cumulative counters that come from server-side aggregation (`overlay.costUsd`, `costSeries` samples from run-scoped `budget.tick`, per-attempt `costUsd`, `tokensIn`, `tokensOut`) can be implemented with plain absolute assignment: a replayed seq is by definition `<= lastAppliedSeq` and never reaches the assignment site.

## 5. Ingestion Semantics

The store MUST recognize the following envelope types and MUST update overlay state exactly as specified. Any envelope type not listed here that is already handled by the current `liveRunStore.ts` MUST continue to behave exactly as it does today (see §6).

### 5.1 `run.context` → `phaseTimeline`

The authoritative phase MUST be read from `data.phase` (typed as `RunPhase` in `shared/api-types.ts`).

Behavior on an applied frame:

1. If `phaseTimeline` is empty, append `{ phase: data.phase, startedAt: ev.ts, lastAt: ev.ts, status: 'active', detail: distill(data) }`.
2. Else if the last entry's `phase === data.phase`, mutate the last entry in place: `lastAt = ev.ts`; if `distill(data)` returns a non-empty string, replace `detail` with it.
3. Else (phase transition): set every existing entry whose `status !== 'done'` to `status = 'done'` and set the immediately preceding entry's `lastAt = ev.ts`, then append `{ phase: data.phase, startedAt: ev.ts, lastAt: ev.ts, status: 'active', detail: distill(data) }`.

Additional invariants:

- The store MUST guarantee that at most one entry has `status === 'active'` at any time.
- On terminal envelopes (`run.completed`, `run.failed`, `run.canceled`), the store MUST mark every entry in `phaseTimeline` with `status = 'done'` and MUST set the last entry's `lastAt = ev.ts`.
- `distill(data)` MUST produce a string of length `<= 120` characters, derived only from one or more of `data.stage_id`, `data.stage_title`, `data.note`, `data.summary`. `distill(data)` MUST NOT include token counts, cost figures, absolute filesystem paths, provider API keys, or any field name that begins with `key_` or ends with `_secret`. If no source field is present, `distill(data)` MUST return `undefined` and the store MUST leave `detail` unset (do not blank an existing detail).

### 5.2 `attempt.started` / `attempt.completed` / `attempt.output` → `attempts`

- **`attempt.started`:**
  - If `data.attempt_id` is a non-empty string, upsert `attempts[data.attempt_id]` with fields from the frame: `stageId = data.stage_id`, and any of `agent`, `model`, `tier`, `retryIndex`, `candidateIndex`, `seed` present in `data`; set `startedAt = ev.ts` and `status = 'running'`.
  - If `data.attempt_id` is absent or empty, the store MUST retain a *pending started-meta* record for `data.stage_id`. The pending slot MUST hold at most one record per `stage_id`; a second pending record for the same stage MUST replace the previous one (last-writer-wins). Pending records MUST NOT be visible in `overlay.attempts`.
- **`attempt.completed`:**
  - Let `aid = data.attempt_id` (the wire contract requires this field on completion).
  - If a pending started-meta exists for `data.stage_id`, merge it into the new `AttemptMeta` first (populating `agent`, `model`, `tier`, `retryIndex`, `candidateIndex`, `seed`, `startedAt` from the pending record), then apply completion fields; clear the pending slot for that stage after merge.
  - Upsert `attempts[aid]` with completion fields: `completedAt = ev.ts`, `tokensIn`, `tokensOut`, `costUsd` (absolute overwrite — the store MUST NOT use `+=`), `stopReason`, `toolCallCount`, `filesChanged`, `materializedFiles`, `zeroChange`, `status = 'ok'`.
- **`attempt.output`:**
  - The store MUST append `data.line` (or whichever field the current implementation already consumes for output text) to `attemptLog[data.attempt_id]`, exactly as it does today, but only after the §4.1 dedupe gate has passed. This append MUST be seq-guarded so that a replay MUST NOT duplicate log lines.
  - Existing behavior for the log buffer (line trimming, per-attempt cap, ordering) MUST be preserved unchanged.

### 5.3 Gate events → `gateEvents` (append-only ring, cap 200)

For each envelope type listed below, the store MUST, on an applied frame, append exactly one `GateEvent` to `gateEvents` with `seq = ev.seq, at = ev.ts`, populate the remaining fields as specified, and then trim from the head until `gateEvents.length <= 200`.

| Envelope type            | `kind`         | `stageId`        | `attemptId`         | `outcome`                              | `detail`                                                        |
|--------------------------|----------------|------------------|---------------------|----------------------------------------|-----------------------------------------------------------------|
| `attempt.started`        | `gen`          | `data.stage_id`  | `data.attempt_id?`  | `'started'`                            | model/tier if present (e.g. `` `${model} · ${tier}` ``)         |
| `attempt.completed`      | `gen`          | `data.stage_id`  | `data.attempt_id`   | `'ok'`                                 | tokens/stop_reason (e.g. `` `in=${tokensIn} out=${tokensOut} stop=${stopReason}` ``, omit empties) |
| `verdict.recorded`       | `verdict`      | `data.stage_id`  | `data.attempt_id?`  | `data.verdict`                         | judge model + `cross_vendor` (e.g. `` `judge=${judge_model} cross=${cross_vendor}` ``) |
| `reflexion.retry`        | `reflexion`    | `data.stage_id`  | `data.attempt_id?`  | `'retry'`                              | tier escalation + short critique excerpt (see §5.3.1)           |
| `smoke.status`           | `smoke`        | `data.stage_id?` | `data.attempt_id?`  | `data.status`                          | short reason if present                                         |
| `validation.result`      | `validation`   | `data.stage_id?` | `data.attempt_id?`  | `data.result` (`pass`/`fail`/…)        | short reason if present                                         |
| `missability.result`     | `missability`  | `data.stage_id?` | `data.attempt_id?`  | `data.result`                          | short reason if present                                         |
| `borda.updated`          | `borda`        | `data.stage_id?` | —                   | `'updated'`                            | leader if surfaceable (e.g. `` `winner=${top_attempt_id}` ``)   |
| `stage.surfaced`         | `surfaced`     | `data.stage_id`  | `data.attempt_id?`  | `'surfaced'`                           | `data.reason` if present                                        |

Additional rules:

- `kind` values `hook` and `artifact` MUST be part of the exported `GateEventKind` union so that future frame types can be added without changing the union. The store MUST NOT emit them in this RFC unless a corresponding envelope type is already handled by the current `liveRunStore.ts`; in that case, ingestion MUST be preserved bit-identical and MUST also be mirrored as a `GateEvent` of the matching kind. If no such envelope type is currently handled, the store MUST NOT emit any `hook` or `artifact` gate event in this run.
- The ring MUST be trimmed by dropping oldest entries (i.e. `gateEvents = gateEvents.slice(gateEvents.length - 200)` semantics) after each append.
- `detail` MUST be `<= 200` characters and MUST NOT include any provider API key material.

#### 5.3.1 Reflexion critique excerpts

- The store MUST truncate the critique excerpt included in the `reflexion` gate event's `detail` field to `<= 160` characters (unicode code-point length). If truncation occurs, the store MUST suffix the truncated string with the single ellipsis character `…` (U+2026), and the combined string length including the ellipsis MUST still be `<= 160` characters.

### 5.4 `budget.tick` → `costSeries` and `costUsd`

The store MUST distinguish run-scoped ticks from stage-scoped ticks:

- A `budget.tick` frame is **run-scoped** iff it does NOT carry a truthy `data.stage_id`. Only run-scoped ticks MUST update `overlay.costUsd` and MUST push to `costSeries`.
- A `budget.tick` frame that carries a truthy `data.stage_id` is **stage-scoped**. Stage-scoped ticks MUST NOT push to `costSeries` and MUST NOT overwrite `overlay.costUsd`. Their handling in existing overlay fields (if any — e.g. per-stage cost tallies) MUST be preserved bit-identical.
- On an applied run-scoped tick, the store MUST assign `overlay.costUsd = data.cost_usd` (absolute overwrite; the store MUST NOT use `+=`) and MUST append `data.cost_usd` to `costSeries`, then trim from the head until `costSeries.length <= 120`.
- `costSeries` MUST accept any finite nonnegative number, including zero and repeated values. It MUST NOT filter based on monotonicity (that is the server's invariant; the client trusts it under §4).

### 5.5 `lastEventTs`

- On every applied frame (i.e. every frame that passes the §4.1 dedupe gate), the store MUST set `overlay.lastEventTs = ev.ts`.
- This includes all envelope types recognized by this RFC AND every envelope type already handled by the existing `liveRunStore.ts` (whose behavior is otherwise unchanged per §6).
- `lastEventTs` MUST be `null` for a freshly created overlay that has not yet applied any frame.

### 5.6 rAF-batched notify

- The store MUST bump `overlay.version` and schedule a rAF-coalesced `notify()` exactly when it does today: once per rAF tick per `runId` on which at least one applied frame produced a state change during that tick. The additive fields introduced by this RFC MUST participate in the same batching regime; no new synchronous notify path MUST be introduced.

## 6. Preserved Behavior (non-regression)

The following pre-existing overlay fields, ingestion paths, and consumer-facing APIs MUST NOT be renamed, retyped, or reordered by this RFC:

- `runId`, `version`, `status`, `stageStatus`, `stageWinner`, `attemptStatus`, `attemptLog`, `verdicts`, `borda`, `costUsd`, `tokensIn`, `tokensOut`.
- `subscribe(runId, cb)`, `getOverlay(runId)`, `ingest(runId, envelope)` (or whatever the current public ingestion function is named — the store MUST keep the same public export names and signatures).
- rAF-coalesced notify semantics, including the existing rules for when `version` is bumped.
- The current `attemptLog` line-buffer trimming/cap behavior.
- Existing `verdicts` and `borda` accumulation rules on `verdict.recorded` and `borda.updated`, which MUST continue to run in parallel with the new `gateEvents` emission for those frames.

## 7. Testing (vitest, `ui/src/stores/liveRunStore.test.ts`)

All acceptance tests specified in §8 MUST be implemented in `ui/src/stores/liveRunStore.test.ts` using the existing `ui` vitest configuration. Tests MUST use fixed ISO timestamps for `ev.ts` and explicit integer `ev.seq` values; tests MUST NOT rely on `Date.now()`, `performance.now()`, or the current wall clock for any assertion. Where `notify()` batching would otherwise delay observation, tests MUST assert on `getOverlay(runId)` state synchronously after ingestion (which reflects the current mutation regardless of rAF), OR MUST use an explicit rAF flush helper if the current store already provides one.

## 8. Acceptance Criteria (each item is a normative acceptance test)

Every AC below MUST be a passing vitest case in `ui/src/stores/liveRunStore.test.ts`, using a fresh store instance per test and a fresh `runId` per test unless the AC explicitly requires shared state across ingestions.

- **AC-1 · Replay idempotency (composite).** Build the following applied frame sequence in seq order, with distinct fixed ISO timestamps: (a) `run.started` seq=0; (b) `run.context` seq=1 with `phase = 'triage'`; (c) `run.context` seq=2 with `phase = 'stage_loop'`; (d) `attempt.started` seq=3 for `stage_id = 'S1'`, `attempt_id = 'A1'`, with `model` and `tier` populated; (e) `attempt.output` seq=4 for `attempt_id = 'A1'` with a fixed line; (f) `budget.tick` seq=5 run-scoped with `cost_usd = 0.10`; (g) `budget.tick` seq=6 run-scoped with `cost_usd = 0.25`; (h) `budget.tick` seq=7 run-scoped with `cost_usd = 0.40`; (i) `verdict.recorded` seq=8 for `stage_id = 'S1'`, `attempt_id = 'A1'`, `verdict = 'winner'`; (j) `reflexion.retry` seq=9 for `stage_id = 'S1'`, `attempt_id = 'A1'`; (k) `attempt.completed` seq=10 for `attempt_id = 'A1'` with `tokens_in`, `tokens_out`, `cost_usd`, `stop_reason` populated; (l) `stage.surfaced` seq=11 for `stage_id = 'S1'`. Ingest the whole sequence once and snapshot: `costUsd`, `costSeries` (length and contents), `gateEvents.length`, `attempts` map, `attemptLog['A1']` length, `phaseTimeline` length, `lastAppliedSeq`, `lastEventTs`. Ingest the *same* sequence again in the same seq order. Assert every snapshotted field is deep-equal to its pre-replay value and, in particular, `attemptLog['A1'].length` did NOT double.

- **AC-2 · `lastAppliedSeq` monotonicity.** After AC-1's first-pass ingestion, `overlay.lastAppliedSeq` MUST equal `11`. After the replay pass, it MUST still equal `11`.

- **AC-3 · `lastEventTs` updates on every applied frame.** After ingesting frames seq=0…3 from AC-1, `overlay.lastEventTs` MUST equal the `ev.ts` of the seq=3 frame. After a replayed seq=3, `overlay.lastEventTs` MUST NOT change.

- **AC-4 · Missing / non-numeric `ev.seq`.** Ingest a frame with `ev.seq = undefined` (and a valid `ev.ts`) followed by a frame with `ev.seq = 5`. Both MUST be applied. `overlay.lastAppliedSeq` MUST equal `5` (the undefined-seq frame MUST NOT lower it below its prior value; if this is the first frame ever, `lastAppliedSeq` MUST remain `-1` after the undefined-seq frame and become `5` only after the seq=5 frame).

- **AC-5 · Phase timeline dedupe.** Ingest `run.context` frames with phases `['triage', 'triage', 'stage_loop']` in seq order. Assert `phaseTimeline.length === 2`, `phaseTimeline[0].phase === 'triage'`, `phaseTimeline[0].status === 'done'`, `phaseTimeline[0].lastAt === ev.ts of the second frame` (not the first), `phaseTimeline[1].phase === 'stage_loop'`, `phaseTimeline[1].status === 'active'`.

- **AC-6 · At most one active phase entry.** After any sequence of `run.context` frames, `phaseTimeline.filter(e => e.status === 'active').length` MUST be exactly `0` (before the first `run.context`) or `1` (after any `run.context` on a non-terminated run).

- **AC-7 · Terminal frames close the timeline.** After ingesting `run.context` with `phase = 'stage_loop'` followed by `run.completed`, `phaseTimeline[phaseTimeline.length - 1].status` MUST equal `'done'` and its `lastAt` MUST equal the `ev.ts` of the `run.completed` frame.

- **AC-8 · `distill` bounds.** Ingest a `run.context` frame whose `data.note` is a 500-character string. The resulting `phaseTimeline[…].detail` MUST have length `<= 120`. Ingest a `run.context` frame whose `data.note` mentions a plausibly secret-looking substring matching `/[A-Za-z0-9_-]{32,}/` prefixed with `key_`; assert `detail` does NOT contain that substring. Ingest a `run.context` frame with none of `stage_id`, `stage_title`, `note`, `summary` present after an earlier frame that set a `detail`; assert `detail` on the current phase entry is unchanged.

- **AC-9 · Pending started-meta reconciliation.** Ingest `attempt.started` for `stage_id = 'S1'` with NO `attempt_id`, `model = 'M'`, `tier = 'econ'`, `startedAt = ev.ts = T1`. Assert `overlay.attempts` is empty. Then ingest `attempt.completed` for `stage_id = 'S1'`, `attempt_id = 'A9'`, `cost_usd = 0.5`. Assert `overlay.attempts['A9']` exists with `model === 'M'`, `tier === 'econ'`, `startedAt === T1`, `completedAt === the completion ev.ts`, `costUsd === 0.5`, `status === 'ok'`.

- **AC-10 · Pending slot is per-stage and last-writer-wins.** Ingest two `attempt.started` frames both without `attempt_id`, both for `stage_id = 'S1'`, with different `model` fields. Then ingest `attempt.completed` for `stage_id = 'S1'`, `attempt_id = 'AX'`. Assert `overlay.attempts['AX'].model` equals the model from the *second* pending started-meta.

- **AC-11 · Absolute per-attempt cost.** Ingest `attempt.completed` for `attempt_id = 'A1'` with `cost_usd = 0.10`. Then ingest another `attempt.completed` for `attempt_id = 'A1'` with `cost_usd = 0.07` and a strictly greater `ev.seq`. Assert `overlay.attempts['A1'].costUsd === 0.07`. (The value MUST have been overwritten, not accumulated.)

- **AC-12 · `gateEvents` ring cap 200.** Ingest 250 distinct `verdict.recorded` frames with strictly increasing `ev.seq`. Assert `overlay.gateEvents.length === 200`, `overlay.gateEvents[0].seq === 50` (the 51st frame; the first 50 were dropped from the head), and `overlay.gateEvents[199].seq === 249`.

- **AC-13 · `costSeries` cap 120 and absolute values.** Ingest 150 run-scoped `budget.tick` frames with strictly increasing `ev.seq` and cumulative `cost_usd` values `[0.01, 0.02, …, 1.50]` in strict order. Assert `overlay.costSeries.length === 120`, `overlay.costSeries[0] === 0.31` (the 31st tick's value; the first 30 samples were dropped from the head), `overlay.costSeries[119] === 1.50`, and `overlay.costUsd === 1.50`.

- **AC-14 · Replayed lower cost is ignored.** Ingest `budget.tick` seq=100 run-scoped `cost_usd = 5.00`. Then ingest `budget.tick` seq=50 run-scoped `cost_usd = 1.00`. Assert `overlay.costUsd === 5.00`, `overlay.costSeries[overlay.costSeries.length - 1] === 5.00`, and no new sample was appended for the replayed frame.

- **AC-15 · Stage-scoped `budget.tick` does NOT push to `costSeries`.** Ingest `budget.tick` with `data.stage_id = 'S1'` and `cost_usd = 2.00`. Assert `overlay.costSeries` is unchanged from its pre-ingest length and `overlay.costUsd` is unchanged from its pre-ingest value.

- **AC-16 · Gate-event mapping table.** For each row in the §5.3 table, ingest exactly one frame of that envelope type with representative `data` and assert (i) exactly one `GateEvent` was appended, (ii) its `kind` matches the row, (iii) `seq` and `at` come from the envelope, (iv) `stageId` / `attemptId` / `outcome` are populated exactly as the row specifies, and (v) for `reflexion.retry` with a 500-character critique, `detail` has length `<= 160` (including the trailing ellipsis if truncation occurred).

- **AC-17 · `attempt.started` and `attempt.completed` also emit `gen` gate events.** Ingest `attempt.started` seq=1 and `attempt.completed` seq=2 for the same `attempt_id`. Assert `overlay.gateEvents.length === 2`, both entries have `kind === 'gen'`, and their `outcome` fields are `'started'` and `'ok'` respectively.

- **AC-18 · Existing consumer contract preserved.** In one test, ingest the full AC-1 sequence and assert that the following fields are all present, correctly typed, and non-empty where expected: `overlay.status`, `overlay.stageStatus`, `overlay.stageWinner`, `overlay.attemptStatus`, `overlay.attemptLog['A1']`, `overlay.verdicts`, `overlay.borda`, `overlay.costUsd`, `overlay.tokensIn`, `overlay.tokensOut`. This test acts as a smoke test that additive extension did not break the pre-existing overlay shape.

- **AC-19 · `version` bumps at most once per applied frame per rAF tick.** After ingesting the AC-1 first-pass sequence, `overlay.version` MUST have increased from its initial value by at least `1` and by at most `12` (the number of applied frames in AC-1). After the AC-1 replay pass, `overlay.version` MUST NOT increase further.

- **AC-20 · Build / typecheck / test gates.** `pnpm -r build`, `pnpm -r typecheck`, and `PP_SKIP_CLI_VERSIONS=1 pnpm -r test` MUST all exit `0` on a clean tree that contains only the two in-scope files' edits. This AC MUST be verified in the PR that lands this RFC; individual vitest cases MUST NOT depend on running from outside `ui/`.

## 9. Non-Requirements (informative)

- This RFC does not add any new envelope types to the wire contract. If a listed frame type does not yet exist in `shared/api-types.ts`, the store MUST handle it lazily (i.e. type-guard `data` before reading fields) and MUST NOT crash on absence. Adding those envelope types to the wire contract is out of scope for this run.
- This RFC does not specify UI rendering. Component-level rendering of `phaseTimeline`, `attempts`, `gateEvents`, `costSeries`, or `lastEventTs` is out of scope for this run and MAY be added in a follow-up.
- This RFC does not change existing SQLite schema, server endpoints, pilot phases, engine adapters, or catalog files.