#!/usr/bin/env node
/**
 * Production launcher: the control-plane server with the REAL pi engine on the
 * persistent DB (~/.pair-programmer/state.db), serving the built UI.
 *
 * Hardened vs `start.mjs`: sets NODE_ENV=production and refuses to start on a
 * non-loopback host without PP_API_TOKEN. Invoked by `pnpm serve` (builds ui +
 * server first). Override PP_HOST / PP_PORT / PP_UI_DIST / PP_DB_PATH /
 * PP_API_TOKEN via the environment. Set PP_ECOSYSTEM=1 to enable Hydra/TheEights.
 */
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

process.env.NODE_ENV = process.env.NODE_ENV ?? "production";
process.env.PP_UI_DIST = process.env.PP_UI_DIST ?? join(root, "ui", "dist");
process.env.PP_PORT = process.env.PP_PORT ?? "7878";
process.env.PP_HOST = process.env.PP_HOST ?? "127.0.0.1";
// Intentionally NOT setting PP_LLM → real pi engine; NOT overriding PP_DB_PATH → persistent DB.

const host = process.env.PP_HOST;
const networked = !["127.0.0.1", "::1", "localhost"].includes(host);
if (networked && !process.env.PP_API_TOKEN) {
  console.error(
    `[serve] PP_HOST=${host} is non-loopback but PP_API_TOKEN is not set — ` +
      `refusing to start unauthenticated. Set PP_API_TOKEN, or bind PP_HOST=127.0.0.1.`,
  );
  process.exit(1);
}

console.log(
  `[serve] production · pi engine · UI=${process.env.PP_UI_DIST} · ` +
    `http://${host}:${process.env.PP_PORT}` + (networked ? " · auth=bearer" : " · loopback"),
);

await import(pathToFileURL(join(root, "packages", "server", "dist", "bin", "ppd.js")).href);
