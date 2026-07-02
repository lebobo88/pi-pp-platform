import { describe, it, expect } from "vitest";
import { db } from "@pp/core";
import { RunPilot, EventBus } from "../src/index.js";
import { makeTempProject, makeScriptedEngine } from "./helpers.js";

/**
 * H3 / replay-pinning: start_run captures version provenance WITHOUT probing any
 * vendor CLI (prime directive: zero dependence on codex/gemini/claude binaries).
 * On this box those binaries are absent-or-slow, so the whole run's version
 * capture must be effectively instant and the record must carry the pinned pi
 * package versions.
 */
describe("version capture — pi packages, no vendor CLI probes", () => {
  it("records pi package versions in cli_versions_json and does not hang on missing CLIs", async () => {
    const projectPath = makeTempProject();
    const t0 = Date.now();
    const pilot = new RunPilot({
      projectPath,
      requestText: "Add a greeting utility function to the project.",
      mode: "single",
      engine: makeScriptedEngine({ verdictPlan: ["pass", "pass", "pass", "pass"] }),
      bus: new EventBus(),
    });
    const result = await pilot.execute();
    // The whole fake run (incl. version capture) is fast — version capture spawns
    // no vendor subprocesses. (Generous bound to stay robust under CI load.)
    expect(Date.now() - t0).toBeLessThan(30_000);

    const row = db().prepare(`SELECT cli_versions_json FROM runs WHERE id = ?`).get(result.run_id) as { cli_versions_json: string };
    const versions = JSON.parse(row.cli_versions_json) as Record<string, string | null>;
    expect(versions.pi_ai).toBe("0.80.3");
    expect(versions.pi_coding_agent).toBe("0.80.3");
    expect(versions.pi_agent_core).toBe("0.80.3");
    expect(versions.node).toMatch(/^v\d+/);
    // No legacy vendor-CLI keys.
    expect(versions.codex).toBeUndefined();
    expect(versions.gemini).toBeUndefined();
    expect(versions.claude).toBeUndefined();
  });
});
