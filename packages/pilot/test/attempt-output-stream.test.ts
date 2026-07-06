/**
 * Live attempt.output streaming: the pilot must forward the coding session's
 * incremental assistant text as `attempt.output` frames DURING generation, and
 * every streamed frame MUST carry the same attempt id that record_attempt
 * persists (the UI keys its per-attempt log pane on that id). This is the
 * invariant the whole feature hinges on — pre-mint → stream → persist all share
 * one id via attempt_slot_id.
 */
import { describe, it, expect } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@pp/core";
import { toGenProvider, type GenResult } from "@pp/engine";
import { RunPilot, EventBus, type PilotEvent, type StageSpec } from "../src/index.js";
import { makeTempProject, makeScriptedEngine } from "./helpers.js";

const CODE_STAGE: StageSpec[] = [{ kind: "code", gate_type: "code_style", agent: "engineer" }];

function codingResult(model: { id: string; provider: string }, text: string): GenResult {
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
    tool_call_count: 3,
    files_changed: true,
  };
}

describe("attempt.output live stream", () => {
  it("generation streams attempt.output whose attempt_id equals the persisted attempt row id", async () => {
    const projectPath = makeTempProject();
    const engine = makeScriptedEngine({ verdictPlan: ["pass"] });
    // The coding session streams two deltas (the newline flushes the coalescer)
    // and writes a real file so the attempt is a non-zero-change pass.
    engine.runCodingSession = async (o) => {
      o.onOutputDelta?.("Implementing ");
      o.onOutputDelta?.("the change.\n");
      writeFileSync(join(o.cwd, "app.js"), "console.log('hi');\n", "utf8");
      return codingResult(o.model, "Wrote app.js.");
    };

    const bus = new EventBus();
    const events: PilotEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const pilot = new RunPilot({
      projectPath,
      requestText: "Add app.js",
      mode: "single",
      engine,
      bus,
      stagesOverride: CODE_STAGE,
    });

    const result = await pilot.execute();

    // The code stage passed on its first attempt; find the persisted attempt id.
    const code = db()
      .prepare(`SELECT id, status FROM stages WHERE run_id = ? AND kind = 'code'`)
      .get(result.run_id) as { id: string; status: string };
    expect(code.status).toBe("passed");
    const attemptRow = db().prepare(`SELECT id FROM attempts WHERE stage_id = ?`).get(code.id) as
      | { id: string }
      | undefined;
    expect(attemptRow).toBeTruthy();

    // attempt.output frames were emitted, carry the streamed text, and every one
    // is keyed on the SAME id record_attempt persisted (the core constraint).
    const outputs = events.filter((e) => e.type === "attempt.output");
    expect(outputs.length).toBeGreaterThan(0);
    const streamed = outputs.map((e) => String((e.data as { chunk?: string }).chunk ?? "")).join("");
    expect(streamed).toContain("Implementing the change.");
    for (const ev of outputs) {
      expect(ev.attempt_id).toBe(attemptRow!.id);
      expect(typeof (ev.data as { chunk?: unknown }).chunk).toBe("string");
    }

    // attempt.started carried the same pre-minted id, so a late-joining client
    // can create the log pane before the first chunk arrives.
    const started = events.find((e) => e.type === "attempt.started");
    expect(started?.attempt_id).toBe(attemptRow!.id);
  });
});
