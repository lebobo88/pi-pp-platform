/**
 * v9 judge-usage forwarding: the judge path must pass the engine critique's
 * tokens_in/tokens_out/cost_usd through to core.recordVerdict so the spend is
 * recorded on the verdict row (and credited to the budget scopes). The fields
 * are optional end-to-end — a critique double without them still records.
 */
import { describe, it, expect } from "vitest";
import { db } from "@pp/core";
import { RunPilot, EventBus } from "../src/index.js";
import { makeTempProject, makeScriptedEngine } from "./helpers.js";

const REQUEST = "Add a greeting utility function to the project.";

// Known, distinct-from-default usage numbers so the assertion proves the
// forwarded values came from THIS critique, not the helper's boilerplate.
const KNOWN = { tokens_in: 137, tokens_out: 291, cost_usd: 0.0421 };

describe("judge path forwards critique usage into recordVerdict", () => {
  it("records the critique's tokens_in/tokens_out/cost_usd on the code verdict row", async () => {
    const projectPath = makeTempProject();
    const engine = makeScriptedEngine({ verdictPlan: ["pass", "pass", "pass", "pass"] });
    // Overlay the known usage on every scripted critique while keeping its
    // parsed verdict intact.
    const baseCritique = engine.critique.bind(engine);
    engine.critique = async (o) => ({ ...(await baseCritique(o)), ...KNOWN });

    const bus = new EventBus();
    const pilot = new RunPilot({ projectPath, requestText: REQUEST, mode: "single", engine, bus });
    const result = await pilot.execute();

    const code = db()
      .prepare(`SELECT id, status FROM stages WHERE run_id = ? AND kind = 'code'`)
      .get(result.run_id) as { id: string; status: string };
    expect(code.status).toBe("passed");

    const verdict = db()
      .prepare(
        `SELECT v.tokens_in, v.tokens_out, v.cost_usd
           FROM verdicts v JOIN attempts a ON a.id = v.attempt_id
          WHERE a.stage_id = ?`,
      )
      .get(code.id) as { tokens_in: number; tokens_out: number; cost_usd: number };

    expect(verdict.tokens_in).toBe(KNOWN.tokens_in);
    expect(verdict.tokens_out).toBe(KNOWN.tokens_out);
    expect(verdict.cost_usd).toBeCloseTo(KNOWN.cost_usd, 6);
  });
});
