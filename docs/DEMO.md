# Demo & run the platform

Two convenience launchers boot the control-plane server (`@pp/server`, Fastify
REST + SSE on `127.0.0.1:7878`) serving the built React UI. Both build the UI
and server first.

## `pnpm demo` — click through the real UI with zero cost

```bash
pnpm demo
```

Starts the server with the **fake engine** (`PP_LLM=fake`) on a **throwaway DB**
(a fresh temp file), so you can drive the whole UI — launch runs, watch the live
run view stream over SSE, browse the library, edit budget caps and settings —
without spending a single token or touching your real harness state. Fake runs
write a committed fixture artifact per stage and always pass, so a run goes
green in a few seconds.

Open <http://127.0.0.1:7878> and click around.

## `pnpm start` — production-ish

```bash
pnpm start
```

Starts the server with the **real pi engine** on the **default DB**
(`~/.pair-programmer/state.db`). Configure provider API keys first (via the UI's
Providers screen, or the `pi` auth flow) so live runs can reach your configured
vendors (any of the 35 supported providers).

## Environment overrides

| var | default | meaning |
|---|---|---|
| `PP_PORT` | `7878` | listen port (loopback only) |
| `PP_UI_DIST` | `ui/dist` | built SPA directory to serve |
| `PP_DB_PATH` | temp (demo) / `~/.pair-programmer/state.db` (start) | SQLite path |
| `PP_LLM` | `fake` (demo) / `pi` (start) | engine mode |
| `PP_API_TOKEN` | unset | when set, all routes except `GET /healthz` require `Authorization: Bearer <token>` (SSE endpoints also accept `?token=`; the UI prompts once and stores it) |
| `PP_MAX_CONCURRENT_RUNS` | `2` | live-run concurrency (extras queue) |

The server binds loopback only and never returns raw provider keys (only masked
fingerprints).

## Registering the MCP adapter with an external host

The repo ships a root `.mcp.json` that registers the `pp_harness`-compatible MCP
stdio server (`@pp/mcp-adapter`) for any MCP client (Claude Code, the Hydra
gateway, TheEights pp-adapter):

```json
{ "mcpServers": { "pp_harness": { "command": "node", "args": ["packages/mcp-adapter/dist/bin.js"] } } }
```

Build it first (`pnpm -F @pp/mcp-adapter build`); the path is relative to the
repo root, so invoke the host from there (or replace with an absolute path).
