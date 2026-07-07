import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { refreshCatalog } from "@pp/core";
import {
  effectiveLadderTiers,
  effectiveTierPools,
  generationModelIdForTier,
  type LadderOverride,
} from "../src/generation-model.js";
import { escalateTierForRetry } from "../src/tier-resolver.js";

// A per-tier pool applied via the profile/override argument — the deterministic
// seam that needs no on-disk catalog. Mirrors what a project profile supplies.
const POOL_OV: LadderOverride = { tier_pools: { sonnet: ["m-a", "m-b", "m-c"] } };

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
