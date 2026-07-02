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

The harness talks to three model vendors through the pi APIs. Set keys from the
UI (**Providers & Models → Set key**, write-only) or via the engine's credential
store.

`TODO(M5c/M5d)`: the exact server key-storage location and any file-based
fallback are finalized as the server key-management path lands — set keys through
the UI once `ppd` is running.

**What you get with how many keys:**

| Configured vendors | Effect |
| --- | --- |
| All 3 (OpenAI + Google + Anthropic) | Full **cross-vendor** judging on every gate; best quality signal. |
| 2 | Cross-vendor judging still works (the judge just needs a *different* vendor than the generator). |
| 1 | Same-vendor gates (code-style/docs/lint) still run, but **cross-vendor gates** (spec/design/security/contract) have no eligible independent judge — those runs **surface** for human review instead of self-certifying. |
| 0 | Only mock mode (`VITE_MOCK=1`) and the deterministic engine fakes are usable. |

**Vendor kill switches** disable a vendor even if a key is present — useful to
force a degradation path or work around an outage:

- `PP_DISABLE_OPENAI=1`
- `PP_DISABLE_GOOGLE=1` (alias: `PP_DISABLE_GEMINI=1`)
- `PP_DISABLE_ANTHROPIC=1`

## Environment reference

All configuration is via `PP_*` environment variables. Values verified against
`packages/core/src/util/paths.ts` and `packages/server/src`.

| Variable | Default | Purpose |
| --- | --- | --- |
| `PP_HOME` | `~` | Root for harness state; state lives in `$PP_HOME/.pair-programmer/`. |
| `PP_DB_PATH` | `~/.pair-programmer/state.db` | SQLite database path (overrides the default under the root dir). |
| `PP_PORT` | `7878` | Server listen port (host is always `127.0.0.1`). |
| `PP_API_TOKEN` | _(unset)_ | Bearer token for `/api/v1`. The server enforces loopback-only regardless; a token adds defense-in-depth. |
| `PP_UI_DIST` | _(unset)_ | Path to `ui/dist`; when set, `ppd` serves the built SPA. |
| `PP_ECOSYSTEM` | _off_ | Enables ecosystem (Hydra / TheEights / Constitution) subprocess writes. **Default off** (M8a guard) — standalone runs never touch the ecosystem. |
| `PP_PLATFORM_DIR` | _(derived)_ | Platform install dir override. |
| `PP_ASSETS_DIR` | _(bundled)_ | Override the `assets/` location (teams, rubrics, profiles, prompts). |
| `PP_REPO_ROOT` | _(derived)_ | Repo root override. |
| `PP_DISABLE_OPENAI` / `PP_DISABLE_GOOGLE` / `PP_DISABLE_GEMINI` / `PP_DISABLE_ANTHROPIC` | _off_ | Per-vendor kill switches. |
| `PP_DISABLE_NPX_VALIDATORS` | _off_ | Disable `npx`-based artifact validators (offline/locked-down environments). |
| `PP_ALLOW_DESTRUCTIVE` | _off_ | Permit destructive operations that are otherwise blocked. |
| `PP_ALLOW_SMOKE_FAILED_WINNER` | _off_ | Allow merging a best-of winner whose runtime smoke test failed. |
| `PP_ALLOW_BEST_OF_WITHOUT_JUDGE` | _off_ | Permit a best-of stage to resolve without a judge (normally rejected). |
| `PP_LIVE` | _off_ | Enables live (real-API) engine smoke tests (`pnpm -F @pp/engine test:live`). |
| `PP_DEBUG` / `PP_LOG_LEVEL` | _off_ / `info` | Verbose logging controls. |
| `PP_COPILOT_FALLBACK` | _off_ | Copilot-mirror tier fallback behavior. |
| `PP_STRICT_AGENT_TYPE` | _off_ | Strict agent-type validation. |
| `PP_EIGHTS_DAEMON` | _(unset)_ | TheEights daemon endpoint (only relevant when `PP_ECOSYSTEM` is on). |
| `PP_MAX_CONCURRENT_RUNS` | — | `TODO(M5d)`: run-concurrency cap is **not yet implemented**; the variable is documented here for forward-compatibility but has no effect today. |

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

`TODO(M7)`: hook event wiring, the autogenesis LLM analyzer, and the
visual/browser validation steps are completed in M7; sections of the guide that
reference them are marked accordingly.
