#!/usr/bin/env node
/**
 * Dev launcher: a fake-engine control-plane API on :7878 + the Vite dev server
 * (HMR) on :5273 which proxies /api → 7878. One command, two processes, clean
 * teardown on Ctrl-C. No provider keys or tokens needed.
 *
 *   pnpm dev
 *
 * For a live backend instead of the fake engine, set PP_LLM=pi (needs keys).
 */
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const children = [];
let shuttingDown = false;

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const c of children) { try { c.kill(); } catch { /* already gone */ } }
  process.exit(code);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

function run(cmd, args, env, name, { critical = true } = {}) {
  const child = spawn(cmd, args, { cwd: root, env: { ...process.env, ...env }, stdio: "inherit", shell: true });
  child.on("exit", (code) => {
    console.log(`[dev] ${name} exited (${code ?? "signal"})`);
    if (critical) shutdown(code ?? 0);
  });
  children.push(child);
  return child;
}

console.log("[dev] building @pp/server…");
run("pnpm", ["-F", "@pp/server", "build"], {}, "server-build", { critical: false }).on("exit", (code) => {
  if (code !== 0) return shutdown(code ?? 1);
  const dbDir = mkdtempSync(join(tmpdir(), "pp-dev-"));
  const port = process.env.PP_PORT ?? "7878";
  console.log(`[dev] starting fake-engine API on http://127.0.0.1:${port} …`);
  run(
    "node",
    [join("packages", "server", "dist", "bin", "ppd.js")],
    { PP_LLM: process.env.PP_LLM ?? "fake", PP_DB_PATH: join(dbDir, "dev.db"), PP_PORT: port, PP_UI_DIST: "" },
    "ppd",
  );
  console.log("[dev] starting Vite (HMR) on http://localhost:5273 …");
  run("pnpm", ["-F", "@pp/ui", "dev"], { PP_DAEMON_ORIGIN: `http://127.0.0.1:${port}` }, "vite");
});
