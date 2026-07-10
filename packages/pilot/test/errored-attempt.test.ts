/**
 * WS3 — stop burning attempts on exhausted providers.
 *  - an errored generation is NOT judged and does NOT consume Reflexion; it gets
 *    ONE infra retry at retry_index=0 (parent chained);
 *  - two consecutive errored attempts surface with the real provider reason;
 *  - judge failover moves to the next eligible provider on a provider_error and
 *    halts (abort, never fabricate) when the pool empties;
 *  - smart /pp:retry routes a real-but-unverdicted attempt to a re-gate.
 */
import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { db, startRun, startStage, recordAttempt } from "@pp/core";
import { toGenProvider, type GenResult } from "@pp/engine";
import { RunPilot, EventBus, retryStage } from "../src/index.js";
import { makeTempProject, makeScriptedEngine, makeErrorGenResult } from "./helpers.js";

const REQUEST = "Add a greeting utility function to the project.";

function codingResult(model: { id: string; provider: string }, text: string, extra: Partial<GenResult> = {}): GenResult {
  return {
    text,
    tokens_in: 10,
    tokens_out: 20,
    cost_usd: 0.001,
    model: model.id,
    provider: toGenProvider(model.provider),
    wall_ms: 1,
    session_id: "scripted",
    stop_reason: "stop",
    ...extra,
  };
}

function codeStage(run_id: string): { id: string; status: string } {
  return db().prepare(`SELECT id, status FROM stages WHERE run_id = ? AND kind = 'code'`).get(run_id) as { id: string; status: string };
}

describe("WS3 — errored-attempt guard", () => {
  it("errored code attempt → not judged, no Reflexion consumed, one infra retry, then completes", async () => {
    const projectPath = makeTempProject();
    // critique order: spec, code(infra-retry), tests, docs — the errored code
    // attempt is NEVER judged, so it consumes no critique slot.
    const engine = makeScriptedEngine({ verdictPlan: ["pass", "pass", "pass", "pass"] });
    // The default single pipeline runs BOTH the code and tests stages as coding
    // sessions, so this override is hit more than twice. Only the FIRST call
    // (the code stage's attempt 0) errors; every other call writes a unique file
    // so its stage produces a real diff.
    let sessionCalls = 0;
    engine.runCodingSession = async (o) => {
      sessionCalls++;
      if (sessionCalls === 1) {
        return makeErrorGenResult(o.model, "quota_exhausted", 'OpenAI API error (429): {"code":"insufficient_quota"}');
      }
      writeFileSync(join(o.cwd, `f${sessionCalls}.js`), `module.exports = () => ${sessionCalls};\n`, "utf8");
      return codingResult(o.model, `wrote f${sessionCalls}.js`, { files_changed: true, tool_call_count: 2 });
    };

    const bus = new EventBus();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    bus.subscribe((e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }));
    const pilot = new RunPilot({ projectPath, requestText: REQUEST, mode: "single", engine, bus });

    const result = await pilot.execute();
    expect(result.status).toBe("complete");

    const code = codeStage(result.run_id);
    expect(code.status).toBe("passed");
    // Code stage: attempt 0 errored, exactly one infra retry succeeded.
    expect(sessionCalls).toBeGreaterThanOrEqual(2);

    const attempts = db()
      .prepare(`SELECT status, retry_index, parent_attempt_id, notes_json FROM attempts WHERE stage_id = ? ORDER BY created_at`)
      .all(code.id) as Array<{ status: string; retry_index: number; parent_attempt_id: string | null; notes_json: string | null }>;
    expect(attempts.length).toBe(2);
    // Errored attempt recorded truthfully with the real cause in notes_json.
    expect(attempts[0]!.status).toBe("error");
    expect(attempts[0]!.retry_index).toBe(0);
    const notes = JSON.parse(attempts[0]!.notes_json!) as { error_class?: string; error_message?: string };
    expect(notes.error_class).toBe("quota_exhausted");
    expect(notes.error_message).toContain("insufficient_quota");
    // Infra retry is retry_index=0 (NOT a Reflexion attempt) and parent-chained.
    expect(attempts[1]!.status).toBe("ok");
    expect(attempts[1]!.retry_index).toBe(0);
    expect(attempts[1]!.parent_attempt_id).toBe(
      (db().prepare(`SELECT id FROM attempts WHERE stage_id = ? ORDER BY created_at LIMIT 1`).get(code.id) as { id: string }).id,
    );

    // The errored attempt was never judged: exactly ONE code verdict (the retry).
    const codeVerdicts = db()
      .prepare(`SELECT COUNT(*) AS n FROM verdicts v JOIN attempts a ON a.id = v.attempt_id WHERE a.stage_id = ?`)
      .get(code.id) as { n: number };
    expect(codeVerdicts.n).toBe(1);
    // Reflexion slot intact — no reflexion.retry fired for the code stage.
    const reflexions = events.filter((e) => e.type === "reflexion.retry");
    expect(reflexions.length).toBe(0);
  });

  it("two consecutive errored attempts → stage + run surfaced with the real reason, zero judge calls", async () => {
    const projectPath = makeTempProject();
    const engine = makeScriptedEngine({ verdictPlan: ["pass"] }); // spec passes; code never judged
    engine.runCodingSession = async (o) =>
      makeErrorGenResult(o.model, "quota_exhausted", 'OpenAI API error (429): {"code":"insufficient_quota"}');

    const bus = new EventBus();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    bus.subscribe((e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }));
    const pilot = new RunPilot({ projectPath, requestText: REQUEST, mode: "single", engine, bus });

    const result = await pilot.execute();
    expect(result.status).toBe("surfaced");

    const code = codeStage(result.run_id);
    expect(code.status).toBe("surfaced");
    const attempts = db().prepare(`SELECT status FROM attempts WHERE stage_id = ?`).all(code.id) as Array<{ status: string }>;
    expect(attempts.length).toBe(2);
    expect(attempts.every((a) => a.status === "error")).toBe(true);

    const codeVerdicts = db()
      .prepare(`SELECT COUNT(*) AS n FROM verdicts v JOIN attempts a ON a.id = v.attempt_id WHERE a.stage_id = ?`)
      .get(code.id) as { n: number };
    expect(codeVerdicts.n).toBe(0);

    const surfaced = events.find((e) => e.type === "stage.surfaced" && String(e.data.reason ?? "").includes("persisted after infra retry"));
    expect(surfaced).toBeTruthy();
    expect(String(surfaced!.data.reason)).toContain("quota_exhausted");
  });
});

describe("WS3 — judge failover", () => {
  it("fails over to the next eligible provider on a provider_error, recording the verdict under the judge that served", async () => {
    const projectPath = makeTempProject();
    // Spec gate: critique #0 provider_errors → failover to the next provider,
    // critique #1 passes. verdictPlan[1] is the served verdict.
    const engine = makeScriptedEngine({ verdictPlan: ["pass", "pass", "pass", "pass", "pass"], critiqueErrorAt: 0 });
    const bus = new EventBus();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    bus.subscribe((e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }));
    const pilot = new RunPilot({ projectPath, requestText: REQUEST, mode: "single", engine, bus });

    const result = await pilot.execute();
    expect(result.status).toBe("complete");

    // Two judge models were consulted for the spec stage: the failed provider
    // then the fallback provider (distinct providers).
    const used = engine.judgeModelsUsed();
    expect(used[0]).not.toBe(used[1]);
    // A failover bus frame was emitted.
    const failover = events.find((e) => e.data.failover === true);
    expect(failover).toBeTruthy();

    // The spec stage recorded exactly one (non-fabricated) verdict — from the
    // provider that actually served.
    const spec = db().prepare(`SELECT id FROM stages WHERE run_id = ? AND kind = 'spec'`).get(result.run_id) as { id: string };
    const specVerdicts = db()
      .prepare(`SELECT COUNT(*) AS n FROM verdicts v JOIN attempts a ON a.id = v.attempt_id WHERE a.stage_id = ?`)
      .get(spec.id) as { n: number };
    expect(specVerdicts.n).toBe(1);
  });

  it("halts (abort, never fabricate) when every failover provider errors", async () => {
    const projectPath = makeTempProject();
    // Both eligible spec-gate providers provider_error → failover exhausted.
    const engine = makeScriptedEngine({ verdictPlan: ["pass"], critiqueErrorAt: [0, 1] });
    const bus = new EventBus();
    const pilot = new RunPilot({ projectPath, requestText: REQUEST, mode: "single", engine, bus });

    const result = await pilot.execute();
    expect(result.status).toBe("aborted");

    // No verdict fabricated anywhere in the run.
    const verdicts = db()
      .prepare(`SELECT COUNT(*) AS n FROM verdicts v JOIN attempts a ON a.id = v.attempt_id JOIN stages s ON s.id = a.stage_id WHERE s.run_id = ?`)
      .get(result.run_id) as { n: number };
    expect(verdicts.n).toBe(0);
    // The failover-exhaustion path archived a critique_failure artifact.
    const kinds = (db().prepare(`SELECT kind FROM artifacts WHERE run_id = ?`).all(result.run_id) as Array<{ kind: string }>).map((r) => r.kind);
    expect(kinds).toContain("critique_failure");
    // At most 2 providers were tried (bounded failover).
    expect(engine.judgeModelsUsed().length).toBe(2);
  });
});

describe("WS3 — smart /pp:retry routes a real-but-unverdicted attempt to a re-gate", () => {
  it("re-judges (action=gate) instead of regenerating when the latest attempt is real and unverdicted", async () => {
    const projectPath = makeTempProject();
    const { run_id } = await startRun({ request_text: REQUEST, project_path: projectPath, mode: "single" });
    const { stage_id } = startStage({ run_id, kind: "code", gate_type: "code_style" });
    // A real attempt with NO verdict on record (e.g. its judge errored last pass).
    recordAttempt({
      stage_id,
      producer: "claude",
      model_id: "claude-sonnet-4-6",
      agent_type: "engineer",
      retry_index: 0,
      status: "ok",
      attempted_tier: "sonnet",
      artifact_path: "code/",
    });

    const res = await retryStage({ stageId: stage_id, engine: makeScriptedEngine({ verdictPlan: ["pass"] }), bus: new EventBus() });
    expect(res.action).toBe("gate");
    expect(res.ok).toBe(true);

    // No regeneration happened — still a single attempt; a fresh verdict was added.
    const attempts = db().prepare(`SELECT COUNT(*) AS n FROM attempts WHERE stage_id = ?`).get(stage_id) as { n: number };
    expect(attempts.n).toBe(1);
    const verdicts = db().prepare(`SELECT COUNT(*) AS n FROM verdicts v JOIN attempts a ON a.id = v.attempt_id WHERE a.stage_id = ?`).get(stage_id) as { n: number };
    expect(verdicts.n).toBe(1);
  });
});
