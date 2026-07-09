import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshCatalog, setDbPath, currentDbPath, setPlatformSetting } from "@pp/core";
import {
  effectiveLadderTiers,
  effectiveTierPools,
  generationModelIdForTier,
  mergeLadderOverride,
  type LadderOverride,
} from "../src/generation-model.js";
import { escalateTierForRetry } from "../src/tier-resolver.js";

// A per-tier pool applied via the profile/override argument — the deterministic
// seam that needs no on-disk catalog. Mirrors what a project profile supplies.
const POOL_OV: LadderOverride = { tier_pools: { sonnet: ["m-a", "m-b", "m-c"] } };
const PROVIDER_SPECIFIC_POOL_OV: LadderOverride = {
  tier_pools: { haiku: ["openai/gpt-5.4-mini", "azure-openai/gpt-5.4-mini"] },
};

describe("generationModelIdForTier — pool rotation", () => {
  it("first attempt draws pool[0] (rotationIndex undefined and 0)", () => {
    expect(generationModelIdForTier("sonnet", undefined, POOL_OV)).toBe("m-a");
    expect(generationModelIdForTier("sonnet", 0, POOL_OV)).toBe("m-a");
  });

  it("a retry (rotationIndex=1) draws the NEXT pool model, pool[1]", () => {
    expect(generationModelIdForTier("sonnet", 1, POOL_OV)).toBe("m-b");
  });

  it("best-of candidates (rotationIndex=candidateIndex) draw distinct models", () => {
    const models = [1, 2, 3].map((i) => generationModelIdForTier("sonnet", i, POOL_OV));
    expect(models).toEqual(["m-b", "m-c", "m-a"]);
    expect(new Set(models).size).toBe(3);
  });

  it("rotationIndex wraps modulo pool length", () => {
    expect(generationModelIdForTier("sonnet", 4, POOL_OV)).toBe("m-b"); // 4 % 3 === 1
  });

  it("preserves provider-qualified priority order for same-named models on different providers", () => {
    expect(generationModelIdForTier("haiku", 0, PROVIDER_SPECIFIC_POOL_OV)).toBe("openai/gpt-5.4-mini");
    expect(generationModelIdForTier("haiku", 1, PROVIDER_SPECIFIC_POOL_OV)).toBe("azure-openai/gpt-5.4-mini");
    expect(generationModelIdForTier("haiku", 2, PROVIDER_SPECIFIC_POOL_OV)).toBe("openai/gpt-5.4-mini");
  });

  it("absent pool falls back to tiers[tier] and ignores rotationIndex", () => {
    // opus has no pool in POOL_OV → the single-model ladder value, unindexed.
    expect(generationModelIdForTier("opus", 2, POOL_OV)).toBe("claude-opus-4-7");
  });

  it("no pools anywhere → byte-identical single-model resolution", () => {
    expect(generationModelIdForTier("sonnet")).toBe("claude-sonnet-4-6");
    expect(generationModelIdForTier("sonnet", 3)).toBe("claude-sonnet-4-6");
    expect(generationModelIdForTier("opus", 7)).toBe("claude-opus-4-7");
  });
});

describe("effectiveTierPools — layering", () => {
  it("no override → catalog pools (empty by default)", () => {
    expect(effectiveTierPools()).toEqual({});
  });

  it("profile pools merge over the (empty) catalog base", () => {
    expect(effectiveTierPools(POOL_OV)).toEqual({ sonnet: ["m-a", "m-b", "m-c"] });
  });
});

describe("effectiveLadderTiers — profile-over-global precedence", () => {
  it("no override → the global/catalog base ladder", () => {
    const tiers = effectiveLadderTiers();
    expect(tiers.sonnet).toBe("claude-sonnet-4-6");
    expect(tiers.opus).toBe("claude-opus-4-7");
  });

  it("a profile ladder override wins per-tier over the base", () => {
    const ov: LadderOverride = { ladder: { sonnet: "openai/gpt-5.5" } };
    expect(effectiveLadderTiers(ov).sonnet).toBe("openai/gpt-5.5");
    // untouched tiers keep the base value…
    expect(effectiveLadderTiers(ov).opus).toBe("claude-opus-4-7");
    // …and the override does not leak into a subsequent unoverridden call.
    expect(effectiveLadderTiers().sonnet).toBe("claude-sonnet-4-6");
  });
});

// Real wiring: escalateTierForRetry forwards rotationIndex to
// generationModelIdForTier, which reads pools from the effective (catalog)
// ladder. Proven with an on-disk user catalog rather than the override seam.
describe("escalateTierForRetry rotates through the escalated tier's catalog pool", () => {
  const prevPlatformDir = process.env.PP_PLATFORM_DIR;
  let platform: string;

  beforeAll(() => {
    platform = mkdtempSync(join(tmpdir(), "pp-pool-catalog-"));
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
            tier_pools: { opus: ["opus-pool-0", "opus-pool-1", "opus-pool-2"] },
          },
        },
      }),
      "utf8",
    );
    process.env.PP_PLATFORM_DIR = platform;
    refreshCatalog();
  });

  afterAll(() => {
    if (prevPlatformDir === undefined) delete process.env.PP_PLATFORM_DIR;
    else process.env.PP_PLATFORM_DIR = prevPlatformDir;
    refreshCatalog(); // restore the bundled catalog for later test files
    rmSync(platform, { recursive: true, force: true });
  });

  it("sonnet→opus retry with rotationIndex=1 draws opus pool[1]", () => {
    const esc = escalateTierForRetry("sonnet", {}, "retry", 1);
    expect(esc.tier).toBe("opus");
    expect(esc.model_id).toBe("opus-pool-1");
  });

  it("without a rotationIndex the retry draws pool[0]", () => {
    const esc = escalateTierForRetry("sonnet", {}, "retry");
    expect(esc.model_id).toBe("opus-pool-0");
  });
});

// ── Full 4-level precedence, for BOTH tiers and tier_pools ────────────────────
//   per-run override > project profile > harness_settings.ladders[name] > catalog
// Crucially re-proves the prior finding: a tier_pool set ONLY in harness_settings
// (never in the catalog or the override) is now read + used by effectiveTierPools
// / generationModelIdForTier. Uses an on-disk user catalog for the catalog layer,
// an isolated DB for the harness_settings layer, and the override argument for the
// profile + per-run layers (assembled via mergeLadderOverride).
describe("ladder precedence: catalog < harness_settings < profile < per-run", () => {
  const prevPlatformDir = process.env.PP_PLATFORM_DIR;
  let platform: string;
  let dbDir: string;
  let prevDbPath: string;

  beforeAll(() => {
    platform = mkdtempSync(join(tmpdir(), "pp-precedence-catalog-"));
    writeFileSync(
      join(platform, "catalog.json"),
      JSON.stringify({
        default_ladder: "claude",
        generation_ladders: {
          claude: {
            provider: "anthropic",
            order: ["haiku", "sonnet", "opus"],
            off_ladder: ["fable"],
            tiers: { haiku: "cat-haiku", sonnet: "cat-sonnet", opus: "cat-opus", fable: "cat-fable" },
            // catalog pool ONLY for haiku — sonnet's pool will come from settings.
            tier_pools: { haiku: ["cat-haiku-0", "cat-haiku-1"] },
          },
        },
      }),
      "utf8",
    );
    process.env.PP_PLATFORM_DIR = platform;
    refreshCatalog();

    // Isolate the DB so the harness_settings row we write here never pollutes
    // the shared PP_HOME state.db other test files read.
    prevDbPath = currentDbPath();
    dbDir = mkdtempSync(join(tmpdir(), "pp-precedence-db-"));
    setDbPath(join(dbDir, "state.db"));

    // harness_settings layer: override sonnet's TIER, and supply a tier_pool for
    // sonnet that exists NOWHERE else (the prior-finding case).
    setPlatformSetting("harness_settings", {
      ladders: {
        claude: {
          sonnet: "set-sonnet",
          tier_pools: { sonnet: ["set-sonnet-0", "set-sonnet-1"] },
        },
      },
      judge_pool: [{ provider: "anthropic", model: "cat-opus" }],
    });
  });

  afterAll(() => {
    if (prevPlatformDir === undefined) delete process.env.PP_PLATFORM_DIR;
    else process.env.PP_PLATFORM_DIR = prevPlatformDir;
    refreshCatalog();
    setDbPath(prevDbPath); // restore the shared PP_HOME DB for later files
    rmSync(platform, { recursive: true, force: true });
    rmSync(dbDir, { recursive: true, force: true });
  });

  it("catalog default is used where no higher layer speaks (opus tier, haiku pool)", () => {
    expect(effectiveLadderTiers().opus).toBe("cat-opus");
    expect(effectiveTierPools().haiku).toEqual(["cat-haiku-0", "cat-haiku-1"]);
  });

  it("harness_settings TIER wins over the catalog tier", () => {
    expect(effectiveLadderTiers().sonnet).toBe("set-sonnet");
    // opus is untouched by settings → still the catalog value.
    expect(effectiveLadderTiers().opus).toBe("cat-opus");
  });

  it("PRIOR FINDING: a tier_pool set ONLY in harness_settings is read and used", () => {
    // effectiveTierPools now merges the settings pool over the catalog pool.
    expect(effectiveTierPools().sonnet).toEqual(["set-sonnet-0", "set-sonnet-1"]);
    // …and generationModelIdForTier rotates through that settings-only pool
    // (pool wins over the single-model tier lookup).
    expect(generationModelIdForTier("sonnet", 0)).toBe("set-sonnet-0");
    expect(generationModelIdForTier("sonnet")).toBe("set-sonnet-0"); // undefined index → 0
    expect(generationModelIdForTier("sonnet", 1)).toBe("set-sonnet-1");
    // haiku (catalog-only pool) still rotates from the catalog.
    expect(generationModelIdForTier("haiku", 1)).toBe("cat-haiku-1");
  });

  it("a project-profile override wins over harness_settings (tier + pool)", () => {
    const profileOnly = mergeLadderOverride(
      { sonnet: "prof-sonnet" },
      { sonnet: ["prof-sonnet-0"] },
      undefined,
      undefined,
    );
    expect(effectiveLadderTiers(profileOnly).sonnet).toBe("prof-sonnet");
    expect(effectiveTierPools(profileOnly).sonnet).toEqual(["prof-sonnet-0"]);
    expect(generationModelIdForTier("sonnet", 0, profileOnly)).toBe("prof-sonnet-0");
  });

  it("a per-run override wins over the project profile (top precedence)", () => {
    const merged = mergeLadderOverride(
      { sonnet: "prof-sonnet", opus: "prof-opus" },
      { sonnet: ["prof-sonnet-0"] },
      { sonnet: "run-sonnet" },
      { sonnet: ["run-sonnet-0", "run-sonnet-1"] },
    );
    // per-run beats the profile for the tiers it names…
    expect(effectiveLadderTiers(merged).sonnet).toBe("run-sonnet");
    expect(effectiveTierPools(merged).sonnet).toEqual(["run-sonnet-0", "run-sonnet-1"]);
    expect(generationModelIdForTier("sonnet", 1, merged)).toBe("run-sonnet-1");
    // …while a profile-only tier (opus) is retained through the merge.
    expect(effectiveLadderTiers(merged).opus).toBe("prof-opus");
  });

  it("mergeLadderOverride returns undefined when nothing is supplied", () => {
    expect(mergeLadderOverride(undefined, undefined, undefined, undefined)).toBeUndefined();
    expect(mergeLadderOverride({}, {}, {}, {})).toBeUndefined();
  });
});
