#!/usr/bin/env node
/**
 * `ppd` — start the pi-pp-platform control-plane server on 127.0.0.1:7878
 * (override with PP_PORT). Serves ui/dist when PP_UI_DIST is set.
 */
import { buildApp } from "../app.js";

const PORT = Number(process.env.PP_PORT ?? 7878);
const HOST = "127.0.0.1";

async function main(): Promise<void> {
  const app = await buildApp({
    uiDistPath: process.env.PP_UI_DIST,
  });
  await app.listen({ port: PORT, host: HOST });
  // eslint-disable-next-line no-console
  console.log(`pi-pp-platform server listening on http://${HOST}:${PORT}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("ppd failed to start:", err);
  process.exit(1);
});
