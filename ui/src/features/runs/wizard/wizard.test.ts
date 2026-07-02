import { describe, it, expect } from "vitest";
import {
  wizardReducer,
  initialWizardState,
  stepValid,
  canLaunch,
  toStartRequest,
  tierControlsDisabled,
  type WizardState,
} from "./wizardReducer";
import { estimateRunCost, defaultStageCount } from "./costEstimator";
import { isHighRiskRubric, confirmationPhrase, confirmationSatisfied } from "@/lib/riskRubric";

function fill(partial: Partial<WizardState>): WizardState {
  return { ...initialWizardState, ...partial };
}

describe("wizardReducer", () => {
  it("gates step 1 on project + request length", () => {
    expect(stepValid(initialWizardState, 1)).toBe(false);
    expect(stepValid(fill({ projectPath: "C:/x", requestText: "short" }), 1)).toBe(false);
    expect(stepValid(fill({ projectPath: "C:/x", requestText: "long enough request" }), 1)).toBe(true);
  });

  it("gates step 2 by mode", () => {
    expect(stepValid(fill({ mode: "team", team: "" }), 2)).toBe(false);
    expect(stepValid(fill({ mode: "team", team: "feature-team" }), 2)).toBe(true);
    expect(stepValid(fill({ mode: "best_of", n: 1 }), 2)).toBe(false);
    expect(stepValid(fill({ mode: "best_of", n: 3 }), 2)).toBe(true);
    expect(stepValid(fill({ mode: "single" }), 2)).toBe(true);
  });

  it("clears tier controls when switching to best-of (mirrors daemon 422)", () => {
    const s = fill({ tierCap: "opus", tierFloor: "haiku" });
    const next = wizardReducer(s, { type: "mode", mode: "best_of" });
    expect(next.tierCap).toBe("");
    expect(next.tierFloor).toBe("");
    expect(tierControlsDisabled("best_of")).toBe(true);
    expect(tierControlsDisabled("single")).toBe(false);
  });

  it("advances and clamps steps", () => {
    let s = initialWizardState;
    s = wizardReducer(s, { type: "next" });
    expect(s.step).toBe(2);
    s = wizardReducer(wizardReducer(wizardReducer(s, { type: "next" }), { type: "next" }), { type: "next" });
    expect(s.step).toBe(4); // clamped
    s = wizardReducer(s, { type: "back" });
    expect(s.step).toBe(3);
  });

  it("only launches when all steps valid", () => {
    expect(canLaunch(initialWizardState)).toBe(false);
    const ready = fill({ projectPath: "C:/x", requestText: "add a coupon field", mode: "single" });
    expect(canLaunch(ready)).toBe(true);
  });

  it("projects a StartRunRequest, nulling irrelevant fields", () => {
    const teamReq = toStartRequest(fill({ projectPath: "C:/x", requestText: "do a thing", mode: "team", team: "feature-team", tierCap: "opus" }));
    expect(teamReq.team).toBe("feature-team");
    expect(teamReq.n).toBeUndefined(); // omitted, not null (server rejects null)
    expect(teamReq.forum).toBeUndefined();
    expect(teamReq.tier_cap).toBe("opus");

    const bestReq = toStartRequest(fill({ projectPath: "C:/x", requestText: "do a thing", mode: "best_of", n: 5, tierCap: "opus" }));
    expect(bestReq.n).toBe(5);
    expect(bestReq.tier_cap).toBeUndefined(); // dropped in best-of
    expect("tier_cap" in bestReq).toBe(false);
  });
});

describe("estimateRunCost", () => {
  const cheap = { input_per_1m: 0.8, output_per_1m: 4 };
  const dear = { input_per_1m: 15, output_per_1m: 75 };

  it("returns a min<=max range", () => {
    const est = estimateRunCost({ mode: "team", stageCount: 5, n: 1, cheapPrice: cheap, dearPrice: dear });
    expect(est.minUsd).toBeLessThanOrEqual(est.maxUsd);
    expect(est.minUsd).toBeGreaterThan(0);
  });

  it("best-of raises cost with N", () => {
    const n2 = estimateRunCost({ mode: "best_of", stageCount: 2, n: 2, cheapPrice: cheap, dearPrice: dear });
    const n8 = estimateRunCost({ mode: "best_of", stageCount: 2, n: 8, cheapPrice: cheap, dearPrice: dear });
    expect(n8.maxUsd).toBeGreaterThan(n2.maxUsd);
  });

  it("more stages cost more", () => {
    const few = estimateRunCost({ mode: "team", stageCount: 2, n: 1, cheapPrice: cheap, dearPrice: dear });
    const many = estimateRunCost({ mode: "team", stageCount: 8, n: 1, cheapPrice: cheap, dearPrice: dear });
    expect(many.maxUsd).toBeGreaterThan(few.maxUsd);
  });

  it("has a per-mode default stage count", () => {
    expect(defaultStageCount("single")).toBeGreaterThan(0);
    expect(defaultStageCount("team")).toBeGreaterThanOrEqual(defaultStageCount("single"));
  });
});

describe("high-risk rubric confirmation", () => {
  it("flags OWASP/WCAG/SLSA/NIST rubric rids", () => {
    expect(isHighRiskRubric("rubric:owasp-asvs@2")).toBe(true);
    expect(isHighRiskRubric("rubric:wcag-2.2-aa@1")).toBe(true);
    expect(isHighRiskRubric("rubric:slsa-provenance@1")).toBe(true);
    expect(isHighRiskRubric("rubric:nist-800-53@1")).toBe(true);
    expect(isHighRiskRubric("rubric:code-quality@3")).toBe(false);
    expect(isHighRiskRubric("team:security-review-team")).toBe(false);
  });

  it("derives a family-specific confirmation phrase", () => {
    expect(confirmationPhrase("rubric:owasp-asvs@2")).toBe("APPROVE OWASP");
    expect(confirmationPhrase("rubric:wcag-2.2-aa@1")).toBe("APPROVE WCAG");
  });

  it("only satisfies on an exact typed phrase for high-risk targets", () => {
    expect(confirmationSatisfied("rubric:owasp-asvs@2", "approve owasp")).toBe(false);
    expect(confirmationSatisfied("rubric:owasp-asvs@2", "  APPROVE OWASP  ")).toBe(true);
    // Low-risk targets need no phrase.
    expect(confirmationSatisfied("rubric:code-quality@3", "")).toBe(true);
  });
});
