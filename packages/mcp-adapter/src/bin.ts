#!/usr/bin/env node
/**
 * Entry point for the pp_harness MCP stdio server.
 * Register in an .mcp.json as: `node packages/mcp-adapter/dist/bin.js`.
 */
import { runHarnessMcpServer } from "./server.js";

runHarnessMcpServer().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("pp_harness adapter failed to start:", err);
  process.exit(1);
});
