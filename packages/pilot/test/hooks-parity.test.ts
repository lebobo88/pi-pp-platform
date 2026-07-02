import { describe, it, expect } from "vitest";
import { HOOKS, runHooks, isBlocked, getHook, type HookInput } from "../src/hooks/index.js";

/** Exercise one hook by id with an input, returning its result. */
function fire(id: string, input: HookInput) {
  const hook = getHook(id)!;
  expect(hook).toBeDefined();
  expect(hook.matches(input)).toBe(true);
  return hook.run(input);
}

describe("hooks parity — registry", () => {
  it("registers exactly 29 hooks (H1..H29), unique ids, valid phases", () => {
    expect(HOOKS.length).toBe(29);
    const ids = HOOKS.map((h) => h.id);
    expect(new Set(ids).size).toBe(29);
    expect(ids).toEqual(Array.from({ length: 29 }, (_, i) => `H${i + 1}`));
    const phases = new Set(["SessionStart", "PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop"]);
    for (const h of HOOKS) expect(phases.has(h.phase)).toBe(true);
  });
});

describe("hooks parity — SessionStart (H1..H6)", () => {
  it("H1 daemon-up flags an unreachable state layer", () => {
    expect(fire("H1", { phase: "SessionStart", state: { daemonReachable: false } }).message).toMatch(/unreachable/);
    expect(fire("H1", { phase: "SessionStart", state: { daemonReachable: true } }).decision).toBe("context");
  });
  it("H2 vendor-matrix summarizes configured vendors", () => {
    const r = fire("H2", { phase: "SessionStart", state: { vendors: { openai: true, anthropic: true, google: false } } });
    expect(r.message).toMatch(/openai/);
    expect(r.message).toMatch(/anthropic/);
  });
  it("H3 cli-version-pin surfaces pinned versions", () => {
    expect(fire("H3", { phase: "SessionStart", state: { cliVersions: { pi: "0.80.3" } } }).data?.cli_versions).toEqual({ pi: "0.80.3" });
  });
  it("H4 master-plan-load reports presence", () => {
    expect(fire("H4", { phase: "SessionStart", state: { masterPlanExists: true } }).message).toMatch(/present/);
  });
  it("H5 surfaced-runs reminds when > 0", () => {
    expect(fire("H5", { phase: "SessionStart", state: { surfacedRunCount: 2 } }).message).toMatch(/2 surfaced/);
    expect(getHook("H5")!.run({ phase: "SessionStart", state: { surfacedRunCount: 0 } }).decision).toBe("allow");
  });
  it("H6 eights-recall-project only matches when ecosystem is enabled", () => {
    expect(getHook("H6")!.matches({ phase: "SessionStart", state: { ecosystemEnabled: false } })).toBe(false);
    expect(fire("H6", { phase: "SessionStart", state: { ecosystemEnabled: true } }).decision).toBe("context");
  });
});

describe("hooks parity — PreToolUse guards (H7..H14)", () => {
  it("H7 blocks destructive shell (rm -rf /)", () => {
    const r = fire("H7", { phase: "PreToolUse", tool: "Bash", input: { command: "rm -rf /" }, cwd: process.cwd() });
    expect(r.decision).toBe("block");
    expect(getHook("H7")!.run({ phase: "PreToolUse", tool: "Bash", input: { command: "ls -la" }, cwd: process.cwd() }).decision).toBe("allow");
  });
  it("H8 blocks persistence tools without an active run", () => {
    expect(fire("H8", { phase: "PreToolUse", tool: "record_attempt", state: { hasActiveRun: false } }).decision).toBe("block");
    expect(getHook("H8")!.run({ phase: "PreToolUse", tool: "record_attempt", state: { hasActiveRun: true } }).decision).toBe("allow");
  });
  it("H9 blocks a cross-vendor gate when no second vendor is configured", () => {
    expect(fire("H9", { phase: "PreToolUse", tool: "record_verdict", input: { gate_type: "security" }, state: { crossVendorReady: false } }).decision).toBe("block");
    expect(getHook("H9")!.run({ phase: "PreToolUse", tool: "record_verdict", input: { gate_type: "code_style" }, state: { crossVendorReady: false } }).decision).toBe("allow");
  });
  it("H10 blocks writes under a read-only sandbox", () => {
    expect(fire("H10", { phase: "PreToolUse", tool: "Write", state: { sandboxPolicy: "read-only" } }).decision).toBe("block");
    expect(getHook("H10")!.run({ phase: "PreToolUse", tool: "Write", state: { sandboxPolicy: "workspace-write" } }).decision).toBe("allow");
  });
  it("H11 blocks archives containing secrets", () => {
    const secret = "AWS key AKIAIOSFODNN7EXAMPLE and secret wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    expect(fire("H11", { phase: "PreToolUse", tool: "archive_artifact", input: { bytes: secret } }).decision).toBe("block");
    expect(getHook("H11")!.run({ phase: "PreToolUse", tool: "archive_artifact", input: { bytes: "just some markdown" } }).decision).toBe("allow");
  });
  it("H12 blocks finalize(passed) when a validator is unsatisfied", () => {
    expect(fire("H12", { phase: "PreToolUse", tool: "finalize_stage", input: { status: "passed" }, state: { validatorSatisfied: false } }).decision).toBe("block");
    expect(getHook("H12")!.run({ phase: "PreToolUse", tool: "finalize_stage", input: { status: "passed" }, state: { validatorSatisfied: true } }).decision).toBe("allow");
  });
  it("H13 warns when a spec lacks RFC-2119 language", () => {
    expect(fire("H13", { phase: "PreToolUse", tool: "archive_artifact", input: { kind: "spec", bytes: "the system does things" } }).decision).toBe("warn");
    expect(getHook("H13")!.run({ phase: "PreToolUse", tool: "archive_artifact", input: { kind: "spec", bytes: "the system MUST authenticate" } }).decision).toBe("allow");
  });
  it("H14 eights-recall-stage only matches with ecosystem + start_stage", () => {
    expect(getHook("H14")!.matches({ phase: "PreToolUse", tool: "start_stage", state: { ecosystemEnabled: false } })).toBe(false);
    expect(fire("H14", { phase: "PreToolUse", tool: "start_stage", state: { ecosystemEnabled: true } }).decision).toBe("context");
  });
});

describe("hooks parity — PostToolUse middleware (H15..H21)", () => {
  it("H15 cost-tally extracts token cost from record_attempt", () => {
    expect(fire("H15", { phase: "PostToolUse", tool: "record_attempt", input: { cost_usd: 0.5, tokens_in: 10, tokens_out: 20 } }).data).toEqual({ cost_usd: 0.5, tokens_in: 10, tokens_out: 20 });
  });
  it("H16 record-attempt fires after generation", () => {
    expect(fire("H16", { phase: "PostToolUse", tool: "runCodingSession" }).decision).toBe("context");
  });
  it("H17 taxonomy-coverage-update marks the covered section", () => {
    expect(fire("H17", { phase: "PostToolUse", tool: "archive_artifact", input: { taxonomy_section: "4.8" } }).data?.covered_section).toBe("4.8");
  });
  it("H18 hash-artifact surfaces the sha256", () => {
    expect(fire("H18", { phase: "PostToolUse", tool: "archive_artifact", result: { sha256: "abc123" } }).data?.sha256).toBe("abc123");
  });
  it("H19 loop-ceiling-tally blocks when the ceiling is reached", () => {
    expect(fire("H19", { phase: "PostToolUse", tool: "record_verdict", state: { loopCeiling: { validator_calls: 6, ceiling: 6, blocked: true } } }).decision).toBe("block");
    expect(getHook("H19")!.run({ phase: "PostToolUse", tool: "record_verdict", state: { loopCeiling: { validator_calls: 2, ceiling: 6, blocked: false } } }).decision).toBe("allow");
  });
  it("H20 verdict-rubric-coverage warns below 3 dimensions", () => {
    expect(fire("H20", { phase: "PostToolUse", tool: "record_verdict", state: { verdictDimensions: 2 } }).decision).toBe("warn");
    expect(getHook("H20")!.run({ phase: "PostToolUse", tool: "record_verdict", state: { verdictDimensions: 4 } }).decision).toBe("allow");
  });
  it("H21 update-master-plan fires on finalize_run(complete)", () => {
    expect(fire("H21", { phase: "PostToolUse", tool: "finalize_run", input: { status: "complete" } }).decision).toBe("context");
  });
});

describe("hooks parity — UserPromptSubmit nudges (H22..H27)", () => {
  it("H22 taxonomy-nudge suggests sections", () => {
    expect((fire("H22", { phase: "UserPromptSubmit", prompt: "add an API endpoint" }).data?.sections as string[]).length).toBeGreaterThan(0);
  });
  it("H23 team-suggester recommends a team", () => {
    expect(fire("H23", { phase: "UserPromptSubmit", prompt: "fix the login bug" }).data?.team).toBe("bug-fix-team");
  });
  it("H24 risk-flag warns on destructive keywords", () => {
    expect(fire("H24", { phase: "UserPromptSubmit", prompt: "delete the production database" }).decision).toBe("warn");
    expect(getHook("H24")!.run({ phase: "UserPromptSubmit", prompt: "rename a variable" }).decision).toBe("allow");
  });
  it("H25 surfaced-run-reminder matches only with open runs", () => {
    expect(getHook("H25")!.matches({ phase: "UserPromptSubmit", state: { surfacedRunCount: 0 } })).toBe(false);
    expect(fire("H25", { phase: "UserPromptSubmit", state: { surfacedRunCount: 1 } }).decision).toBe("context");
  });
  it("H26 profile-aware-nudge surfaces the active profile", () => {
    expect(fire("H26", { phase: "UserPromptSubmit", prompt: "x", state: { profileName: "web-ui" } }).data?.profile).toBe("web-ui");
  });
  it("H27 eights-recall-request needs ecosystem + prompt", () => {
    expect(getHook("H27")!.matches({ phase: "UserPromptSubmit", prompt: "x", state: { ecosystemEnabled: false } })).toBe(false);
    expect(fire("H27", { phase: "UserPromptSubmit", prompt: "x", state: { ecosystemEnabled: true } }).decision).toBe("context");
  });
});

describe("hooks parity — Stop guards (H28..H29)", () => {
  it("H28 decision-log-required blocks stop without a decision log", () => {
    expect(fire("H28", { phase: "Stop", state: { decisionLogPresent: false } }).decision).toBe("block");
    expect(getHook("H28")!.run({ phase: "Stop", state: { decisionLogPresent: true } }).decision).toBe("allow");
  });
  it("H29 summary-format-check blocks a summary missing the required sections", () => {
    expect(fire("H29", { phase: "Stop", summaryMd: "just a blob" }).decision).toBe("block");
    expect(getHook("H29")!.run({ phase: "Stop", summaryMd: "## What changed\n- x\n## What's next\n- y" }).decision).toBe("allow");
  });
});

describe("hooks parity — dispatcher", () => {
  it("runHooks returns only matching-phase hooks; isBlocked surfaces the first block", () => {
    const results = runHooks({ phase: "SessionStart", state: { daemonReachable: true, vendors: { openai: true } } });
    expect(results.every((r) => r.id.startsWith("H"))).toBe(true);
    const blocked = isBlocked({ phase: "PreToolUse", tool: "Bash", input: { command: "rm -rf /" }, cwd: process.cwd() });
    expect(blocked.blocked).toBe(true);
    expect(blocked.by).toBe("H7");
  });
});
