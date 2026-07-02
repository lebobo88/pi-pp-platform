/**
 * pp_harness MCP stdio server (compat adapter).
 *
 * Server name `pp_harness`, stdio transport — so external hosts (Hydra gateway,
 * TheEights pp-adapter, any MCP client) can drive @pp/core's read/record surface
 * without change. Registered but non-runnable tools return a structured
 * {error:"not_available_in_adapter"} result (see tools.ts).
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { errorContent, jsonContent, zodToJsonSchema } from "./helpers.js";
import { TOOLS } from "./tools.js";

export function buildServer(): Server {
  const server = new Server({ name: "pp_harness", version: "0.1.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: zodToJsonSchema(t.schema),
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return errorContent(new Error(`unknown tool: ${name}`));
    try {
      // Some MCP clients string-serialize untyped params; decode defensively so
      // per-tool zod schemas see the object shape they expect.
      let safeArgs: unknown = args ?? {};
      if (typeof safeArgs === "string") {
        try { safeArgs = JSON.parse(safeArgs); } catch { /* fall through to schema error */ }
      }
      const result = await tool.handler(safeArgs);
      return jsonContent(result);
    } catch (err) {
      return errorContent(err);
    }
  });

  return server;
}

export async function runHarnessMcpServer(): Promise<void> {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Exit cleanly when the client disconnects (transport close or stdin EOF).
  const shutdown = () => process.exit(0);
  const sdkOnclose = transport.onclose;
  transport.onclose = () => {
    try { sdkOnclose?.(); } catch { /* best-effort */ }
    shutdown();
  };
  process.stdin.once("end", shutdown);
}
