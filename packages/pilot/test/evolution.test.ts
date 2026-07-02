import { describe, it, expect } from "vitest";
import { analyzeAndPropose, listProposals } from "@pp/core";
import { RunPilot, EventBus } from "../src/index.js";
import { makeTempProject, makeScriptedEngine } from "./helpers.js";

describe("autogenesis — evolution analyzer wired into finalize", () => {
  it("runs analyzeAndPropose over a finalized run without throwing and returns proposals", async () => {
    const projectPath = makeTempProject();
    // A full single-mode run (finalize invokes analyzeAndPropose internally).
    const pilot = new RunPilot({
      projectPath,
      requestText: "Add a greeting utility function to the project.",
      mode: "single",
      engine: makeScriptedEngine({ verdictPlan: ["pass", "pass", "pass", "pass"] }),
      bus: new EventBus(),
    });
    const result = await pilot.execute();

    // Re-running the analyzer over the same run is safe and returns an array
    // (empty until a drift pattern repeats ≥3 times — the recurring-drift rule).
    const proposals = await analyzeAndPropose({ run_id: result.run_id, project_path: projectPath });
    expect(Array.isArray(proposals)).toBe(true);

    // The proposals ledger is queryable per project.
    const listed = listProposals({ project_path: projectPath });
    expect(Array.isArray(listed)).toBe(true);
  });
});
