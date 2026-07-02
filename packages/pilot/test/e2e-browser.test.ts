import { describe, it, expect } from "vitest";
import { db } from "@pp/core";
import { RunPilot, EventBus, type PilotEvent, type StageSpec } from "../src/index.js";
import { makeTempProject, makeScriptedEngine } from "./helpers.js";

describe("E2E — browser validation stage (graceful degradation)", () => {
  it("degrades open when no browser drive is available: stage passes, gap surfaced, run not blocked", async () => {
    // No PP_BROWSER_VALIDATION → the stage cannot drive a browser and must
    // degrade open rather than block the pipeline.
    const projectPath = makeTempProject();
    const events: PilotEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => events.push(e));

    const stagesOverride: StageSpec[] = [
      { kind: "browser_validation", gate_type: "contract", agent: "browser-validator", artifact_kind: "browser_validation_report" },
    ];

    const pilot = new RunPilot({
      projectPath,
      requestText: "Validate the login page renders without console errors.",
      mode: "single",
      engine: makeScriptedEngine({ verdictPlan: [] }),
      bus,
      stagesOverride,
    });

    const result = await pilot.execute();

    const stage = db()
      .prepare(`SELECT status FROM stages WHERE run_id = ? AND kind = 'browser_validation'`)
      .get(result.run_id) as { status: string };
    expect(stage.status).toBe("passed"); // degrade-open, not blocked

    const validation = events.find((e) => e.type === "validation.result");
    expect(validation?.data.kind).toBe("browser");
    expect(validation?.data.severity).toBe("unavailable");
    expect(validation?.data.degraded).toBe(true);
  });
});
