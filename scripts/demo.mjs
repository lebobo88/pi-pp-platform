#!/usr/bin/env node
/**
 * Demo launcher: start the control-plane server serving the built UI with the
 * FAKE engine on a throwaway DB, so anyone can click through the real UI against
 * the real server without spending tokens or touching their real harness state.
 *
 * Invoked by `pnpm demo` (which builds ui + server first). Override any of
 * PP_PORT / PP_UI_DIST / PP_DB_PATH / PP_LLM via the environment.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

process.env.PP_LLM = process.env.PP_LLM ?? "fake";
process.env.PP_UI_DIST = process.env.PP_UI_DIST ?? join(root, "ui", "dist");
process.env.PP_DB_PATH = process.env.PP_DB_PATH ?? join(mkdtempSync(join(tmpdir(), "pp-demo-")), "demo.db");
process.env.PP_SKIP_CLI_VERSIONS = process.env.PP_SKIP_CLI_VERSIONS ?? "1";
process.env.PP_PORT = process.env.PP_PORT ?? "7878";
// Ecosystem stays off in the demo (no eights-daemon spawn).
delete process.env.PP_ECOSYSTEM;

console.log(`[demo] fake-engine runs · UI=${process.env.PP_UI_DIST} · db=${process.env.PP_DB_PATH} · http://127.0.0.1:${process.env.PP_PORT}`);

await import(pathToFileURL(join(root, "packages", "server", "dist", "bin", "ppd.js")).href);
