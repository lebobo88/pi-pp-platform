import { describe, it, expect, afterEach } from "vitest";
import { db } from "@pp/core";
import { RunPilot, EventBus, type PilotEvent, type StageSpec } from "../src/index.js";
import { setBrowserDriver, resetBrowserDriver } from "../src/phases/browser-validation.js";
import { makeTempProject, makeScriptedEngine } from "./helpers.js";

const STAGE: StageSpec[] = [
  { kind: "browser_validation", gate_type: "contract", agent: "browser-validator", artifact_kind: "browser_validation_report" },
];

async function runBrowserStage() {
  const projectPath = makeTempProject();
  const events: PilotEvent[] = [];
  const bus = new EventBus();
  bus.subscribe((e) => events.push(e));
  const pilot = new RunPilot({
    projectPath,
    requestText: "Validate the login page renders without console errors.",
    mode: "single",
    engine: makeScriptedEngine({ verdictPlan: [] }),
    bus,
    stagesOverride: STAGE,
  });
  const result = await pilot.execute();
  const stage = db()
    .prepare(`SELECT status FROM stages WHERE run_id = ? AND kind = 'browser_validation'`)
    .get(result.run_id) as { status: string };
  const validation = events.find((e) => e.type === "validation.result");
  return { stage, validation };
}

describe("E2E — browser validation stage", () => {
  afterEach(() => {
    resetBrowserDriver();
    delete process.env.PP_BROWSER_VALIDATION;
    delete process.env.PP_BROWSER_BASE_URL;
  });

  it("degrades open when no browser drive is available: stage passes, gap surfaced, run not blocked", async () => {
    // No PP_BROWSER_VALIDATION → the stage cannot drive a browser and must
    // degrade open rather than block the pipeline.
    const { stage, validation } = await runBrowserStage();
    expect(stage.status).toBe("passed"); // degrade-open, not blocked
    expect(validation?.data.kind).toBe("browser");
    expect(validation?.data.severity).toBe("unavailable");
    expect(validation?.data.degraded).toBe(true);
  });

  it("real drive: a console error surfaces the stage (severity=errors)", async () => {
    process.env.PP_BROWSER_VALIDATION = "1";
    process.env.PP_BROWSER_BASE_URL = "http://localhost:1"; // provided → skip dev-server boot
    setBrowserDriver(async (_baseUrl, routes) =>
      routes.map((route) => ({
        route,
        step: "load",
        status: "fail" as const,
        console_errors: ["TypeError: undefined is not a function"],
        network_errors: [],
      })),
    );
    const { stage, validation } = await runBrowserStage();
    expect(stage.status).toBe("surfaced");
    expect(validation?.data.severity).toBe("errors");
    expect(validation?.data.degraded).toBe(false);
  });

  it("real drive: a clean page passes the stage (severity=clean)", async () => {
    process.env.PP_BROWSER_VALIDATION = "1";
    process.env.PP_BROWSER_BASE_URL = "http://localhost:1";
    setBrowserDriver(async (_baseUrl, routes) =>
      routes.map((route) => ({
        route,
        step: "load",
        status: "pass" as const,
        console_errors: [],
        network_errors: [],
      })),
    );
    const { stage, validation } = await runBrowserStage();
    expect(stage.status).toBe("passed");
    expect(validation?.data.severity).toBe("clean");
    expect(validation?.data.degraded).toBe(false);
  });

  it("real drive: a 500 response surfaces the stage", async () => {
    process.env.PP_BROWSER_VALIDATION = "1";
    process.env.PP_BROWSER_BASE_URL = "http://localhost:1";
    setBrowserDriver(async (_baseUrl, routes) =>
      routes.map((route) => ({
        route,
        step: "load",
        status: "fail" as const,
        console_errors: [],
        network_errors: [{ url: "http://localhost:1/api/data", status: 500 }],
      })),
    );
    const { stage } = await runBrowserStage();
    expect(stage.status).toBe("surfaced");
  });
});
