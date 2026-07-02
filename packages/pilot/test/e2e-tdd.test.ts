import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { db, getLatestTddCheck } from "@pp/core";
import { RunPilot, EventBus, type StageSpec } from "../src/index.js";
import { makeTddProject, makeTddEngine } from "./helpers.js";

describe("E2E — TDD red → green", () => {
  it("tests_pre proves red, code turns it green, both stages pass the TDD gate", async () => {
    const projectPath = makeTddProject();
    const engine = makeTddEngine();
    const bus = new EventBus();

    const stagesOverride: StageSpec[] = [
      { kind: "tests_pre", gate_type: "contract", agent: "test-strategist" },
      { kind: "code", gate_type: "code_style", agent: "engineer" },
    ];

    const pilot = new RunPilot({
      projectPath,
      requestText: "Fix the failing greeting test.",
      mode: "single",
      engine,
      bus,
      stagesOverride,
    });

    const result = await pilot.execute();

    const stages = db()
      .prepare(`SELECT id, kind, status FROM stages WHERE run_id = ? ORDER BY started_at`)
      .all(result.run_id) as Array<{ id: string; kind: string; status: string }>;
    expect(stages.map((s) => s.kind)).toEqual(["tests_pre", "code"]);
    expect(stages.every((s) => s.status === "passed")).toBe(true);

    const testsPreId = stages.find((s) => s.kind === "tests_pre")!.id;
    const codeId = stages.find((s) => s.kind === "code")!.id;

    // Red proven at tests_pre (impl.js absent → all_fail, matching the manifest).
    const pre = getLatestTddCheck(testsPreId, "pre");
    expect(pre?.status).toBe("verified");
    expect(pre?.actual).toBe("all_fail");

    // Green proven at code (impl.js now exists → all_pass).
    const post = getLatestTddCheck(codeId, "post");
    expect(post?.status).toBe("verified");
    expect(post?.actual).toBe("all_pass");

    // The implementation was actually written.
    expect(existsSync(join(projectPath, "impl.js"))).toBe(true);
  });
});
