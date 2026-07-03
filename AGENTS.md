# AGENTS.md — guidance for AI agents working in this repo

pi-pp-platform is a pnpm monorepo (Node ≥ 22.19, TypeScript ESM/NodeNext — all
source imports use `.js` specifiers even for `.ts` files).

## Package map & dependency direction

`server → pilot → engine → core`; `mcp-adapter` is a stdio side door onto core.
**Only `packages/engine` may import `@earendil-works/pi-*`.** `ui` talks to the
server exclusively through the wire contract.

- `packages/core` — orchestration state machine, SQLite schema, rubrics, gates,
  taxonomy, teams/profiles/skills loaders, governance catalog. Tests are
  `node --test` files explicitly listed in `packages/core/package.json`.
- `packages/pilot` — `RunPilot`, the 9-phase run lifecycle (triage → profile →
  taxonomy → stage loop → missability → master-plan → finalize). Vitest.
- `packages/server` — Fastify REST `/api/v1` + two SSE streams on `:7878`;
  drives the pilot in-process via `RunSupervisor`. Vitest.
- `ui` — React 18 + Vite + Tailwind v4 SPA; TanStack Query + zustand.

## Hard rules

1. **`shared/api-types.ts` is the wire contract.** Every endpoint/payload
   change updates its types AND `apiPaths` in the same commit.
2. **Catalog files are generated.** Edit `packages/core/catalog.json`, then run
   `node scripts/generate-catalog-providers.mjs`; never hand-edit
   `assets/catalog.json` or either `prices.json`.
3. **Behavioral invariants** (do not break): Reflexion ×1 retry per stage,
   cross-vendor judging for elevated gates, write-only provider keys (never
   echo a key in any response), budget tripwires, additive-only SQLite schema
   changes (`CREATE TABLE IF NOT EXISTS`).
4. **Asset resolution order** is project (`<project>/.claude/...`) → user
   (`~/.claude/...`) → builtin (`assets/...`) for teams, skills, agents, and
   rubrics — preserve it when touching loaders.
5. Tests that reach doctor/run-start paths need `PP_SKIP_CLI_VERSIONS=1`.
6. `pnpm -r build && pnpm -r typecheck && pnpm -r test` must be green before a
   change is considered done.
