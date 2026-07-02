# pi-pp-platform

**Pair-programmer, re-hosted on the pi runtime.** This is a faithful port of the
`pair-programmer` multi-agent code-generation harness that
runs entirely on [`@earendil-works/pi-*`](https://www.npmjs.com/package/@earendil-works/pi-ai)
**0.80.3** — with **zero dependence on the Claude Code, Gemini, Codex, or Copilot
CLIs**. Generation and cross-vendor judging happen through the pi model APIs
(OpenAI, Google, Anthropic) instead of shelling out to vendor CLIs, and the whole
platform is driven from a web UI plus a small set of local binaries.

> Status: pre-1.0. Milestones M1–M7 are complete (harness port, pi engine,
> pilot lifecycle, best-of/teams/forums, live server run-control, the full UI,
> and the 29-hook parity layer); M8 is the closing parity-audit + docs pass. See
> the [milestone status](#milestone-status) table.

## What it is

- **Same harness, new runtime.** The orchestration state machine, rubrics,
  gates, taxonomy, best-of-N, TDD/validator gates, missability checks, and
  master-plan patching are ported wholesale from pair-programmer into
  `@pp/core`. Behavior and invariants are preserved (Reflexion ×1, cross-vendor
  judging, the fable-tier capability gate, …).
- **No sub-CLIs.** The old codex/gemini/copilot CLI bridges are gone. `@pp/engine`
  wraps the pi model + coding-agent APIs directly and ships deterministic fakes
  for offline/dev runs.
- **A real product surface.** A Fastify control-plane server (`ppd`) exposes a
  typed REST + SSE API, and a React SPA gives you project management, a run
  launch wizard, a live run view, provider key management, budgets, evolution
  review, and system health.

## Architecture

```mermaid
flowchart TD
  UI["@pp/ui — React SPA<br/>(launch wizard, live run view, keys, budgets)"]
  SERVER["@pp/server — ppd<br/>Fastify REST /api/v1 + 2 SSE streams @ 127.0.0.1:7878"]
  PILOT["@pp/pilot — ppp<br/>RunPilot: 9-phase lifecycle driver"]
  ENGINE["@pp/engine<br/>pi-ai / pi-coding-agent runtime + fakes"]
  CORE["@pp/core<br/>state machine · rubrics · gates · taxonomy · SQLite"]
  MCP["@pp/mcp-adapter — pp-mcp<br/>pp_harness-compatible MCP stdio server"]
  ASSETS["assets/<br/>26 teams · 27 rubrics · 16 profiles · 75 agent prompts"]

  UI -->|"/api/v1 + SSE"| SERVER
  SERVER --> PILOT
  PILOT --> ENGINE
  ENGINE --> CORE
  SERVER --> CORE
  MCP -->|"side door"| CORE
  CORE --- ASSETS
```

Dependency direction is **server → pilot → engine → core**. Only `@pp/engine`
imports the pi packages, so everything above it is engine-agnostic. The
`@pp/mcp-adapter` is a side door: it exposes the harness read/record surface to
external MCP hosts (the Hydra gateway, TheEights, any MCP client) without going
through the server.

## Packages

| Path | Package | Role | Binary |
| --- | --- | --- | --- |
| `packages/core` | `@pp/core` | Orchestration state machine, SQLite schema, rubrics, gates, taxonomy, best-of-N | — |
| `packages/engine` | `@pp/engine` | pi-ai / pi-coding-agent runtime — generate, critique, tool guards, doctor probes, deterministic fakes | — |
| `packages/pilot` | `@pp/pilot` | `RunPilot` — the in-process 9-phase lifecycle driver | `ppp` |
| `packages/server` | `@pp/server` | Fastify REST `/api/v1` + two SSE streams on `127.0.0.1:7878` | `ppd` |
| `packages/mcp-adapter` | `@pp/mcp-adapter` | pp_harness-compatible MCP stdio server over `@pp/core` | `pp-mcp` |
| `ui` | `@pp/ui` | React 18 + Vite 6 + Tailwind v4 SPA (served by `ppd`) | — |
| `shared` | — | `api-types.ts` — the hand-maintained wire contract shared by server + UI | — |
| `assets` | — | Ported teams, rubrics, profiles, agent prompts, taxonomy blueprint | — |

## Quickstart

```bash
# 1. Install (pnpm 9, Node ≥ 22.19)
pnpm install

# 2. Build everything
pnpm -r build

# 3a. Demo mode — real UI + real server driven by the fake engine (no API keys):
#     builds ui + server and boots ppd with PP_LLM=fake so you can launch a run
#     end to end offline.
pnpm demo            # → http://127.0.0.1:7878

# 3b. UI-only mock mode — the in-browser mock daemon serves fixtures and replays
#     a scripted, animated run (no server):
VITE_MOCK=1 pnpm -F @pp/ui dev      # → http://localhost:5273

# 3c. Full server (serves the built UI when PP_UI_DIST points at ui/dist):
pnpm start           # builds, then boots ppd on http://127.0.0.1:7878
```

Provider API keys can be set from the UI (**Providers & Models → Set key**,
write-only) or through the engine's credential store. Full cross-vendor judging
needs keys for all three vendors (OpenAI, Google, Anthropic); with fewer, the
harness degrades gracefully, and with none it still runs in demo/mock mode
(see [INSTALL.md](docs/INSTALL.md#provider-keys)).

The `ppp` binary (`@pp/pilot`) drives a run from the command line; `ppd`
(`@pp/server`) hosts the API + UI. See [docs/INSTALL.md](docs/INSTALL.md) for the
full setup and [docs/USER_GUIDE.md](docs/USER_GUIDE.md) for a screen-by-screen
tour and the run-lifecycle explainer.

Run **control** (launch / abort / retry / gate) is live over REST via the
in-process `RunSupervisor` (concurrency cap, FIFO queue, budget tripwires), and
the pilot's event bus is bridged to SSE so the run view animates in real time.

## Milestone status

| Milestone | Scope | Commit | State |
| --- | --- | --- | --- |
| M1 | Scaffold workspace; port daemon as `@pp/core` | `4d58719` | ✅ done |
| M2 | `@pp/engine` — pi generate/critique/doctor + fakes | `11a3059` | ✅ done |
| M3 | `@pp/pilot` — RunPilot 9-phase lifecycle + `ppp` | `4f55439` | ✅ done |
| M4 | Best-of-N + teams (26) + forums (10) + TDD/validator gates | `9699abb` | ✅ done |
| M5a–b | UI foundation + read-only feature screens + animated run view | `b467fe2` / `59cf230` | ✅ done |
| M5c | `@pp/server` — REST/SSE foundation, schema v8, key mgmt | `10974b9` | ✅ done |
| M5d | Run-control live — `RunSupervisor` (concurrency/abort/budget), retry/gate, SSE bridge | `4fdf549` | ✅ done |
| M5e–g | UI↔server contract reconciliation; live-daemon smoke; demo/start + maxParamLength | `302bb7f` / `01cdafb` / `18ceaac` | ✅ done |
| M5i | Full-run UI E2E against the live daemon (wizard→run→SSE→abort) | `9618604` | ✅ done |
| M6 / M6.1 | UI control plane — wizard, run actions, keys, evolution, caps | `2a1d2a7` / `ffb0ec0` | ✅ done |
| M7 | Hooks parity (29), autogenesis wiring, visual/browser, prompt port (75) | `e192fb2` / `f52fca9` | ✅ done |
| M7a | `@pp/mcp-adapter` — pp_harness MCP server | `6594efc` | ✅ done |
| M8a–b | Parity matrix + audit scaffold; ecosystem guard; docs | `1efc912` / `da85f68` | ✅ done |
| M8 | Parity audit close-out + final docs sweep | — | 🚧 in progress |

(Commit refs are from `git log`. M1–M7 are complete; M8 is the closing parity +
docs pass.)

## License

License: TBD by owner.
