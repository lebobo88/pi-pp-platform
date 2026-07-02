// PP_ECOSYSTEM guard: proves the ecosystem clients never probe/spawn an
// eights-daemon unless PP_ECOSYSTEM=1. Runs against the compiled dist/.
//
// The proof is the connection state discriminant: `_stateKindForTest()` stays
// "uninit" when disabled (the guard returns before probe() runs, so no
// transport/subprocess is ever created). When enabled it transitions to
// "unavailable" (probe ran, resolved no daemon entry) — WITHOUT spawning a real
// child, because we point PP_EIGHTS_DAEMON at a non-existent path.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

async function main() {
  const config = await importDist("config.js");
  const client = await importDist("ecosystem/eights-client.js");
  const envelopes = await importDist("ecosystem/hydra-envelopes.js");

  // 1. The gate function itself.
  delete process.env.PP_ECOSYSTEM;
  assert.equal(config.ecosystemEnabled(), false, "default OFF when PP_ECOSYSTEM unset");
  process.env.PP_ECOSYSTEM = "0";
  assert.equal(config.ecosystemEnabled(), false, "OFF when PP_ECOSYSTEM=0");
  process.env.PP_ECOSYSTEM = "1";
  assert.equal(config.ecosystemEnabled(), true, "ON when PP_ECOSYSTEM=1");

  // 2. Disabled → isAvailable() false and NO probe ran (state stays uninit,
  //    meaning no transport/subprocess was ever created).
  delete process.env.PP_ECOSYSTEM;
  await client.shutdown(); // reset state → uninit
  assert.equal(client._stateKindForTest(), "uninit", "state starts uninit after shutdown");
  assert.equal(await client.isAvailable(), false, "isAvailable() false when disabled");
  assert.equal(
    client._stateKindForTest(),
    "uninit",
    "guard short-circuited BEFORE probe — no spawn when disabled",
  );
  assert.equal(client.isAvailableSync(), false, "isAvailableSync() false when disabled");

  // 3. The exact path finalize_run exercises: emitDecisionRecord must degrade
  //    (recorded=false) WITHOUT probing/spawning when PP_ECOSYSTEM is unset.
  const dr = await envelopes.emitDecisionRecord({
    run_id: "run_guard_1",
    project_path: "C:\\tmp\\fake-guard",
    workflow_id: "wf_guard_1",
    origin_squad: "engineering",
    request_text: "guard test",
    status: "complete",
    summary_md: "# done",
    artifact_count: 0,
  });
  assert.equal(dr.recorded, false, "emitDecisionRecord degrades (recorded=false) when disabled");
  assert.equal(
    client._stateKindForTest(),
    "uninit",
    "finalize_run's emit path did not probe/spawn when disabled",
  );

  // 4. When ENABLED, probe DOES run (state leaves "uninit") — but still no real
  //    subprocess, since the daemon entry points at a non-existent path so
  //    resolveDaemonEntry() returns null before any transport is created.
  //    (The exact post-probe discriminant is "probing"/"unavailable" depending
  //    on async ordering; the load-bearing contrast with step 2/3 is simply
  //    that the guard let the probe run at all — i.e. it is no longer "uninit".)
  process.env.PP_ECOSYSTEM = "1";
  process.env.PP_EIGHTS_DAEMON = join(__dirname, "this-daemon-does-not-exist.js");
  await client.shutdown();
  assert.equal(await client.isAvailable(), false, "isAvailable() false with bogus daemon");
  assert.notEqual(
    client._stateKindForTest(),
    "uninit",
    "when enabled, the guard let probe run (state left uninit) — contrast with disabled",
  );

  // Cleanup so we don't leak the enabled flag into sibling tests.
  delete process.env.PP_ECOSYSTEM;
  delete process.env.PP_EIGHTS_DAEMON;
  await client.shutdown();

  console.log("✓ ecosystem-guard.unit.mjs: PP_ECOSYSTEM gate blocks probe/spawn by default");
}

main().catch((err) => {
  console.error("✗ ecosystem-guard.unit.mjs failed:", err);
  process.exit(1);
});
