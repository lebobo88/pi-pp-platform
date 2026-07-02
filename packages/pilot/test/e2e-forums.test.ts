import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { db } from "@pp/core";
import { RunPilot, EventBus } from "../src/index.js";
import { makeTempProject, makeScriptedEngine } from "./helpers.js";

describe("E2E — governance forum (threat / security review)", () => {
  it("runs every forum stage to a verdict with zero code mutation", async () => {
    const projectPath = makeTempProject();
    // Baseline: the set of tracked+committed files before the forum runs.
    const filesBefore = execFileSync("git", ["ls-files"], { cwd: projectPath, encoding: "utf8" }).trim();

    // The threat forum has 2 stages (threat_model, control_mapping).
    const engine = makeScriptedEngine({ verdictPlan: ["pass", "pass"] });
    const bus = new EventBus();
    const pilot = new RunPilot({
      projectPath,
      requestText: "Review the authentication service for security threats.",
      mode: "review",
      forum: "threat",
      engine,
      bus,
    });

    const result = await pilot.execute();

    // Both forum stages ran and passed.
    const stages = db()
      .prepare(`SELECT kind, status FROM stages WHERE run_id = ? ORDER BY started_at`)
      .all(result.run_id) as Array<{ kind: string; status: string }>;
    expect(stages.map((s) => s.kind)).toEqual(["threat_model", "control_mapping"]);
    expect(stages.every((s) => s.status === "passed")).toBe(true);

    // A cross-vendor verdict per stage (security gate forces cross-vendor).
    const verdicts = db()
      .prepare(`SELECT cross_vendor FROM verdicts v JOIN attempts a ON a.id = v.attempt_id JOIN stages s ON s.id = a.stage_id WHERE s.run_id = ?`)
      .all(result.run_id) as Array<{ cross_vendor: number }>;
    expect(verdicts.length).toBe(2);
    expect(verdicts.every((v) => v.cross_vendor === 1)).toBe(true);

    // Zero code mutation: no code/diff artifacts, and the tracked source tree
    // is unchanged (forum artifacts live under .harness only).
    const kinds = (db().prepare(`SELECT kind FROM artifacts WHERE run_id = ?`).all(result.run_id) as Array<{ kind: string }>).map((r) => r.kind);
    expect(kinds).not.toContain("code");
    expect(kinds).not.toContain("diff");

    // The forum committed nothing to the project tree (no candidate/impl files).
    const untracked = execFileSync("git", ["status", "--porcelain", "--", ".", ":(exclude).harness"], {
      cwd: projectPath,
      encoding: "utf8",
    });
    // Only harness-managed governance files may appear (AGENTS.md/CLAUDE.md/
    // PROJECT_MASTER.md); no source or FAKE_ARTIFACT/impl files.
    expect(untracked).not.toMatch(/FAKE_ARTIFACT|impl\.js/);

    const filesAfter = execFileSync("git", ["ls-files"], { cwd: projectPath, encoding: "utf8" }).trim();
    expect(filesAfter).toBe(filesBefore); // nothing new was committed
  });
});
