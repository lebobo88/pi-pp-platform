# pi-pp-platform — Install & Configuration

## Prerequisites

| Requirement | Version | Notes |
| --- | --- | --- |
| Node.js | **≥ 22.19.0** | Enforced by every package's `engines`; the pi 0.80.3 packages require it. |
| pnpm | **9.15.9** | The repo pins `packageManager: pnpm@9.15.9`. `corepack enable` will provision it. |
| git | any recent | Used for worktrees, diffs, and replay version capture. |
| Git Bash | on `PATH` (Windows only) | The pi coding-agent's bash tool needs a POSIX `bash`. On Windows, install Git for Windows and ensure `bash` resolves. |

## Install & build

```bash
git clone <this-repo> pi-pp-platform
cd pi-pp-platform

pnpm install          # installs all workspace packages (core, engine, pilot, server, mcp-adapter, ui)
pnpm -r build         # builds every package (tsc + vite)

# Optional: verify
pnpm -r typecheck
pnpm -r test
pnpm parity           # runs the parity audit (node parity/audit.mjs)
```

To run the control-plane server and serve the built UI:

```bash
# Point the server at the built UI, then start it.
PP_UI_DIST="$PWD/ui/dist" node packages/server/dist/bin/ppd.js
# → pi-pp-platform server listening on http://127.0.0.1:7878
```

`ppd` (server) and `ppp` (pilot CLI) are declared as package `bin`s, so once the
workspace is linked (or the packages are installed globally) you can invoke them
by name instead of by path.

To develop or demo the UI on its own with no server:

```bash
VITE_MOCK=1 pnpm -F @pp/ui dev      # in-browser mock daemon, http://localhost:5273
```

## Provider keys

All **35 providers** from pi's builtin model catalog are enabled — Anthropic,
OpenAI, Google, DeepSeek, xAI, Mistral, Groq, OpenRouter, and the rest of pi's
provider set. Any keyed provider can serve as a generator or judge. **Live runs
require at least one provider key; cross-vendor judging requires keys for two
different vendors.** Without any keys the platform still works fully in
**demo/mock mode** (the deterministic fake engine).

Set keys from the UI (**Providers & Models → Add a provider / Set key** — each
provider's card shows its env-key hint). Keys are **write-only**: they are sent
to the daemon once and never returned — the UI only ever shows a masked
fingerprint. The engine persists them via its credential store (`AuthStorage`)
at `%USERPROFILE%\.pi-pp-platform\auth.json` (Windows) /
`~/.pi-pp-platform/auth.json` (POSIX). **Delete** a key from the same card.

### Provider catalog & pricing (maintainers)

The provider/pricing config is layered:

- **`packages/core/catalog.json`** (mirrored to `assets/catalog.json`) is the
  **authoritative** governance layer: enabled providers, generation ladders,
  the judge pool, and curated per-model pricing. Edit this file.
- **`prices.json`** files are **generated** mirrors of the catalog's
  per-provider pricing — never edit them by hand.
- After editing the catalog, regenerate everything with:

  ```bash
  node scripts/generate-catalog-providers.mjs [--date YYYY-MM-DD]
  ```

  The script merges every provider pi ships into the catalog as an enabled
  entry (models/pricing for uncurated providers come dynamically from pi's
  catalog at runtime), preserves the curated blocks verbatim, and rewrites both
  `prices.json` files as exact mirrors.

**What you get with how many keys:**

| Configured vendors | Effect |
| --- | --- |
| 3 or more | Full **cross-vendor** judging on every gate; best quality signal. |
| 2 | Cross-vendor judging still works (the judge just needs a *different* vendor than the generator). |
| 1 | Same-vendor gates (code-style/docs/lint) still run, but **cross-vendor gates** (spec/design/security/contract) have no eligible independent judge — those runs **surface** for human review instead of self-certifying. |
| 0 | Only mock mode (`VITE_MOCK=1`) and the deterministic engine fakes are usable. |

**Vendor kill switches** disable a vendor even if a key is present — useful to
force a degradation path or work around an outage:

- `PP_DISABLE_<PROVIDER>=1` works for any catalog provider — e.g.
  `PP_DISABLE_OPENAI=1`, `PP_DISABLE_GOOGLE=1`, `PP_DISABLE_ANTHROPIC=1`,
  `PP_DISABLE_MISTRAL=1`.
- `PP_DISABLE_GEMINI=1` is a **separate global Gemini switch** (not an alias of
  `PP_DISABLE_GOOGLE`): judge routing honors it in addition to the per-provider
  kill switch.

## Environment reference

All configuration is via `PP_*` environment variables. Values verified against
`packages/core/src/util/paths.ts` and `packages/server/src`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PP_HOME` | `~` | Root for harness state; state lives in `$PP_HOME/.pair-programmer/`. |
| `PP_DB_PATH` | `~/.pair-programmer/state.db` | SQLite database path (overrides the default under the root dir). |
| `PP_PORT` | `7878` | Server listen port. |
| `PP_HOST` | `127.0.0.1` | Bind host. Binding a non-loopback host **requires** `PP_API_TOKEN` — `ppd` refuses to start otherwise. |
| `PP_API_TOKEN` | _(unset)_ | Bearer token for `/api/v1` (see [API token & the UI](#api-token--the-ui)). |
| `PP_SKILLS_BUDGET_CHARS` | `24000` | Total character budget for skill bodies injected into one generator prompt (each skill is also capped by its own `max_chars`; over-budget skills are skipped deterministically). |
| `PP_UI_DIST` | _(unset)_ | Path to `ui/dist`; when set, `ppd` serves the built SPA. |
| `PP_ECOSYSTEM` | _off_ | Enables ecosystem (Hydra / TheEights / Constitution) subprocess writes. **Default off** — standalone runs never touch the ecosystem. |
| `PP_PLATFORM_DIR` | _(derived)_ | Platform install dir override. |
| `PP_ASSETS_DIR` | _(bundled)_ | Override the `assets/` location (teams, rubrics, profiles, prompts). |
| `PP_REPO_ROOT` | _(derived)_ | Repo root override. |
| `PP_DISABLE_<PROVIDER>` (e.g. `PP_DISABLE_OPENAI`) | _off_ | Per-provider kill switches. `PP_DISABLE_GEMINI` is a separate global Gemini switch, distinct from `PP_DISABLE_GOOGLE`. |
| `PP_DISABLE_NPX_VALIDATORS` | _off_ | Disable `npx`-based artifact validators (offline/locked-down environments). |
| `PP_ALLOW_DESTRUCTIVE` | _off_ | Permit destructive operations that are otherwise blocked. |
| `PP_ALLOW_SMOKE_FAILED_WINNER` | _off_ | Allow merging a best-of winner whose runtime smoke test failed. |
| `PP_ALLOW_BEST_OF_WITHOUT_JUDGE` | _off_ | Permit a best-of stage to resolve without a judge (normally rejected). |
| `PP_LIVE` | _off_ | Enables live (real-API) engine smoke tests (`pnpm -F @pp/engine test:live`). |
| `PP_DEBUG` / `PP_LOG_LEVEL` | _off_ / `info` | Verbose logging controls. |
| `PP_COPILOT_FALLBACK` | _off_ | Copilot-mirror tier fallback behavior. |
| `PP_STRICT_AGENT_TYPE` | _off_ | Strict agent-type validation. |
| `PP_EIGHTS_DAEMON` | _(unset)_ | TheEights daemon endpoint (only relevant when `PP_ECOSYSTEM` is on). |
| `PP_LLM` | `pi` | Set to `fake` to use the deterministic fake engine (demo mode / offline). Any other value uses the real pi engine. |
| `PP_MAX_CONCURRENT_RUNS` | `2` | Max simultaneous runs the `RunSupervisor` executes; extra runs are FIFO-queued and emit a `run.queued` event, then start when a slot frees. |

### API token & the UI

When `PP_API_TOKEN` is set, every request except `GET /healthz` must carry
`Authorization: Bearer <token>` (compared in constant time). Two UI-facing
details:

- **UI token gate** — the first 401 raises a non-dismissable prompt in the SPA;
  paste the token once and the UI stores it locally, attaches it as a bearer
  header to every request, and refetches. Manage the stored token later from
  **System → API access** (masked to the last 4 characters; Change / Clear).
- **SSE `?token=`** — `EventSource` cannot send headers, so the two SSE
  endpoints (`GET /api/v1/events` and `GET /api/v1/runs/:id/events`) — and only
  those — also accept the token as a `?token=` query parameter. The UI appends
  it automatically.

## MCP registration (`@pp/mcp-adapter`)

The MCP adapter exposes the harness's read/record surface to any MCP host as the
`pp_harness` server over stdio. Register it in your host's `.mcp.json`:

```json
{
  "mcpServers": {
    "pp_harness": {
      "command": "node",
      "args": ["packages/mcp-adapter/dist/bin.js"]
    }
  }
}
```

Use an absolute path to `dist/bin.js` if the host's working directory isn't the
repo root. Build first (`pnpm -F @pp/mcp-adapter build`). Generation, critique,
best-of-worktree, and ecosystem tools are registered but return a structured
`not_available_in_adapter` error — the adapter is a read/record door, not a full
run driver.

## Verify the install

```bash
# Demo mode — real UI + server on the fake engine, no API keys:
pnpm demo                                   # → http://127.0.0.1:7878

# Read-path + full-run integration smoke against a real ppd:
pnpm -F @pp/server build
PP_INTEGRATION=1 pnpm -F @pp/ui test:integration
```

## Live golden run

Once at least one provider key is set (Providers UI), you can do a real
(non-fake) run:

```bash
# Point the engine at real models. Keep it cheap: single mode, a scratch
# project, and a tight day cap so a stray loop can't run up a bill.
PP_LIVE=1 node packages/pilot/dist/bin/ppp.js run \
  --project /path/to/scratch-project \
  --mode single \
  --request "Add a greeting helper."
```

- Use a throwaway git project (a clean tree with one commit), not a real repo.
- Set a small **day cap** in the Budgets screen first; the run downgrades the
  model tier at 80% and blocks at 100%.
- Prefer cheap tiers (haiku/sonnet) via the tier cap in the launch wizard.
- With fewer than two provider keys, cross-vendor gates surface the run for
  review rather than self-certifying (see [Provider keys](#provider-keys)).
