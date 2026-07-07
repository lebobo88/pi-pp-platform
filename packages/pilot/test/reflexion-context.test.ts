/**
 * R4 — the Reflexion retry judge gets CUMULATIVE context, not just the
 * incremental attempt0→retry diff. On a retry the judge must see (a) the whole
 * change since the stage started, (b) the prior critique it claims to address,
 * and (c) any execution evidence — otherwise it re-flags resolved issues and
 * misses regressions (code-gate retry rescue was only 47%). First-attempt
 * judging stays byte-identical (no Context block).
 */
import { describe, it, expect } from "vitest";
import { RunPilot, EventBus } from "../src/index.js";
import { buildRetryContext } from "../src/phases/stage-loop.js";
import { makeTempProject, makeScriptedEngine } from "./helpers.js";

describe("reflexion retry — cumulative judge context", () => {
  it("retry judging receives contextMd with the cumulative-diff heading and prior critique; first attempts pass none", async () => {
    const projectPath = makeTempProject();
    // spec pass, code fail (attempt 0), code retry pass, tests pass, docs pass.
    const engine = makeScriptedEngine({ verdictPlan: ["pass", "fail", "pass", "pass", "pass"] });
    const contexts: Array<string | undefined> = [];
    const baseCritique = engine.critique.bind(engine);
    engine.critique = async (o) => {
      contexts.push(o.contextMd);
      return baseCritique(o);
    };

    const pilot = new RunPilot({
      projectPath,
      requestText: "Add a greeting utility function to the project.",
      mode: "single",
      engine,
      bus: new EventBus(),
    });
    const result = await pilot.execute();
    expect(result.status).toBe("complete");

    // Exactly one critique — the code retry (#2) — carried cumulative context.
    const withCtx = contexts.filter((c): c is string => c !== undefined);
    expect(withCtx.length).toBe(1);
    const ctxMd = withCtx[0]!;
    expect(ctxMd).toContain("## Cumulative diff since stage start");
    expect(ctxMd).toContain("## Prior critique");
    // The failed attempt-0 verdict text is surfaced verbatim so the judge can
    // verify the retry addressed it rather than re-flagging it.
    expect(ctxMd).toContain("scripted fail for critique #1");
    // The cumulative diff spans the whole stage: the attempt-0 fixture commit
    // is present, which the incremental attempt0→retry diff would NOT contain.
    expect(ctxMd).toMatch(/FAKE_ARTIFACT_\w+-0\.md/);

    // Every OTHER judge call (spec, code attempt 0, tests, docs) saw no Context.
    expect(contexts.filter((c) => c === undefined).length).toBe(4);
  });

  it("budgets an oversized prior critique with a truncation marker", () => {
    const huge = "CRITIQUE-".repeat(4000); // ~36k chars, far over the ~8k budget
    // No base sha (post-hoc shape) → no diff section; a non-existent stage has
    // no smoke row → only the prior-critique section is emitted.
    const ctxMd = buildRetryContext(
      { projectPath: "/nonexistent" } as never,
      "stage_does_not_exist",
      undefined,
      huge,
    );
    expect(ctxMd).toBeDefined();
    expect(ctxMd!).toContain("## Prior critique");
    expect(ctxMd!).toContain("truncated to fit judge context budget");
    // The whole context stays within ~8k chars even though the input was ~36k.
    expect(ctxMd!.length).toBeLessThanOrEqual(8_000);
    expect(ctxMd!.length).toBeLessThan(huge.length);
  });

  it("returns undefined when no section has content (judge sees no Context block)", () => {
    const ctxMd = buildRetryContext(
      { projectPath: "/nonexistent" } as never,
      "stage_does_not_exist",
      undefined,
      "   ",
    );
    expect(ctxMd).toBeUndefined();
  });
});
