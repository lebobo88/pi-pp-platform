/**
 * Test helper: spawn the built pp_harness adapter (dist/bin.js) over stdio and
 * return an MCP client. Each adapter runs with an isolated PP_HOME so the
 * harness SQLite DB never touches the developer's real state.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BIN = join(__dirname, "..", "dist", "bin.js");

export interface Adapter {
  client: Client;
  ppHome: string;
  close: () => Promise<void>;
}

export async function startAdapter(): Promise<Adapter> {
  const ppHome = mkdtempSync(join(tmpdir(), "pp-mcp-home-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [BIN],
    env: { ...getDefaultEnvironment(), PP_HOME: ppHome },
  });
  const client = new Client({ name: "pp-mcp-adapter-test", version: "0.0.1" }, { capabilities: {} });
  await client.connect(transport);
  return {
    client,
    ppHome,
    close: async () => { await client.close(); },
  };
}

/** Call a tool and JSON-parse its text result. Throws on isError. */
export async function callTool<T = any>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content?: Array<{ text?: string }>;
  };
  if (result.isError) throw new Error(`tool ${name} failed: ${JSON.stringify(result.content)}`);
  const text = result.content?.[0]?.text;
  return (text ? JSON.parse(text) : null) as T;
}
