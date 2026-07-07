import { describe, it, expect } from "vitest";
import { resolveTier, escalateTierForRetry, parseTierFlag } from "../src/tier-resolver.js";
import { generationModelIdForTier } from "../src/generation-model.js";
import { TierResolutionError } from "../src/errors.js";
import type { ModelTierPolicy } from "@pp/core";

const base = { stageKind: "code", scope: "standard" as const, flags: {} };

describe("resolveTier — layered precedence", () => {
  it("uses the agent frontmatter default (engineer → sonnet)", () => {
    const r = resolveTier({ ...base, agent: "engineer" });
    expect(r.tier).toBe("sonnet");
    expect(r.model_id).toBe("claude-sonnet-4-6");
    expect(r.trace.map((t) => t.layer)).toEqual(["frontmatter"]);
  });

  it("team_yaml model_tier overrides the frontmatter default", () => {
    const r = resolveTier({ ...base, agent: "engineer", teamStageModelTier: "opus" });
    expect(r.tier).toBe("opus");
    expect(r.trace.some((t) => t.layer === "team_yaml")).toBe(true);
  });

  it("scope_adjust shifts along the ladder (major +1: sonnet → opus)", () => {
    const policy: ModelTierPolicy = { scope_adjust: { major: 1 } };
    const r = resolveTier({ ...base, agent: "engineer", scope: "major", profilePolicy: policy });
    expect(r.tier).toBe("opus");
    expect(r.trace.some((t) => t.layer === "scope_adjust")).toBe(true);
  });

  it("profile default_cap clamps down (opus agent capped to sonnet)", () => {
    const policy: ModelTierPolicy = { default_cap: "sonnet" };
    const r = resolveTier({ ...base, agent: "spec-author", stageKind: "spec", profilePolicy: policy });
    expect(r.tier).toBe("sonnet");
    expect(r.trace.some((t) => t.layer === "profile_cap")).toBe(true);
  });

  it("profile per_stage_override beats default_cap (assignment)", () => {
    const policy: ModelTierPolicy = { default_cap: "haiku", per_stage_override: { code: "opus" } };
    const r = resolveTier({ ...base, agent: "engineer", stageKind: "code", profilePolicy: policy });
    expect(r.tier).toBe("opus");
    expect(r.trace.some((t) => t.layer === "profile_per_stage")).toBe(true);
  });

  it("--no-tier-policy bypasses the profile policy", () => {
    const policy: ModelTierPolicy = { default_cap: "haiku" };
    const r = resolveTier({ ...base, agent: "spec-author", stageKind: "spec", profilePolicy: policy, flags: { noTierPolicy: true } });
    expect(r.tier).toBe("opus");
  });

  it("cli tier_cap clamps down (opus agent → haiku)", () => {
    const r = resolveTier({ ...base, agent: "spec-author", stageKind: "spec", flags: { tierCap: "haiku" } });
    expect(r.tier).toBe("haiku");
    expect(r.trace.some((t) => t.layer === "cli_cap")).toBe(true);
  });

  it("cli tier_floor clamps up (sonnet agent → opus)", () => {
    const r = resolveTier({ ...base, agent: "engineer", flags: { tierFloor: "opus" } });
    expect(r.tier).toBe("opus");
    expect(r.trace.some((t) => t.layer === "cli_floor")).toBe(true);
  });

  it("fable is off-ladder: a team pin survives a tier_cap (never clamped)", () => {
    const r = resolveTier({ ...base, agent: "engineer", teamStageModelTier: "fable", flags: { tierCap: "opus" } });
    expect(r.tier).toBe("fable");
    expect(r.model_id).toBe("claude-fable-5");
    expect(r.trace.some((t) => t.layer === "fable_capability_gate")).toBe(true);
    // No cli_cap entry — the off-ladder guard skips the numeric comparison.
    expect(r.trace.some((t) => t.layer === "cli_cap")).toBe(false);
  });

  it("throws when the agent has no tier default", () => {
    expect(() => resolveTier({ ...base, agent: "nonexistent-agent" })).toThrow(TierResolutionError);
  });
});

describe("resolveTier — greenfield major tier floor (R7)", () => {
  it("floors greenfield+major to the ladder top (engineer sonnet → opus) with a trace entry", () => {
    const r = resolveTier({ ...base, agent: "engineer", scope: "major", greenfield: true });
    expect(r.tier).toBe("opus");
    expect(r.model_id).toBe(generationModelIdForTier("opus"));
    expect(r.trace.some((t) => t.layer === "greenfield_floor")).toBe(true);
  });

  it("does NOT floor greenfield at standard scope", () => {
    const r = resolveTier({ ...base, agent: "engineer", scope: "standard", greenfield: true });
    expect(r.tier).toBe("sonnet");
    expect(r.trace.some((t) => t.layer === "greenfield_floor")).toBe(false);
  });

  it("does NOT floor a non-greenfield major run", () => {
    const r = resolveTier({ ...base, agent: "engineer", scope: "major", greenfield: false });
    expect(r.tier).toBe("sonnet");
    expect(r.trace.some((t) => t.layer === "greenfield_floor")).toBe(false);
  });

  it("an explicit tier_cap still caps a floored greenfield stage (cap wins)", () => {
    const r = resolveTier({
      ...base,
      agent: "engineer",
      scope: "major",
      greenfield: true,
      flags: { tierCap: "sonnet" },
    });
    expect(r.tier).toBe("sonnet");
    // The floor still fired first, then the CLI cap clamped it back down.
    expect(r.trace.some((t) => t.layer === "greenfield_floor")).toBe(true);
    expect(r.trace.some((t) => t.layer === "cli_cap")).toBe(true);
  });

  it("a profile default_cap also clamps a floored greenfield stage (cap wins)", () => {
    const policy: ModelTierPolicy = { default_cap: "sonnet" };
    const r = resolveTier({ ...base, agent: "engineer", scope: "major", greenfield: true, profilePolicy: policy });
    expect(r.tier).toBe("sonnet");
    expect(r.trace.some((t) => t.layer === "greenfield_floor")).toBe(true);
    expect(r.trace.some((t) => t.layer === "profile_cap")).toBe(true);
  });
});

describe("escalateTierForRetry", () => {
  it("bumps one step and clamps at opus", () => {
    expect(escalateTierForRetry("haiku", {}, "fail").tier).toBe("sonnet");
    expect(escalateTierForRetry("sonnet", {}, "fail").tier).toBe("opus");
    expect(escalateTierForRetry("opus", {}, "fail").tier).toBe("opus");
  });

  it("leaves off-ladder fable unchanged", () => {
    expect(escalateTierForRetry("fable", {}, "fail").tier).toBe("fable");
  });

  it("applies the cli floor on retry (ladder tiers only)", () => {
    expect(escalateTierForRetry("haiku", { tierFloor: "opus" }, "fail").tier).toBe("opus");
  });
});

describe("parseTierFlag", () => {
  it("accepts ladder tiers", () => {
    expect(parseTierFlag("opus")).toBe("opus");
    expect(parseTierFlag("SONNET")).toBe("sonnet");
  });
  it("rejects fable and garbage", () => {
    expect(() => parseTierFlag("fable")).toThrow(/expected opus\|sonnet\|haiku/);
    expect(() => parseTierFlag("xxl")).toThrow();
  });
});
