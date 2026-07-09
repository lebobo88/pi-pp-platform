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
