#!/usr/bin/env node
/**
 * Production-ish launcher: start the control-plane server serving the built UI
 * with the REAL pi engine on the default DB (~/.pair-programmer/state.db).
 * Requires provider keys configured (via the UI or pi auth) for live runs.
 *
 * Invoked by `pnpm start` (which builds ui + server first). Override PP_PORT /
 * PP_UI_DIST / PP_DB_PATH / PP_API_TOKEN via the environment.
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

process.env.PP_UI_DIST = process.env.PP_UI_DIST ?? join(root, "ui", "dist");
process.env.PP_PORT = process.env.PP_PORT ?? "7878";

console.log(`[start] pi engine · UI=${process.env.PP_UI_DIST} · http://127.0.0.1:${process.env.PP_PORT}`);

await import(pathToFileURL(join(root, "packages", "server", "dist", "bin", "ppd.js")).href);
