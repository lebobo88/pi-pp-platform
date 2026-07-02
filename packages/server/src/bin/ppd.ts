#!/usr/bin/env node
/**
 * `ppd` — start the pi-pp-platform control-plane server.
 *
 * Binds 127.0.0.1:7878 by default. Override PP_PORT / PP_HOST. Serves ui/dist
 * when PP_UI_DIST is set. Binding a NON-loopback host requires PP_API_TOKEN
 * (the Bearer gate) — the server refuses to expose itself unauthenticated.
 */
import { buildApp } from "../app.js";

const PORT = Number(process.env.PP_PORT ?? 7878);
const HOST = process.env.PP_HOST ?? "127.0.0.1";
const TOKEN = process.env.PP_API_TOKEN;

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

async function main(): Promise<void> {
  if (!isLoopback(HOST) && !TOKEN) {
    // eslint-disable-next-line no-console
    console.error(
      `[ppd] refusing to bind non-loopback host "${HOST}" without PP_API_TOKEN.\n` +
        `      Set PP_API_TOKEN to require a Bearer token, or bind PP_HOST=127.0.0.1 (loopback).`,
    );
    process.exit(1);
  }

  const app = await buildApp({ uiDistPath: process.env.PP_UI_DIST });
  await app.listen({ port: PORT, host: HOST });
  const engine = process.env.PP_LLM === "fake" ? "fake" : "pi";
  // eslint-disable-next-line no-console
  console.log(
    `pi-pp-platform server listening on http://${HOST}:${PORT} · engine=${engine}` +
      (TOKEN ? " · auth=bearer" : isLoopback(HOST) ? " · auth=none (loopback)" : ""),
  );

  let closing = false;
  const shutdown = async (sig: string): Promise<void> => {
    if (closing) return;
    closing = true;
    // eslint-disable-next-line no-console
    console.log(`\n[ppd] ${sig} received — draining connections…`);
    try {
      await app.close();
      // eslint-disable-next-line no-console
      console.log("[ppd] closed cleanly.");
      process.exit(0);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error("[ppd] error during shutdown:", err);
      process.exit(1);
    }
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("ppd failed to start:", err);
  process.exit(1);
});
