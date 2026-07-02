import { describe, it, expect } from "vitest";
import { mockRunTree } from "@/mocks/fixtures/runTree";
import {
  buildPipeline,
  deriveStageState,
  isBestOfStage,
  stageAttempts,
  candidateAttempts,
  buildBordaTable,
  reflexionThreads,
  taxonomyCoverage,
  costBreakdown,
  runTotals,
} from "./runModel";
import type { LiveRunOverlay } from "@/stores/liveRunStore";

function overlay(partial: Partial<LiveRunOverlay>): LiveRunOverlay {
  return {
    runId: mockRunTree.run.id,
    status: null,
    stageStatus: {},
    stageWinner: {},
    attemptStatus: {},
    verdicts: {},
    borda: {},
    costUsd: 0,
    tokensIn: 0,
    tokensOut: 0,
    version: 1,
    ...partial,
  };
}

describe("buildPipeline", () => {
  it("derives one node per stage with correct states", () => {
    const nodes = buildPipeline(mockRunTree);
    expect(nodes.map((n) => n.kind)).toEqual([
      "spec",
      "design",
      "contracts",
      "implementation",
      "docs",
    ]);
    const byKind = Object.fromEntries(nodes.map((n) => [n.kind, n.state]));
    expect(byKind.spec).toBe("passed");
    expect(byKind.design).toBe("passed");
    expect(byKind.contracts).toBe("passed");
    expect(byKind.implementation).toBe("passed");
    expect(byKind.docs).toBe("surfaced");
  });

  it("flags the implementation stage as best-of and others not", () => {
    const nodes = buildPipeline(mockRunTree);
    expect(nodes.find((n) => n.kind === "implementation")!.isBestOf).toBe(true);
    expect(nodes.find((n) => n.kind === "spec")!.isBestOf).toBe(false);
  });

  it("lets the live overlay override a stage to running", () => {
    const nodes = buildPipeline(mockRunTree, overlay({ stageStatus: { stg_docs: "open" } }));
    expect(nodes.find((n) => n.stageId === "stg_docs")!.state).toBe("running");
  });
});

describe("deriveStageState", () => {
  const specStage = mockRunTree.stages.find((s) => s.id === "stg_spec")!;

  it("maps a passed stage", () => {
    expect(deriveStageState(specStage, stageAttempts(mockRunTree, "stg_spec"))).toBe("passed");
  });

  it("returns failed when a non-terminal stage has an errored attempt", () => {
    const openStage = { ...specStage, status: "surfaced" as const };
    const erroredAttempts = [{ ...stageAttempts(mockRunTree, "stg_spec")[0]!, status: "error" as const }];
    expect(deriveStageState(openStage, erroredAttempts)).toBe("failed");
  });
});

describe("best-of detection", () => {
  it("counts root candidates only", () => {
    const impl = stageAttempts(mockRunTree, "stg_impl");
    expect(candidateAttempts(impl)).toHaveLength(3);
    expect(isBestOfStage(impl)).toBe(true);

    const design = stageAttempts(mockRunTree, "stg_design");
    // 2 attempts but one is a retry (parent set) → not best-of.
    expect(candidateAttempts(design)).toHaveLength(1);
    expect(isBestOfStage(design)).toBe(false);
  });
});

describe("buildBordaTable", () => {
  const impl = stageAttempts(mockRunTree, "stg_impl");
  const verdicts = mockRunTree.verdicts.filter((v) => impl.some((a) => a.id === v.attempt_id));

  it("builds a judges×candidates matrix", () => {
    const table = buildBordaTable(impl, verdicts, { winnerAttemptId: "att_impl_b" });
    expect(table.candidates).toHaveLength(3);
    expect(table.judges).toEqual(["gpt-5.4"]);
    expect(table.cell("att_impl_b", "gpt-5.4")).toBe("pass");
    expect(table.cell("att_impl_c", "gpt-5.4")).toBe("revise");
    expect(table.candidates.find((c) => c.winner)!.attempt.id).toBe("att_impl_b");
  });

  it("honors an explicit Borda ranking for ordering and points", () => {
    const table = buildBordaTable(impl, verdicts, {
      ranking: [
        { attempt_id: "att_impl_b", points: 6, rank: 1 },
        { attempt_id: "att_impl_a", points: 4, rank: 2 },
        { attempt_id: "att_impl_c", points: 2, rank: 3 },
      ],
      winnerAttemptId: "att_impl_b",
    });
    expect(table.candidates.map((c) => c.attempt.id)).toEqual([
      "att_impl_b",
      "att_impl_a",
      "att_impl_c",
    ]);
    expect(table.candidates[0]!.points).toBe(6);
    expect(table.candidates[0]!.rank).toBe(1);
  });

  it("falls back to counting pass verdicts when no ranking is given", () => {
    const table = buildBordaTable(impl, verdicts);
    const b = table.candidates.find((c) => c.attempt.id === "att_impl_b")!;
    const c = table.candidates.find((c) => c.attempt.id === "att_impl_c")!;
    expect(b.points).toBe(1); // one pass
    expect(c.points).toBe(0); // revise, no pass
  });
});

describe("reflexionThreads", () => {
  it("reconstructs the design stage retry chain", () => {
    const threads = reflexionThreads(mockRunTree, "stg_design");
    expect(threads).toHaveLength(1);
    expect(threads[0]!.steps.map((s) => s.attempt.id)).toEqual(["att_design_1", "att_design_2"]);
    expect(threads[0]!.steps[0]!.verdicts[0]!.outcome).toBe("revise");
    expect(threads[0]!.steps[1]!.verdicts[0]!.outcome).toBe("pass");
  });

  it("returns no threads for a single-attempt stage", () => {
    expect(reflexionThreads(mockRunTree, "stg_spec")).toHaveLength(0);
  });
});

describe("taxonomyCoverage", () => {
  it("marks sections with artifacts as covered", () => {
    const rows = taxonomyCoverage(mockRunTree);
    expect(rows.map((r) => r.id)).toEqual(["4.3", "4.7", "4.8"]);
    expect(rows.every((r) => r.covered)).toBe(true);
  });
});

describe("cost aggregates", () => {
  it("sums run totals", () => {
    const t = runTotals(mockRunTree);
    expect(t.costUsd).toBeGreaterThan(0);
    expect(t.tokensIn).toBeGreaterThan(0);
  });

  it("breaks down by tier", () => {
    const rows = costBreakdown(mockRunTree, "tier");
    const opus = rows.find((r) => r.key === "opus");
    expect(opus).toBeDefined();
    expect(opus!.attempts).toBeGreaterThanOrEqual(1);
    // sorted by cost desc
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1]!.costUsd).toBeGreaterThanOrEqual(rows[i]!.costUsd);
    }
  });
});
