import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine } from "../src/index.js";
import { validateCritiqueResult } from "@pp/core";

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "pp-fake-repo-"));
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  return dir;
}

describe("FakeCodegenSession", () => {
  it("writes a fixture file and commits it in a temp git repo", async () => {
    const engine = createEngine({ mode: "fake" });
    const cwd = initRepo();
    const model = engine.catalog.resolveTier("sonnet");

    const events: string[] = [];
    const res = await engine.runCodingSession({
      cwd,
      systemPrompt: "You are a fake coder.",
      taskPrompt: "Create the artifact.",
      model,
      sessionDir: cwd,
      toolPolicy: "coding",
      role: "author",
      attempt: 0,
      onEvent: (e) => events.push(e.type),
    });

    // A fixture file was written.
    const files = readdirSync(cwd).filter((f) => f.startsWith("FAKE_ARTIFACT_"));
    expect(files.length).toBe(1);
    expect(existsSync(join(cwd, files[0]!))).toBe(true);

    // A commit exists.
    const log = execFileSync("git", ["log", "--oneline"], { cwd, encoding: "utf8" });
    expect(log).toContain("fake: author-0");

    // GenResult is well-formed.
    expect(res.session_id).toBe("author-0");
    expect(res.provider).toBe("anthropic");
    expect(res.model).toBe(model.id);
    expect(events).toContain("agent_end");
  });
});

describe("FakeLlm critique", () => {
  it("returns a schema-valid verdict through the real validateCritiqueResult", async () => {
    const engine = createEngine({ mode: "fake" });
    const model = engine.catalog.resolveTier("fable");

    const res = await engine.critique({
      judgeModel: model,
      rubricMd: "Score correctness and minimality 0..1.",
      artifactText: "function add(a,b){return a+b;}",
    });

    expect(res.parsed).toBeDefined();
    const validated = validateCritiqueResult({ text: res.text });
    expect(validated.ok).toBe(true);
    if (validated.ok) {
      expect(["pass", "fail", "revise"]).toContain(validated.verdict.outcome);
      expect(Object.keys(validated.verdict.score).length).toBeGreaterThan(0);
    }
  });

  it("is deterministic for the same artifact", async () => {
    const engine = createEngine({ mode: "fake" });
    const model = engine.catalog.resolveTier("fable");
    const opts = { judgeModel: model, rubricMd: "r", artifactText: "same-artifact" };
    const a = await engine.critique({ ...opts });
    const b = await engine.critique({ ...opts });
    expect(a.text).toBe(b.text);
  });
});

describe("authoring completion (fake)", () => {
  it("returns deterministic text", async () => {
    const engine = createEngine({ mode: "fake" });
    const model = engine.catalog.resolveTier("haiku");
    const res = await engine.runAuthoringCompletion({
      model,
      systemPrompt: "author",
      userPrompt: "write a haiku",
    });
    expect(res.text).toContain("FAKE COMPLETION");
    expect(res.provider).toBe("anthropic");
  });
});
