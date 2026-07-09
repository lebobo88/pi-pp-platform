# Project Master Plan — pi-pp-platform

_Auto-scaffolded by pair-programmer harness on 2026-07-09. Each `/pp:run` will append/patch the relevant section. The taxonomy_blueprint.md is the canonical reference for the 16 SDLC sections._

## 1. Executive summary

pi-pp-platform is a web control plane for the pair-programmer AI coding
harness, re-hosted on the pi runtime. It replaces the CLI-dependent
pair-programmer with a Fastify REST + SSE server, a React SPA, and native
pi model APIs — zero dependence on Claude Code, Gemini, Codex, or Copilot
CLIs. The platform supports four run modes (single, team, best_of, review),
cross-provider judging with Reflexion ×1 retry, budget enforcement with
tripwires, and a full lifecycle UI. It serves engineering teams that want
structured, governed AI code generation with guardrails.

## 2. Business and portfolio context

- **Repository**: https://github.com/lebobo88/pi-pp-platform
- **License**: MIT
- **Runtime**: Node ≥ 22.19, pnpm 9.15.9, TypeScript ESM/NodeNext
- **Backend**: Fastify server on port 7878, SQLite (WAL mode) for all
  persistence
- **Frontend**: React 18 + Vite + Tailwind v4 SPA with TanStack Query +
  zustand
- **Dependency**: `@earendil-works/pi-*` 0.80.3 for generation + judging
- **Deployment**: Docker Compose (single-node), no external SaaS dependencies

## 3. Stakeholders and users

- **Primary**: Engineering teams using AI coding agents who need
  structured governance (budgets, gates, cross-vendor judging).
- **Secondary**: Platform operators managing provider keys, budgets, and
  system health.
- **Tertiary**: OSS contributors extending the harness with custom teams,
  skills, rubrics, and profiles.

## 4. Current-state workflow and pain

- **Current**: Teams use raw LLM chat or vendor CLIs for code generation
  with no governance, no budget enforcement, and no cross-vendor quality
  checks. Generated code lands without structured gates.
- **Pain**: No way to compare vendors empirically, no budget tripwires
  to prevent runaway spend, no persistent event log for debugging
  completed/crashed runs, and no structured pipeline for multi-agent
  collaboration.

## 5. Scope and roadmap

- **Phase 0 (Done)**: Core port — state machine, rubrics, gates, taxonomy,
  best-of-N, TDD/validator gates, missability, master-plan.
- **Phase 1 (Done)**: Web UI — launch wizard, live run view, library
  (teams/agents/skills/rubrics/profiles/forums/taxonomy), provider
  management, budgets, evolution review.
- **Phase 2 (In progress)**: Observability — persistent event store,
  structured logging (Pino), phase-level timing, run comparison, context
  window tracking, gates REST endpoint, Prometheus metrics, run replay.
- **Phase 3 (Planned)**: Multi-tenancy, horizontal scaling, enterprise
  SSO, audit export.

## 6. Functional requirements

- FR-1: Launch runs in four modes (single, team, best_of, review) from
  a web wizard with automatic profile detection and team recommendation.
- FR-2: Cross-vendor judging with Reflexion ×1 retry, re-gate, and abort.
- FR-3: Budget enforcement (warn/block) at per-run, per-day, per-model,
  and per-tier scopes.
- FR-4: Real-time SSE streaming of run lifecycle events (global + per-run).
- FR-5: Persistent event log with historical replay for completed runs.
- FR-6: Provider key management (write-only storage, masked display).
- FR-7: Evolution (autogenesis) with proposal review, commit/rollback.
- FR-8: TDD gate with pre/post test execution and manifest verification.
- FR-9: Artifact archiving with SHA-256 hashing and content retrieval.
- FR-10: Janitor for stale worktrees, locks, crashed runs, and expired events.

## 7. Acceptance criteria

- AC-1: A run launched from the wizard completes all planned stages and
  reaches status `complete` or `surfaced`.
- AC-2: Cross-vendor judging fires for elevated gates; same-vendor
  attempts are flagged.
- AC-3: Budget tripwire blocks generation when the block threshold is
  exceeded.
- AC-4: SSE streams deliver events with < 500ms latency from publish to
  client receipt.
- AC-5: `pnpm -r build && pnpm -r typecheck && pnpm -r test` is green
  on every commit.
- AC-6: The persistent event log survives server restart and supports
  paginated query by run_id, event_type, and sequence number.
- AC-7: Provider keys are never echoed in any API response, SSE frame,
  or log line.

## 8. Non-functional requirements

- **Performance**: SSE event delivery < 500ms p95 latency. Run launch
  wizard renders < 2s cold. Run list pagination < 200ms.
- **Reliability**: Single-process; graceful shutdown on SIGTERM. Janitor
  recovers crashed runs on startup. SQLite WAL mode for concurrent reads.
- **Security**: Write-only provider keys. Optional `PP_API_TOKEN` bearer
  auth. Path-traversal guard on artifact content serving. Secret scrubbing
  in SSE frames and logs.
- **Accessibility**: WCAG 2.2 AA on all UI artifacts. Screen-state matrix
  (8 states). Keyboard navigation on the launch wizard and run view.
- **Localization**: English default. i18n pipeline ready (react-i18next
  pattern). All user-facing strings externalized.
- **Observability**: Persistent event log (30-day retention). Structured
  logging via Pino. Prometheus-compatible metrics endpoint. Phase-level
  timing. Context window tracking per attempt.

## 9. UX/UI/content design

- **Design system**: Tailwind v4 with a custom dark theme. Component
  library follows shadcn/ui patterns with project-specific composition.
- **Screen states**: 8-state matrix (loading, empty, error, unauthorized,
  not-found, idle, active, complete) applied uniformly across all views.
- **Key screens**: Dashboard (mission control with KPI strip), Run
  Observatory (3-column live view), Launch Wizard (3-step: select
  project → configure run → review & launch), Library (7-tab browse),
  Providers & Models (key management + ladder configuration).
- **Responsive**: Desktop-first (1024px+) with tablet support (768px+).
  Mobile is deferred.
- **Visual regression**: Playwright-based screenshot comparison on
  component changes.

## 10. Domain and data model

- **Core entities**: Run → Stage → Attempt → Verdict (hierarchy).
  Artifact, Budget, TddCheck, ArtifactValidation, EvolutionProposal,
  MissabilityCheck (satellites).
- **Registry entities**: Team, Skill, Agent, Rubric, Profile, Forum,
  TaxonomySection (library tables).
- **Observability entities**: Event (persistent SSE log), Budget
  (rolling scope totals).
- **Storage**: SQLite single-file database in WAL mode. All timestamps
  ISO-8601 text. Foreign keys enforced.

## 11. Architecture and technical strategy

- **Monorepo**: pnpm workspace with 5 packages (core, engine, pilot,
  server, mcp-adapter) + UI (Vite SPA) + shared (api-types).
- **Dependency direction**: server → pilot → engine → core.
  `mcp-adapter` is a stdio side door onto core. Only `packages/engine`
  may import `@earendil-works/pi-*`.
- **API**: Fastify REST `/api/v1` + two SSE streams (global + per-run)
  on `127.0.0.1:7878`. Typed wire contract in `shared/api-types.ts`.
- **State machine**: 9-phase pilot (triage → profile → taxonomy →
  tier-resolve → skills → artifact-promotion → stage loop → master-plan
  → finalize).
- **Generation**: pi-ai model APIs with coding-agent envelope. Engine
  ships deterministic fakes for offline/dev.
- **Judging**: Cross-vendor by default for elevated gates. Borda-count
  ranking for best-of-N winner selection.

## 12. Interfaces and contracts

- **REST API**: 40+ endpoints covering runs, stages, attempts, verdicts,
  artifacts, providers, models, budgets, teams, agents, skills, profiles,
  forums, taxonomy, rubrics, evolution, janitor, doctor, settings.
- **SSE protocol**: Two streams. Frames carry `{type, run_id?, ts, seq,
  data}`. Last-Event-ID resume from ring buffer. 15s heartbeat.
- **Wire contract**: `shared/api-types.ts` — single source of truth for
  all types crossing the boundary. `apiPaths` for URL construction.
- **MCP adapter**: stdio JSON-RPC server implementing the `pp_harness`
  tool set (63 full / 17 stub tools) for external MCP host integration.

## 13. Engineering standards and delivery model

- **Language**: TypeScript ESM/NodeNext. All source imports use `.js`
  specifiers even for `.ts` files.
- **Testing**: Vitest for server/pilot. Node `--test` for core. React
  Testing Library + Vitest for UI. Playwright for E2E/visual regression.
- **Linting**: Biome (format + lint). Staged via pre-commit hook.
- **CI**: GitHub Actions — build + typecheck + test on every push.
- **Versioning**: No semver on packages (private). Git SHA is the
  version identifier.

## 14. Security, privacy, and compliance

- **Auth**: Optional `PP_API_TOKEN` bearer token. Tokenized SSE via
  `?token=` query parameter.
- **Key storage**: Provider API keys stored write-only in SQLite.
  Masked fingerprints displayed in UI. Never logged or echoed.
- **Secret scrubbing**: `scrubSecrets()` filters API keys and absolute
  paths from SSE frames. Pino redaction configured for sensitive paths.
- **Path traversal**: Artifact content serving validates resolved paths
  don't escape the project root.
- **Supply chain**: No runtime dependency on external SaaS. All
  generation/judging through pi APIs with keys stored locally.

## 15. Test and verification strategy

- **Unit tests**: Vitest for server/pilot/UI. Node `--test` for core.
  Coverage target: 80%+ on critical path (run lifecycle, budget
  enforcement, judging).
- **Integration tests**: REST endpoint tests with in-memory SQLite.
  SSE stream playback tests.
- **TDD gate**: Pre/post test execution with manifest verification.
  Supports bug-fix, refactor, and feature-tdd modes.
- **Validator gates**: ADR structure lint, contracts lint, design tokens
  build, Mermaid render, C4 render.
- **E2E**: Playwright smoke tests on the launch wizard, run view, and
  library screens.
- **Visual regression**: Playwright screenshot comparison triggered on
  UI changes.

## 16. Operations and support model

- **Deployment**: Docker Compose single-node. `docker-compose up` boots
  the server + UI dev proxy.
- **Monitoring**: Prometheus-compatible `/metrics` endpoint. Structured
  Pino logs to stdout. Health check at `/healthz`.
- **Backup**: SQLite database file. Periodic backup via filesystem
  snapshot or `VACUUM INTO`.
- **Janitor**: Startup sweep for stale worktrees, branches, locks,
  crashed runs, and expired events (30-day retention).
- **Doctor**: `/pp:doctor` probes provider health, DB reachability,
  cross-vendor readiness, and optional critique smoke tests.

## 17. Team operating model and governance

- **Governance model**: Constitution-driven (CONSTITUTION.md).
  Amendments via `/pp:constitution amend` (HITL-only).
- **Evolution**: Autogenesis pipeline proposes improvements to rubrics,
  team profiles, and stage prompts. Proposals require human review
  (approve/reject/commit/rollback).
- **Cross-vendor judging**: Elevated gates require a judge from a
  different vendor than the generator. This is machine-enforced.
- **Budget governance**: Tripwires at warn/block thresholds. Operator
  can set per-scope caps via the UI.
- **Run modes**: Single (one pass), team (multi-stage pipeline with 26
  specialized teams), best_of (2-8 parallel candidates, Borda winner),
  review (10 governance forums).

## 18. Risks, assumptions, and open questions

- **Risk**: Single-point-of-failure SQLite database. Mitigation: WAL
  mode, periodic backup, filesystem snapshot.
- **Risk**: Provider API outages block generation/judging. Mitigation:
  multi-provider support, fallback tiers, Reflexion retry.
- **Risk**: Context window bloat degrades generation quality silently.
  Mitigation: context window tracking (Opportunity 5), alerting at 75%+
  utilization.
- **Assumption**: Single-server deployment is sufficient. Multi-tenancy
  and horizontal scaling are Phase 3.
- **Open question**: When to adopt OpenTelemetry for distributed tracing
  (if the platform goes multi-service).
- **Open question**: Integration with external agent observability
  (disler/pi-agent-observability hook pattern) for observing non-pi agents.

## 19. Launch, migration, and rollback plan

- **Launch**: Docker Compose on a single host. No data migration needed
  (greenfield SQLite). UI served via Vite dev proxy or static build.
- **Migration**: SQLite schema is additive-only. New columns via
  `ALTER TABLE … ADD COLUMN`. No destructive migrations.
- **Rollback**: Git revert + redeploy. SQLite file can be restored from
  backup. Evolution commits support rollback (snapshot restore).

## 20. Deprecation and retirement plan

- **Deprecation**: API endpoints deprecated with 2-release notice.
  Response headers carry `Deprecation` and `Sunset` fields.
- **Retirement**: Final janitor pass archives the SQLite database.
  Docker image tagged with final SHA. Repository archived as read-only.

## Appendices

### A. Package map

| Package | Role | Dependencies |
|---------|------|-------------|
| `@pp/core` | State machine, SQLite, rubrics, gates, taxonomy | None internal |
| `@pp/engine` | pi model APIs, coding-agent envelope, fakes | `@pp/core`, `@earendil-works/pi-*` |
| `@pp/pilot` | 9-phase run lifecycle driver | `@pp/engine`, `@pp/core` |
| `@pp/server` | Fastify REST + SSE, control plane | `@pp/pilot`, `@pp/core` |
| `@pp/mcp-adapter` | MCP stdio server (63+ tools) | `@pp/core` |
| `ui/` | React SPA | Wire contract via `shared/api-types.ts` |

### B. Key architectural decisions

- **Build vs. integrate with disler's observability system**: Adopt the
  patterns (persistent event store, race mode, context tracking) natively;
  the stack mismatch makes porting impractical.
- **No OpenTelemetry yet**: The custom event bus provides richer
  domain-specific semantics than generic spans. Revisit for multi-service.
- **No external SaaS**: The custom system already has better
  domain-specific semantics than Datadog/LangSmith/Langfuse.
- **Additive-only SQLite**: Never drop/rename columns. This keeps
  migrations simple and rollback-safe.

### C. Observability enhancement plan

See `observability_enhancements.md` for the full gap analysis and 8
prioritized opportunities. Opportunity 1 (Persistent Event Store) is
now implemented: `events` table in schema, `persistFrame()` in bus,
`getEventLog()` query, REST endpoint, UI hydration, and 30-day retention
in janitor.
