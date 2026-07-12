# Changelog — pi-pp-platform

## 2026-07-09 — Observability Sprint 1: Persistent Event Store (Opportunity 1)

### Overview

Completed Opportunity 1 from `observability_enhancements.md`: a **Persistent Event Store** that captures every SSE event to SQLite, enabling historical replay, debugging, and analytics. Previously, events existed only in a 2048-frame in-memory ring buffer — lost on restart or buffer wrap.

### Implementation audit — all 7 steps verified complete

| Step | Component | Status | Evidence |
|------|-----------|--------|----------|
| 1 | Schema — `events` table | ✅ | `packages/core/src/db/schema.sql`: `CREATE TABLE IF NOT EXISTS events` with `idx_events_run_seq` and `idx_events_type_ts` indexes |
| 2 | Writer — `persistFrame()` | ✅ | `packages/server/src/bus.ts`: `persistFrame()` INSERTs each frame inside `publish()` with fail-safe try/catch |
| 3 | Query helpers — `getEventLog()` | ✅ | `packages/core/src/orchestrator/runs.ts:3510`: `getEventLog(run_id, {since?, type?, limit?})` with seq-based pagination and payload scrubbing |
| 4 | REST endpoint | ✅ | `packages/server/src/routes/runs.ts`: `GET /api/v1/runs/:id/event-log?since=&type=&limit=` |
| 5 | Wire contract | ✅ | `shared/api-types.ts`: `apiPaths.runEventLog`, `EventLogEntry` type |
| 6 | UI hydration | ✅ | `ui/src/features/observability/RunObservatoryPage.tsx`: hydrates from event-log for completed runs via `useRunEventLog` → `liveRunStore.ingest()` |
| 7 | Retention | ✅ | `packages/core/src/orchestrator/janitor.ts`: 30-day retention `DELETE FROM events WHERE ts < ?` on every janitor pass |

### Key design decisions

- **Per-frame write** (not batched): `persistFrame()` is called synchronously in `publish()`. Write contention is mitigated by SQLite WAL mode. Batch accumulation could be added later if profiling shows it's needed.
- **Seq-based pagination** (not timestamp): the `since` parameter filters on `seq > ?` rather than `ts > ?`. Seq is monotonic within a run, making it ideal for cursor-based pagination without timestamp collisions.
- **Fail-safe persistence**: `persistFrame()` wraps the INSERT in try/catch — persistence failures never break live SSE delivery.

### Dependencies enabled

Opportunity 1 is the foundation for Opportunities 4 (Race Mode) and 8 (Run Replay), both of which require a persistent event store. The `getEventLog()` query and REST endpoint are ready for those consumers.

### Related files

- `CONSTITUTION.md` — updated to reflect observability invariants
- `PROJECT_MASTER.md` — Appendix C documents the observability enhancement plan
- `observability_enhancements.md` — preserved as the canonical gap-analysis reference

## 2026-07-11 — Observability Sprint 2: Tournament Board Enrichment (Campaign 2)

### Overview

Completed Campaign 2 of the observability project: **Tournament Board Enrichment**. Four coordinated sub-changes, sharing a single DB migration (schema v13 → v14), that make the best-of-N candidate race board significantly more informative for both automated and human inspection. Live-validated 2026-07-11 via a real best-of-3 run through the production REST/daemon path (browser "+ New run" flow); also browser-validated against two existing runs (populated and null-state).

### Schema migration — v13 → v14

Four new nullable columns added to the `attempts` table (additive-only, per the invariant):

| Column | Type | Purpose |
|--------|------|---------|
| `adds` | INTEGER NULL | Inserted line count for the candidate's diff |
| `dels` | INTEGER NULL | Deleted line count for the candidate's diff |
| `worktree_path` | TEXT NULL | Absolute path to the candidate's git worktree |
| `seed` | TEXT NULL | Rotation-diversification label (e.g. `"primary"`, `"devils-advocate"`, `"terse-diff"`, `"failing-test-first"`) |

### Sub-changes

#### 1 — Diff-entropy banner (`BestOfBoard.tsx`)

Best-of-N candidate races now show a **diff-entropy banner** at the top of the tournament board. The banner computes max pairwise similarity across all candidates and color-codes the result:

| Similarity | Color | Meaning |
|------------|-------|---------|
| < 0.6 | Neutral | Candidates are diverse |
| 0.6 – 0.85 | Amber | Moderate convergence |
| > 0.85 | Red + inline warning | Candidates have converged suspiciously (low-signal race) |

When candidates converge above the red threshold, an inline warning is displayed on the board so the user knows the race result may not be meaningful.

#### 2 — Per-candidate code churn

Each candidate card on the tournament board now displays `+adds −dels` line-count churn adjacent to its wall-clock time. Values come from the new `adds`/`dels` columns and are omitted (not shown as zero) when the columns are null.

#### 3 — Per-candidate worktree path (copy button)

An icon-only copy button on each candidate card copies the candidate's git worktree path to the clipboard. The path is **never rendered as visible text** in the UI to prevent local filesystem paths from appearing in screenshots or screen recordings.

#### 4 — Seed field bug fix (breaking wire-contract correction)

The "seed" row on each candidate card previously displayed the wrong value (`prompt_hash` was bound in error) and `AttemptStartedEvent.seed` / `AttemptRow.seed` were typed as `number` on the wire — incorrect in both value and type. Both are now corrected:

- **Type**: `seed` is now `string` on the wire contract (`shared/api-types.ts`) and in the DB schema.
- **Value**: `seed` now holds the real rotation-diversification label string (e.g. `"primary"`, `"devils-advocate"`).

**Breaking change for external consumers.** Any consumer that read `.seed` as a `number` must update to treat it as a `string`.

### Key design decisions

- **Null-safe rendering**: all four new fields are nullable. The UI omits the churn and worktree controls rather than showing placeholder zeros or empty strings when the columns are unpopulated (e.g. older runs pre-migration, or non-worktree runs).
- **Path privacy by design**: the worktree path is exposed only via a clipboard copy action — never as visible DOM text — preventing filesystem-layout leakage in screenshots.
- **Single migration for four columns**: grouping all four columns into one migration (v13 → v14) keeps the migration history clean and ensures partial-migration states are not possible within this feature.
- **Entropy as a signal, not a gate**: the diff-entropy banner is informational; it does not block or re-order results. Judgment is left to the human reviewer or downstream judging stage.

### Related files

- `packages/core/src/db/schema.sql` — v13 → v14 migration (four new nullable columns on `attempts`)
- `shared/api-types.ts` — `AttemptStartedEvent.seed` and `AttemptRow.seed` corrected to `string`
- `ui/src/features/runs/BestOfBoard.tsx` — diff-entropy banner, per-candidate churn, worktree copy button, seed display fix
