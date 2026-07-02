# Deferred tests (M1)

These tests depend on the CLI critique bridges (`mcp/codex-server.ts`,
`mcp/gemini-server.ts`, `mcp/critique-bridge.ts`) or the harness MCP server
(`mcp/harness-server.ts`), all of which were removed from `@pp/core` in
Milestone 1. They are parked here and excluded from the default `test` script.

They will be replaced by engine-level tests in **M2** (the `pi` engine spike),
when generate/critique is reintroduced behind the injectable provider seam
(`setCritiqueSmokeProviders`) and the MCP server returns as `@pp/server`.

- `artifact-validators.unit.mjs` — imports `dist/mcp/critique-bridge.js` and
  `dist/mcp/codex-server.js` (both removed).
- `codex-escalation.unit.mjs` — imports `dist/mcp/codex-server.js` (removed);
  exercises Codex model-escalation logic that now lives outside core.
- `smoke.mjs` — spawns `node dist/index.js mcp` and drives the harness MCP
  server over stdio; `@pp/core` no longer ships an MCP server or CLI entry.
- `artifact-validators.smoke.mjs` — spawns `node dist/index.js mcp` and drives
  the harness MCP `artifact_validate` tool; depends on the removed MCP server.
- `best-of-data-loss.mjs` — spawns `node dist/index.js mcp` and drives the
  best-of-N MCP tools over stdio; depends on the removed MCP server.
