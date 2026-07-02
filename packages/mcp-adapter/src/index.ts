/**
 * @pp/mcp-adapter — a pp_harness-compatible MCP stdio server over @pp/core.
 *
 * Library surface (the stdio entry point is dist/bin.js, registered as `pp-mcp`).
 */
export { buildServer, runHarnessMcpServer } from "./server.js";
export { TOOLS, toolCoverage, type ToolDef, type ToolAvailability } from "./tools.js";
