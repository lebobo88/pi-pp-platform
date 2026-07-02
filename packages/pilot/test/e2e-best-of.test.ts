import { describe, it, expect, afterEach } from "vitest";
import { existsSync } from "node:fs";
import { db } from "@pp/core";
import { RunPilot, EventBus, type PilotEvent } from "../src/index.js";
import { makeTempProject, makeBestOfEngine } from "./helpers.js";

describe("E2E — best-of-N (N=3, fake)", () => {
  afterEach(() => {
    delete process.env.PP_ALLOW_BEST_OF_WITHOUT_JUDGE;
  });

  it("races 3 candidates → Borda winner → merge-back → teardown", async () => {
    // Candidates run as Claude; without a real non-Claude vendor the doctor
    // precondition would refuse. This is the sanctioned test override.
    process.env.PP_ALLOW_BEST_OF_WITHOUT_JUDGE = "1";

    const projectPath = makeTempProject();
    const engine = makeBestOfEngine();
    const bus = new EventBus();
    const events: PilotEvent[] = [];
    bus.subscribe((e) => events.push(e));

    const pilot = new RunPilot({
      projectPath,
      requestText: "Add a greeting utility function to the project.",
      mode: "best_of",
      n: 3,
      engine,
      bus,
    });

    const result = await pilot.execute();

    // ── the code stage passed with a Borda-selected winner ────────────────
    const codeStage = db()
      .prepare(`SELECT id, status, winner_attempt_id FROM stages WHERE run_id = ? AND kind = 'code'`)
      .get(result.run_id) as { id: string; status: string; winner_attempt_id: string | null };
    expect(codeStage.status).toBe("passed");
    expect(codeStage.winner_attempt_id).toBeTruthy();

    // ── three candidate attempts, each with a candidate_index ─────────────
    const attempts = db()
      .prepare(`SELECT id, notes_json FROM attempts WHERE stage_id = ?`)
      .all(codeStage.id) as Array<{ id: string; notes_json: string | null }>;
    expect(attempts.length).toBe(3);
    const indices = attempts
      .map((a) => (a.notes_json ? (JSON.parse(a.notes_json).candidate_index as number) : undefined))
      .sort();
    expect(indices).toEqual([1, 2, 3]);

    // ── exactly one winner verdict (the Borda selection), and it's a pass ──
    const verdicts = db()
      .prepare(`SELECT outcome FROM verdicts v JOIN attempts a ON a.id = v.attempt_id WHERE a.stage_id = ?`)
      .all(codeStage.id) as Array<{ outcome: string }>;
    expect(verdicts.length).toBe(1);
    expect(verdicts[0]!.outcome).toBe("pass");

    // ── event stream shows entropy + winner + teardown ────────────────────
    const bordaEvents = events.filter((e) => e.type === "borda.updated");
    expect(bordaEvents.some((e) => e.data.phase === "entropy")).toBe(true);
    const winnerEvent = bordaEvents.find((e) => e.data.phase === "winner");
    expect(winnerEvent?.data.rubric_winner).toBe(1); // makeBestOfEngine scores candidate-1 highest
    expect(events.some((e) => e.type === "smoke.status")).toBe(true);
    expect(events.some((e) => e.type === "janitor.swept")).toBe(true);

    // ── candidate worktrees were torn down ────────────────────────────────
    for (let i = 1; i <= 3; i++) {
      expect(existsSync(`${projectPath}/.harness/${result.run_id}/code/candidate-${i}`)).toBe(false);
    }
  });

  it("N=2 pairwise still selects a winner", async () => {
    process.env.PP_ALLOW_BEST_OF_WITHOUT_JUDGE = "1";
    const projectPath = makeTempProject();
    const pilot = new RunPilot({
      projectPath,
      requestText: "Add a greeting utility function to the project.",
      mode: "best_of",
      n: 2,
      engine: makeBestOfEngine(),
      bus: new EventBus(),
    });
    const result = await pilot.execute();
    const codeStage = db()
      .prepare(`SELECT id, status, winner_attempt_id FROM stages WHERE run_id = ? AND kind = 'code'`)
      .get(result.run_id) as { id: string; status: string; winner_attempt_id: string | null };
    expect(codeStage.status).toBe("passed");
    expect(codeStage.winner_attempt_id).toBeTruthy();
    const attempts = db().prepare(`SELECT COUNT(*) AS n FROM attempts WHERE stage_id = ?`).get(codeStage.id) as { n: number };
    expect(attempts.n).toBe(2);
  });

  it("refuses to merge when every candidate's runtime smoke fails → surfaced", async () => {
    process.env.PP_ALLOW_BEST_OF_WITHOUT_JUDGE = "1";
    const projectPath = makeTempProject();
    const events: PilotEvent[] = [];
    const bus = new EventBus();
    bus.subscribe((e) => events.push(e));
    const pilot = new RunPilot({
      projectPath,
      requestText: "Add a greeting utility function to the project.",
      mode: "best_of",
      n: 3,
      engine: makeBestOfEngine(),
      bus,
      smokeDecision: () => "fail", // all candidates crash at runtime
    });
    const result = await pilot.execute();
    const codeStage = db()
      .prepare(`SELECT status FROM stages WHERE run_id = ? AND kind = 'code'`)
      .get(result.run_id) as { status: string };
    expect(codeStage.status).toBe("surfaced");
    // No winner verdict was recorded (nothing merged).
    const verdicts = db()
      .prepare(`SELECT COUNT(*) AS n FROM verdicts v JOIN attempts a ON a.id = v.attempt_id JOIN stages s ON s.id = a.stage_id WHERE s.run_id = ?`)
      .get(result.run_id) as { n: number };
    expect(verdicts.n).toBe(0);
    expect(events.some((e) => e.type === "stage.surfaced")).toBe(true);
  });

  it("refuses to start best-of when no non-Claude judge vendor is reachable → aborted", async () => {
    // No PP_ALLOW_BEST_OF_WITHOUT_JUDGE override, and disable every non-Claude
    // vendor so the doctor precondition in startBestOfStage refuses.
    process.env.PP_DISABLE_OPENAI = "1";
    process.env.PP_DISABLE_GOOGLE = "1";
    process.env.PP_DISABLE_GEMINI = "1";
    try {
      const projectPath = makeTempProject();
      const pilot = new RunPilot({
        projectPath,
        requestText: "Add a greeting utility function to the project.",
        mode: "best_of",
        n: 3,
        engine: makeBestOfEngine(),
        bus: new EventBus(),
      });
      const result = await pilot.execute();
      expect(["aborted", "crashed"]).toContain(result.status);
    } finally {
      delete process.env.PP_DISABLE_OPENAI;
      delete process.env.PP_DISABLE_GOOGLE;
      delete process.env.PP_DISABLE_GEMINI;
    }
  });

  it("rejects tier-policy flags in best-of mode without starting a run", async () => {
    const pilot = new RunPilot({
      projectPath: makeTempProject(),
      requestText: "Add a greeting utility function.",
      mode: "best_of",
      n: 3,
      tierCap: "opus",
      engine: makeBestOfEngine(),
      bus: new EventBus(),
    });
    const result = await pilot.execute();
    expect(result.status).toBe("aborted");
    expect(result.run_id).toBe("");
    expect(result.abort_reason).toMatch(/fixed Sonnet\+Opus rotation/);
  });
});
