# Handoff — Provider-scoped model dropdown + Run Observability module

Pick-up doc for a fresh session. Two deliverables in the `ui/` React SPA (Vite +
Tailwind v4, TanStack Query + zustand) plus additive `shared/api-types.ts`
changes. Nothing has landed in the repo yet — everything below is the plan and
the task list. Full design rationale also lives in
`~/.claude/plans/on-the-providers-typed-pizza.md`.

Execution routes through Hydra (`/hydra:run`, engineering squad → pair-programmer)
in tightly-scoped, per-phase runs; validate each phase in Chrome before the next.

---

## Deliverable 1 — Provider-scoped model dropdown (small)

**Problem:** On Providers & Models, the generation-ladder and judge-pool model
inputs autocomplete against a shared `<datalist>` that mixes each *configured*
provider's live model list (correctly scoped) **and** the entire priced catalog
across ALL vendors (unscoped) — so unconfigured providers' models leak into the
dropdowns. We want only **configured + available** providers' models.

**File:** `ui/src/features/providers/ProvidersPage.tsx` → `SettingsPanel` (~line 219).

1. The datalist (~line 278) emits `models.map(...)` unconditionally. Add
   `const configuredVendors = useMemo(() => new Set(configuredVendorList), [configuredVendorList])`
   and change the catalog emission to
   `models.filter((m) => configuredVendors.has(m.vendor)).map(...)`. Leave the
   sibling `<ProviderModelOptions>` source (already scoped).
2. The judge input already validates unknown ids via `vendorFor()` + `toast`
   (~lines 258-261). Apply the same check to the **ladder** input (~lines
   299-309) — surface an error toast on an unknown/unconfigured id **on blur**,
   do not block typing.

**Reuse (already in the file):** `configuredVendorList`, `vendorFor`, `toast`,
`Pill`. No new API calls or types.

---

## Deliverable 2 — Run Observability module (phased)

Today the UI shows run *status* + final results but nothing live. Rich SSE events
already flow (pilot → server bus → UI) but `liveRunStore.ingest()` discards most
as "version bump only". Surface them in two new surfaces:
- **Run Observatory** — full-screen per-run live view at `/runs/:runId/live`.
- **Mission Control** — global fleet dashboard at `/observability`.

### Verified facts (drive the design)
- `ingest(runId, ev)` receives the **full SSE frame envelope** — `ev.ts` (ISO)
  and `ev.seq` (monotonic) are already present. Timestamps come free; no
  `Date.now()` in the store. (`ui/src/api/sse.ts` `handleFrame`,
  `ui/src/stores/useRunStream.ts`.)
- `budget.tick.cost_usd` is **cumulative** (server emits `budgetStatus(run:<id>)`),
  so the overlay's absolute assignment is replay-safe. Per-attempt `cost_usd`
  must be keyed by `attempt_id` (overwrite), never `+=`.
- Append-only structures must **dedupe by `ev.seq`** — reconnect replays the ring
  buffer (`initialLastEventId:"0"`). #1 correctness risk.
- The **global** SSE stream carries only `run.created/status/finalized` +
  `budget.tripwire` — NOT per-run stage/attempt/cost. Fleet view = global stream
  + polled `useRuns({status})`, not N per-run EventSources (browser ~6-conn cap).

### Phase 0 — Wire contract (`shared/api-types.ts`, ADDITIVE only; types + apiPaths together)
- `AttemptCompletedEvent` (~line 1045): add `stop_reason?`, `tool_call_count?`,
  `files_changed?`, `materialized_files?`, `zero_change?`.
- `AttemptStartedEvent` (~line 1037): add `attempt_id?`, `candidate_index?`, `seed?`.
- `RunContextEvent` (~line 1021): `export type RunPhase = "triage" | "profile" |
  "taxonomy" | "tier-resolve" | "skills" | "artifact-promotion" | "master-plan" |
  "autogenesis" | "best-of-merge" | (string & {})`; type `phase` as `RunPhase`,
  keep the index signature.
- Doc-comment `budget.tick` cost as cumulative.
- Check `packages/pilot/src/phases/stage-loop.ts` (~line 309): if `attempt.started`
  lacks `attempt_id` and it's trivially additive, emit it engine-side; else just
  widen the type and stage-key the pending AttemptMeta, reconcile on completion.

### Phase 1 — Live store (`ui/src/stores/liveRunStore.ts`) — the core
Extend `LiveRunOverlay` (ring-cap the append-only structures):
- `phaseTimeline: PhaseTimelineEntry[]` — `{ phase, startedAt, lastAt,
  status:"active"|"done", detail }`, de-duped by phase.
- `attempts: Record<string, AttemptMeta>` — rich per-attempt (model/tier/tokens/
  cost/stop_reason/tool_call_count/files_changed/zero_change/retry_index/started+
  completed ts).
- `gateEvents: GateEvent[]` — append-only, **cap 200**, `{ seq, at, kind:
  gen|hook|artifact|verdict|reflexion|smoke|validation|missability|borda|surfaced,
  stageId?, attemptId?, outcome?, detail? }`.
- `costSeries: number[]` — from `budget.tick`, **cap 120**.
- `lastEventTs`, `lastAppliedSeq` (per-run) for liveness + seq-dedupe.

Update `ingest()` to capture: `run.context`→phase upsert; `attempt.started`/
`attempt.completed`→`attempts` merge; `reflexion.retry`/`smoke.status`/
`validation.result`/`missability.result`/`borda.updated`/`stage.surfaced`→push
`GateEvent` (seq-deduped); `budget.tick`→absolute assign + push `costSeries`.
Add unit tests asserting **replay idempotency** (re-ingesting the ring buffer
does not double-count cost or duplicate gate events).

### Phase 2 — Run Observatory (`/runs/:runId/live`)
New `ui/src/features/observability/`: `RunObservatoryPage.tsx` (uses
`useRunStream` + `useLiveRunOverlay` + `useRun` + `useCaps`), `PhaseTimeline.tsx`,
`AttemptMetaGrid.tsx`, `GateFeed.tsx`. Register lazy route in `ui/src/App.tsx`,
add a "Live" link in `RunHeader.tsx`, nav entry in `ui/src/layout/navConfig.tsx`
+ icon in `ui/src/components/icons.tsx`. Use the `frontend-design` skill for a
distinctive instrument-panel look.

Signal → component: phase/stage timeline → `PhaseTimeline` + `StagePipeline`;
live output → existing `LogPane attemptId=`; cost/tokens/budget → `Meter` (cost
vs cap, ticks .8/1.0) + `Sparkline`(costSeries); judging/gates → `GateFeed` +
existing `BestOfBoard`.

### Phase 3 — Mission Control (`/observability`)
New `ui/src/stores/fleetStore.ts` + `useFleet.ts` (vanilla store keyed by run_id
`{status, costUsd, phase?, lastTs}`); extend `ui/src/api/GlobalEvents.tsx` to push
`run.created/status/finalized` + `budget.tripwire` into it. `MissionControlPage.tsx`
= grid of `FleetRunCard`, driven by `useFleet()` + `useRuns({status:running|
surfaced|pending})` with `refetchInterval` ~5s. `FleetRunCard.tsx` → click to
`/runs/:id/live`. Register route + top-level nav.

### Phase 4 — optional gate-history endpoint (defer)
`tdd_checks`/`artifact_validations` have no REST surface; live runs get them via
SSE (+ replay). Only if finished-run gate history is needed: additive
`GET /api/v1/runs/:id/gates` → `RunGateReport` (`packages/server/src/routes/runs.ts`
+ `apiPaths.runGates` + type, moved together).

---

## Design-derived enhancements (adopted — from the "PP Operator Console" design)

Reference: claude.ai design project `74c24807-67a0-44b0-8602-aa7a3dd376b1`
("AI Coding Harness UI"), file `PP Operator Console.dc.html` + `pp-mock-data.js`.
Visual language (IBM Plex, oklch dark, amber accent, `pp-pulse`) already matches
the existing tokens.

1. **Event Feed panel** (Phase 2) — broaden `GateFeed` into a first-class typed
   live narration stream: `gen | hook | artifact | judge | pass | stage | check`
   (e.g. "verdict PASS · code_style · gemini · mutex release verified";
   "tdd_checks: post run · 14 passed / 0 failed · verified"). Requires adding
   `gen`/`hook`/`artifact` to `GateEvent.kind` in Phase 1.
2. **Loop-ceiling meter** (Phases 2 + 3) — model `loopCalls/loopCeiling` (e.g.
   4/6, the Reflexion/validator-loop budget). `Meter` on the Observatory + each
   fleet card; source from the `loop_ceiling_status` pp tool and/or derive from
   `reflexion.retry` counts. Warn tone near ceiling.
3. **Needs-Attention lane + surfaced reason** (Phase 3) — Mission Control leads
   with a KPI **stat strip** (active runs, today's spend, surfaced count, ceilings
   near limit) and a **Needs-Attention** lane of surfaced/crashed runs with their
   plain-text reason (`surfaced_reason`/`abort_reason` from `run.finalized`/
   `stage.surfaced` SSE + `RunRow`).
4. **Rich tournament board** (Phase 2) — extend the reused `BestOfBoard` with a
   **diff-entropy** meter + health note, and per-candidate `approach` summary,
   `adds`/`dels`, `seed`, `worktree`, Borda points (from `borda.updated`
   entropy/winner phases + `diff_entropy` tool). Augment, don't rebuild.
5. **Cross-vendor pairing + tier annotations** (Phase 2) — in `AttemptMetaGrid`
   show gen `{vendor·model·agent}` → judge `{vendor·model}` · rubric per stage,
   with tier-escalation annotations ("upgraded — generator used gpt-5.4",
   "best-of-3 tournament"). Reuse `VendorChip`/`TierChip`.
6. **Spend history + vendor/model split** (Phase 3, reuse) — 14-day spend bars +
   by-model cost/tokens already live on the **Budgets** page; link/embed, don't
   duplicate.

---

## Reuse (do NOT rebuild)
`useRunStream`, `useLiveRunOverlay`, `useAttemptLog`, `SseManager`, `LogPane`,
`Meter`, `Sparkline`, `StagePipeline`, `chips.tsx` (`VerdictChip`/`StatusChip`/
`VendorChip`/`TierChip`/`PipelineStateChip`), `Card`, `format.ts` (`formatUsd`/
`formatTokens`/`formatDuration`/`formatRelative`), `runModel.ts`, `useRuns`.

## Hard rules (project AGENTS.md)
- `shared/api-types.ts` is the wire contract — additive only, types + `apiPaths`
  in the same change.
- Only `packages/engine` may import `@earendil-works/pi-*`; `ui` talks to the
  server only via the wire contract.
- Tests reaching doctor/run-start need `PP_SKIP_CLI_VERSIONS=1`; SQLite changes
  additive-only (`CREATE TABLE IF NOT EXISTS`).
- `pnpm -r build && pnpm -r typecheck && pnpm -r test` green before done.

## Top risks & mitigations
1. **Replay double-count** on reconnect → dedupe append-only structures by
   `ev.seq` (`lastAppliedSeq`); keep `budget.tick`/attempt cost as absolute
   overwrites.
2. **`attempt.started` lacks `attempt_id`** today → verify/emit in pilot, or
   stage-key pending meta and reconcile on completion.
3. **Fleet connection exhaustion** → poll + global stream, not per-run fan-out.
4. **Open-ended `run.context.phase`** → `RunPhase` union with `(string & {})`;
   unknown phases render, never crash.

## Decomposition — four runs (validate in Chrome between each)
- **Run 1** — Deliverable 1 dropdown fix **+** Phase 0 wire-contract widenings.
- **Run 2** — Phase 1 `liveRunStore` overlay + `ingest()` + replay-idempotency tests.
- **Run 3** — Phase 2 Run Observatory + Event Feed + loop-ceiling meter + tournament board.
- **Run 4** — Phase 3 Mission Control + Needs-Attention + surfaced reason + KPI strip.

## Verification (per run)
- `pnpm -r build && pnpm -r typecheck && pnpm -r test` green; add store unit tests
  for replay idempotency (Run 2).
- Dev: start daemon on `:7878`, `cd ui && npm run dev` → `http://localhost:5273`
  (Vite proxy strips content-length so SSE streams frame-by-frame in dev).
- **Deliverable 1:** ladder/judge dropdowns show ONLY configured providers'
  models; configure/unconfigure a provider and confirm the list updates; unknown
  id → validation toast.
- **Observability:** drive a run (or replay via `ui/src/mocks/sseScript.ts`);
  `/runs/:id/live` — phase timeline advances, log stream flows, cost meter/
  sparkline move, event feed logs verdicts/retries, loop-ceiling meter fills;
  `/observability` — active runs appear, update on status transitions,
  Needs-Attention shows surfaced runs, cards link into the deep view.
- Use claude-in-chrome MCP (`read_console_messages`/`read_network_requests`):
  no console errors, SSE stays connected across a reconnect, **no cost
  double-count after reconnect**.

## Status
Nothing merged yet. Next task: **Run 1** (dropdown fix + Phase 0 widenings), then
Runs 2–4 in order.
