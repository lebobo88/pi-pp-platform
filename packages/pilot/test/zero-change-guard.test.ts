/**
 * Regression tests for the run_pIgGjPhWo59e failure class:
 *  1. a coding model that answers with prose (zero file changes) must NOT have
 *     its "diff" judged — the judge used to receive `git show HEAD` (the
 *     pre-existing scaffolding commit) and fail it for containing no app code;
 *  2. the diff that IS judged must be the attempt's own baseSha..HEAD range,
 *     with the harness owning the commit (models narrate commits they never run).
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@pp/core";
import { toGenProvider, type GenResult } from "@pp/engine";
import { RunPilot, EventBus } from "../src/index.js";
import { makeTempProject, makeScriptedEngine } from "./helpers.js";

const REQUEST = "create a tauri high powered scientific calculator app that also has the game snake programmed into it";

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

describe("zero-change guard — prose-only coding attempts are never judged", () => {
  it("code attempt writes nothing → judge skipped, Reflexion synthetic critique, retry zero-change → surfaced", async () => {
    const projectPath = makeTempProject();
    // Spec passes (1 critique). The coding session NEVER touches disk — it
    // narrates the app as markdown, exactly like deepseek-v4-flash did.
    const engine = makeScriptedEngine({ verdictPlan: ["pass"] });
    const judgedArtifacts: string[] = [];
    const baseCritique = engine.critique.bind(engine);
    engine.critique = async (o) => {
      judgedArtifacts.push(o.artifactText);
      return baseCritique(o);
    };
    engine.runCodingSession = async (o) =>
      codingResult(o.model, "Here is the full app:\n\n```json:package.json\n{}\n```\n\nAll files written and committed.", {
        stop_reason: "no_tool_calls",
        tool_call_count: 0,
        files_changed: false,
      });

    const bus = new EventBus();
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    bus.subscribe((e) => events.push({ type: e.type, data: e.data as Record<string, unknown> }));
    const pilot = new RunPilot({ projectPath, requestText: REQUEST, mode: "single", engine, bus });

    const result = await pilot.execute();

    expect(result.status).toBe("surfaced");
    const code = db()
      .prepare(`SELECT id, status FROM stages WHERE run_id = ? AND kind = 'code'`)
      .get(result.run_id) as { id: string; status: string };
    expect(code.status).toBe("surfaced");

    // Exactly ONE critique ran (the spec gate). Neither zero-change code
    // attempt reached a judge — and no judged text ever contained the
    // pre-existing initial commit.
    expect(engine.critiquesConsumed()).toBe(1);
    for (const text of judgedArtifacts) {
      expect(text).not.toContain("README");
    }

    // No verdicts recorded for the code stage (never fabricate).
    const codeVerdicts = db()
      .prepare(`SELECT COUNT(*) AS n FROM verdicts v JOIN attempts a ON a.id = v.attempt_id WHERE a.stage_id = ?`)
      .get(code.id) as { n: number };
    expect(codeVerdicts.n).toBe(0);

    // Both attempts recorded (Reflexion ×1 honored), and the surface reason
    // names the real failure instead of a judge verdict about scaffolding.
    const attempts = db().prepare(`SELECT COUNT(*) AS n FROM attempts WHERE stage_id = ?`).get(code.id) as { n: number };
    expect(attempts.n).toBe(2);
    const surfacedEvent = events.find((e) => e.type === "stage.surfaced" && String(e.data.reason ?? "").includes("zero file changes"));
    expect(surfacedEvent).toBeTruthy();
    const guardEvent = events.find((e) => e.type === "gate.blocked" && e.data.zero_change === true);
    expect(guardEvent).toBeTruthy();
  });

  it("judged diff is the attempt's own baseSha..HEAD range, auto-committed by the harness", async () => {
    const projectPath = makeTempProject();
    const engine = makeScriptedEngine({ verdictPlan: ["pass", "pass", "pass", "pass"] });
    const judged: string[] = [];
    const baseCritique = engine.critique.bind(engine);
    engine.critique = async (o) => {
      judged.push(o.artifactText);
      return baseCritique(o);
    };
    // Writes a real file but does NOT commit — the model "forgot", like they do.
    engine.runCodingSession = async (o) => {
      writeFileSync(join(o.cwd, "app.js"), "console.log('snake-calc');\n", "utf8");
      return codingResult(o.model, "Wrote app.js via tools.", { tool_call_count: 3, files_changed: true });
    };

    const bus = new EventBus();
    const pilot = new RunPilot({ projectPath, requestText: REQUEST, mode: "single", engine, bus });
    const result = await pilot.execute();

    const code = db()
      .prepare(`SELECT status FROM stages WHERE run_id = ? AND kind = 'code'`)
      .get(result.run_id) as { status: string };
    expect(code.status).toBe("passed");

    // The code-gate critique saw the new file and ONLY the new file — not the
    // initial commit's README, not .harness metadata.
    const codeDiff = judged.find((t) => t.includes("app.js"));
    expect(codeDiff).toBeTruthy();
    expect(codeDiff!).not.toContain("README");
    expect(codeDiff!).not.toContain(".harness");

    // The harness created the attempt commit itself.
    const log = execFileSync("git", ["log", "--format=%s"], { cwd: projectPath, encoding: "utf8" });
    expect(log).toMatch(/pp run_\S+ code attempt 0/);
  });
});
