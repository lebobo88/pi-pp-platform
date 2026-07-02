import { describe, it, expect } from "vitest";
import { listAgentSessions, buildReplayBundle } from "@pp/core";
import { RunPilot, EventBus } from "../src/index.js";
import { makeTempProject, makeScriptedEngine } from "./helpers.js";

describe("agent_sessions recording + replay session hashes", () => {
  it("records an engine session per coding attempt and folds them into the replay bundle", async () => {
    const projectPath = makeTempProject();
    const result = await new RunPilot({
      projectPath,
      requestText: "Add a greeting utility function to the project.",
      mode: "single",
      engine: makeScriptedEngine({ verdictPlan: ["pass", "pass", "pass", "pass"] }),
      bus: new EventBus(),
    }).execute();

    // The code + tests stages run coding sessions (each with a session file);
    // spec/docs completions have none, so we expect >= 2 recorded sessions.
    const sessions = listAgentSessions(result.run_id);
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    for (const s of sessions) {
      expect(s.role).toBeTruthy();
      expect(s.provider).toBe("anthropic");
      expect(s.model_id).toMatch(/^claude-/);
      expect(s.session_file).toBeTruthy();
      expect(s.attempt_id).toBeTruthy();
    }

    // The replay bundle carries the session provenance + a transcript hash slot.
    const bundle = buildReplayBundle(result.run_id)!;
    expect(bundle).not.toBeNull();
    expect(bundle.agent_sessions.length).toBe(sessions.length);
    for (const s of bundle.agent_sessions) {
      expect(s.session_file).toBeTruthy();
      expect(s).toHaveProperty("sha256"); // string when the transcript exists, else null
    }
    // Replay also pins the pi package versions (M7.3).
    expect((bundle.cli_versions as Record<string, string>).pi_ai).toBe("0.80.3");
  });
});
