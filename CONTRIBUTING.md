# Contributing

Thanks for your interest in pi-pp-platform!

## Development setup

Prerequisites: Node ≥ 22.19, pnpm 9 (the repo pins `packageManager`).

```bash
pnpm install
pnpm dev          # fake-engine daemon on :7878 + Vite UI on :5273 — no API keys needed
```

Useful scripts (repo root):

| Script | What it does |
| --- | --- |
| `pnpm build` / `pnpm typecheck` / `pnpm test` | run across every workspace package |
| `pnpm dev` | fake engine + UI with HMR (offline, deterministic) |
| `pnpm demo` | production build served with the fake engine |
| `pnpm start` / `pnpm serve` | production modes with the real pi engine |
| `pnpm validate:live` | end-to-end generation + judging against real provider keys |

## Repo layout

- `packages/core` — orchestration state machine, SQLite, rubrics/gates/taxonomy (engine-agnostic; tests are `node --test`)
- `packages/engine` — the only package that imports `@earendil-works/pi-*`
- `packages/pilot` — the 9-phase run lifecycle driver
- `packages/server` — Fastify REST `/api/v1` + SSE daemon (`ppd`)
- `packages/mcp-adapter` — `pp_harness`-compatible MCP stdio server
- `ui` — React SPA
- `shared/api-types.ts` — the hand-maintained wire contract between server and UI. **Any endpoint or payload change must be reflected here.**
- `assets/` — teams, profiles, rubrics, skills, agent prompts, the governance catalog

## Ground rules

- Match the surrounding code's idioms; TypeScript ESM with NodeNext `.js` import specifiers.
- New/changed endpoints: update `shared/api-types.ts` (types **and** `apiPaths`) in the same change.
- Provider/model data: edit `packages/core/catalog.json`, then run
  `node scripts/generate-catalog-providers.mjs` — `assets/catalog.json` and both
  `prices.json` files are generated mirrors, never edit them by hand.
- Add tests next to the package you touch (`node --test` in core, vitest elsewhere).
  Set `PP_SKIP_CLI_VERSIONS=1` when a test exercises doctor/run-start paths.
- Keep PRs focused; run `pnpm build && pnpm typecheck && pnpm test` before opening one.

## Reporting issues

Use GitHub issues for bugs and feature requests. For security reports, see
[SECURITY.md](SECURITY.md).
