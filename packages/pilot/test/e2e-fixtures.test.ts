import { describe, it, expect, afterEach } from "vitest";
import { db, loopCeilingStatus } from "@pp/core";
import { RunPilot, EventBus } from "../src/index.js";
import { makeTempProject, makeScriptedEngine } from "./helpers.js";

const REQUEST = "Add a greeting utility function to the project.";

function runRow(runId: string): { status: string } {
  return db().prepare(`SELECT status FROM runs WHERE id = ?`).get(runId) as { status: string };
}

describe("E2E — double fail surfaces the stage and the run", () => {
  it("code fails initial + retry → stage surfaced, run surfaced, pipeline halts", async () => {
    const projectPath = makeTempProject();
    // spec pass, code fail, code retry fail → surface at code, break.
    const engine = makeScriptedEngine({ verdictPlan: ["pass", "fail", "fail"] });
    const bus = new EventBus();
    const pilot = new RunPilot({ projectPath, requestText: REQUEST, mode: "single", engine, bus });

    const result = await pilot.execute();

    expect(result.status).toBe("surfaced");
    expect(runRow(result.run_id).status).toBe("surfaced");

    const stages = db().prepare(`SELECT kind, status FROM stages WHERE run_id = ? ORDER BY started_at`).all(result.run_id) as Array<{ kind: string; status: string }>;
    // Only spec + code ran; tests/docs never started (surface breaks the loop).
    expect(stages.map((s) => s.kind)).toEqual(["spec", "code"]);
    expect(stages.find((s) => s.kind === "code")!.status).toBe("surfaced");
  });
});

describe("E2E — judge unavailable aborts the run (never fabricate)", () => {
  afterEach(() => {
    delete process.env.PP_DISABLE_OPENAI;
    delete process.env.PP_DISABLE_GOOGLE;
  });

  it("empty cross-vendor judge pool on the spec gate → run aborted", async () => {
    process.env.PP_DISABLE_OPENAI = "1";
    process.env.PP_DISABLE_GOOGLE = "1";
    const projectPath = makeTempProject();
    const engine = makeScriptedEngine({ verdictPlan: ["pass"] });
    const bus = new EventBus();
    const pilot = new RunPilot({ projectPath, requestText: REQUEST, mode: "single", engine, bus });

    const result = await pilot.execute();

    expect(result.status).toBe("aborted");
    expect(runRow(result.run_id).status).toBe("aborted");
    // No verdict was fabricated for the spec stage.
    const verdicts = db()
      .prepare(`SELECT COUNT(*) AS n FROM verdicts v JOIN attempts a ON a.id = v.attempt_id JOIN stages s ON s.id = a.stage_id WHERE s.run_id = ?`)
      .get(result.run_id) as { n: number };
    expect(verdicts.n).toBe(0);
    // The judge-halt path archived a critique_failure artifact.
    const kinds = (db().prepare(`SELECT kind FROM artifacts WHERE run_id = ?`).all(result.run_id) as Array<{ kind: string }>).map((r) => r.kind);
    expect(kinds).toContain("critique_failure");
  });
});

describe("E2E — loop ceiling is respected", () => {
  it("blocks the Reflexion retry once the validator-call ceiling is reached", async () => {
    const projectPath = makeTempProject();
    // Every stage fails then passes on retry until the 6-verdict ceiling is hit;
    // the docs stage's retry is refused → docs surfaces → run surfaces.
    const engine = makeScriptedEngine({
      verdictPlan: ["fail", "pass", "fail", "pass", "fail", "pass", "fail"],
    });
    const bus = new EventBus();
    const pilot = new RunPilot({ projectPath, requestText: REQUEST, mode: "single", engine, bus });

    const result = await pilot.execute();

    expect(result.status).toBe("surfaced");
    const ceiling = loopCeilingStatus(result.run_id);
    expect(ceiling.validator_calls).toBeGreaterThanOrEqual(ceiling.ceiling);
    expect(ceiling.blocked).toBe(true);

    const docs = db().prepare(`SELECT status FROM stages WHERE run_id = ? AND kind = 'docs'`).get(result.run_id) as { status: string } | undefined;
    expect(docs?.status).toBe("surfaced");
  });
});
