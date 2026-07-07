// Unit tests for per-tier model POOLS config parsing.
//
// Covers:
//  - GenerationLadder.tier_pools: absent in the bundled catalog → tierPoolsFor() === {}
//  - a user catalog's tier_pools parses and surfaces through tierPoolsFor()
//    (the named ladder is replaced wholesale — tiers stay intact alongside pools)
//  - ProfileSpec.ladder / .tier_pools round-trip through resolveProfile:
//      * a spec with no `extends` is returned unchanged (passthrough)
//      * a spec that `extends` a builtin keeps its own ladder/tier_pools through
//        the deep-merge
//
// Self-contained: no daemon, no MCP, no live LLM calls.

import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import assert from "node:assert/strict";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-tier-pools-"));
mkdirSync(join(SUITE_DIR, ".pair-programmer"), { recursive: true });
process.env.PP_HOME = SUITE_DIR;
delete process.env.PP_DB_PATH; // isolate from any live dev server DB
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

let passed = 0;
let failed = 0;

function record(name, fn) {
  return fn().then(
    () => { console.log(`✓ ${name}`); passed++; },
    (err) => { console.error(`✗ ${name}\n  ${err.message}`); failed++; },
  );
}

await record("bundled catalog has no tier_pools → tierPoolsFor() === {}", async () => {
  const { tierPoolsFor, refreshCatalog } = await importDist("catalog/config.js");
  refreshCatalog();
  assert.deepEqual(tierPoolsFor(), {}, "default ladder must not ship pools");
});

await record("a user catalog's tier_pools parse + surface through tierPoolsFor()", async () => {
  const { tierPoolsFor, tierModelsFor, refreshCatalog } = await importDist("catalog/config.js");
  const platform = mkdtempSync(join(tmpdir(), "pp-tier-pools-catalog-"));
  writeFileSync(
    join(platform, "catalog.json"),
    JSON.stringify({
      generation_ladders: {
        claude: {
          provider: "anthropic",
          order: ["haiku", "sonnet", "opus"],
          off_ladder: ["fable"],
          tiers: {
            haiku: "claude-haiku-4-5-20251001",
            sonnet: "claude-sonnet-4-6",
            opus: "claude-opus-4-7",
            fable: "claude-fable-5",
          },
          // provider-qualified ids are legal pool entries.
          tier_pools: { sonnet: ["openai/gpt-5.5", "claude-sonnet-4-6"] },
        },
      },
    }),
    "utf8",
  );
  const prev = process.env.PP_PLATFORM_DIR;
  process.env.PP_PLATFORM_DIR = platform;
  refreshCatalog();
  try {
    assert.deepEqual(tierPoolsFor(), { sonnet: ["openai/gpt-5.5", "claude-sonnet-4-6"] });
    // The ladder is replaced wholesale, but the single-model tiers remain.
    assert.equal(tierModelsFor().opus, "claude-opus-4-7");
  } finally {
    if (prev === undefined) delete process.env.PP_PLATFORM_DIR;
    else process.env.PP_PLATFORM_DIR = prev;
    refreshCatalog();
    rmSync(platform, { recursive: true, force: true });
  }
});

await record("resolveProfile passes ladder/tier_pools through when there is no `extends`", async () => {
  const { resolveProfile } = await importDist("orchestrator/profiles.js");
  const spec = {
    name: "web-ui",
    description: "x",
    ladder: { sonnet: "openai/gpt-5.5" },
    tier_pools: { sonnet: ["a", "b"] },
  };
  const r = resolveProfile(spec);
  assert.deepEqual(r.ladder, { sonnet: "openai/gpt-5.5" });
  assert.deepEqual(r.tier_pools, { sonnet: ["a", "b"] });
});

await record("resolveProfile keeps a spec's own ladder/tier_pools through the extends deep-merge", async () => {
  const { resolveProfile } = await importDist("orchestrator/profiles.js");
  // Extend a real builtin (web-ui has no ladder of its own) so the merge path
  // runs; the spec's ladder/tier_pools must survive it.
  const spec = {
    name: "test-pool-profile",
    description: "x",
    extends: ["web-ui"],
    ladder: { opus: "openai/gpt-5.5" },
    tier_pools: { opus: ["opus-a", "opus-b"] },
  };
  const r = resolveProfile(spec);
  assert.equal(r.ladder.opus, "openai/gpt-5.5");
  assert.deepEqual(r.tier_pools.opus, ["opus-a", "opus-b"]);
  // Base contributions still merged in (web-ui ships required_artifacts).
  assert.ok(
    Array.isArray(r.required_artifacts) && r.required_artifacts.length > 0,
    "extends base artifacts must still merge in",
  );
});

console.log();
console.log(`${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
