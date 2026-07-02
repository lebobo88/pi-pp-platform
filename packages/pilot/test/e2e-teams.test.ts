import { describe, it, expect } from "vitest";
import { getTeam } from "@pp/core";
import { resolveTier } from "../src/tier-resolver.js";

describe("Teams — deep-reasoning-team fable pin (sanctioned fable path)", () => {
  it("loads the builtin team yaml and pins fable through the tier resolver", () => {
    const found = getTeam({ name: "deep-reasoning-team", project_path: process.cwd() });
    expect(found).not.toBeNull();
    const team = found!.team;

    // Every generator stage pins model_tier: fable in the yaml.
    const fableStages = team.stages.filter((s) => s.generator.model_tier === "fable");
    expect(fableStages.length).toBeGreaterThan(0);

    // The resolver honors an explicit team_yaml fable pin and — critically —
    // does NOT clamp it down even under an opus tier cap (off-ladder guard).
    for (const stage of fableStages) {
      const r = resolveTier({
        agent: stage.generator.agent,
        stageKind: stage.kind,
        scope: "major",
        teamStageModelTier: stage.generator.model_tier,
        flags: { tierCap: "opus" },
      });
      expect(r.tier).toBe("fable");
      expect(r.model_id).toBe("claude-fable-5");
    }

    // The code stage uses a 2-way best-of race on major scope (fable is pricey).
    const codeStage = team.stages.find((s) => s.kind === "code");
    expect(codeStage?.best_of_n_on_major_scope).toBe(2);
  });
});
