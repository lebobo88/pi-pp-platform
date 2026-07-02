import { describe, it, expect } from "vitest";
import { db, buildReplayBundle } from "@pp/core";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { RunPilot, EventBus, type PilotEvent } from "../src/index.js";
import { makeTempProject, makeScriptedEngine } from "./helpers.js";

describe("E2E — single mode, standard scope (the M3 gate)", () => {
  it("drives spec pass → code fail → reflexion retry pass → tests pass → docs pass → complete", async () => {
    const projectPath = makeTempProject();
    // critique call order: spec, code(initial), code(retry), tests, docs.
    const engine = makeScriptedEngine({ verdictPlan: ["pass", "fail", "pass", "pass", "pass"] });
    const bus = new EventBus();
    const events: PilotEvent[] = [];
    bus.subscribe((e) => events.push(e));

    const pilot = new RunPilot({
      projectPath,
      requestText: "Add a greeting utility function to the project.",
      mode: "single",
      engine,
      bus,
    });

    const result = await pilot.execute();

    // ── run status ────────────────────────────────────────────────────────
    expect(result.status).toBe("complete");
    const runRow = db().prepare(`SELECT status FROM runs WHERE id = ?`).get(result.run_id) as { status: string };
    expect(runRow.status).toBe("complete");

    // ── stages / attempts / verdicts ─────────────────────────────────────
    const stages = db().prepare(`SELECT kind, status FROM stages WHERE run_id = ? ORDER BY started_at`).all(result.run_id) as Array<{ kind: string; status: string }>;
    expect(stages.map((s) => s.kind)).toEqual(["spec", "code", "tests", "docs"]);
    expect(stages.every((s) => s.status === "passed")).toBe(true);

    const attempts = db()
      .prepare(
        `SELECT a.retry_index, a.attempted_tier, s.kind FROM attempts a
         JOIN stages s ON s.id = a.stage_id WHERE s.run_id = ? ORDER BY a.created_at`,
      )
      .all(result.run_id) as Array<{ retry_index: number; attempted_tier: string; kind: string }>;
    // spec(1) + code initial(1) + code retry(1) + tests(1) + docs(1) = 5.
    expect(attempts.length).toBe(5);
    const codeAttempts = attempts.filter((a) => a.kind === "code");
    expect(codeAttempts.length).toBe(2);
    // Reflexion escalated the code retry sonnet → opus.
    expect(codeAttempts[0]!.attempted_tier).toBe("sonnet");
    expect(codeAttempts[1]!.retry_index).toBe(1);
    expect(codeAttempts[1]!.attempted_tier).toBe("opus");

    const verdicts = db()
      .prepare(`SELECT v.outcome FROM verdicts v JOIN attempts a ON a.id = v.attempt_id JOIN stages s ON s.id = a.stage_id WHERE s.run_id = ?`)
      .all(result.run_id) as Array<{ outcome: string }>;
    expect(verdicts.length).toBe(5);
    expect(verdicts.filter((v) => v.outcome === "fail").length).toBe(1);

    // ── artifacts: diff + changelog (VG-2) and tier_decisions.json ────────
    const artifactKinds = new Set(
      (db().prepare(`SELECT kind FROM artifacts WHERE run_id = ?`).all(result.run_id) as Array<{ kind: string }>).map((r) => r.kind),
    );
    expect(artifactKinds.has("diff")).toBe(true);
    expect(artifactKinds.has("changelog")).toBe(true);
    expect(artifactKinds.has("tier_decisions")).toBe(true);
    expect(existsSync(join(projectPath, ".harness", result.run_id, "tier_decisions.json"))).toBe(true);

    // ── PROJECT_MASTER.md patched ─────────────────────────────────────────
    const master = readFileSync(join(projectPath, "PROJECT_MASTER.md"), "utf8");
    expect(master).toContain(result.run_id);

    // ── replay bundle builds ─────────────────────────────────────────────
    expect(buildReplayBundle(result.run_id)).not.toBeNull();

    // ── event stream contains the expected sequence ──────────────────────
    const types = events.map((e) => e.type);
    expect(types).toContain("run.started");
    expect(types.filter((t) => t === "stage.started").length).toBe(4);
    expect(types.filter((t) => t === "verdict.recorded").length).toBe(5);
    expect(types.filter((t) => t === "reflexion.retry").length).toBe(1);
    expect(types.filter((t) => t === "stage.finalized").length).toBe(4);
    expect(types).toContain("run.finalized");
    // Monotonic per-run seq.
    const seqs = events.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});
