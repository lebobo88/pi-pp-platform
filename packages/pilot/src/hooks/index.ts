/**
 * Hook parity layer — the 29 Claude-Code hooks from pair-programmer's
 * settings.json, reimplemented as in-process middleware/guards/blockers.
 *
 * pair-programmer wired behavior through Claude-Code hook scripts
 * (SessionStart / PreToolUse / PostToolUse / UserPromptSubmit / Stop). The pi
 * platform has no Claude-Code host, so each hook becomes a pure function over a
 * {@link HookInput} snapshot returning a {@link HookResult}:
 *
 *   - "block"   — a PreToolUse/Stop guard refuses the action (fail-closed).
 *   - "warn"    — a soft signal that doesn't block.
 *   - "context" — a SessionStart/UserPromptSubmit preamble injected into the
 *                 model's context.
 *   - "allow"   — no-op / passthrough.
 *
 * The functions are pure so they're trivially testable (hooks-parity.test.ts)
 * and reusable both by RunPilot (which already enforces several of these inline
 * — cost tally, loop ceiling, summary format) and by the future MCP adapter /
 * server middleware.
 */

import { evaluateShellSafety, scanForSecrets, heuristicMapping } from "@pp/core";

export type HookPhase = "SessionStart" | "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop";
export type HookDecision = "allow" | "block" | "warn" | "context";

export interface HookResult {
  decision: HookDecision;
  message?: string;
  data?: Record<string, unknown>;
}

/** Snapshot of run/environment state a hook may consult. */
export interface HookState {
  daemonReachable?: boolean;
  vendors?: { openai?: boolean; google?: boolean; anthropic?: boolean };
  crossVendorReady?: boolean;
  cliVersions?: Record<string, string>;
  masterPlanExists?: boolean;
  surfacedRunCount?: number;
  hasActiveRun?: boolean;
  sandboxPolicy?: "read-only" | "workspace-write";
  validatorSatisfied?: boolean;
  loopCeiling?: { validator_calls: number; ceiling: number; blocked: boolean };
  verdictDimensions?: number;
  profileName?: string;
  decisionLogPresent?: boolean;
  /** Ecosystem (TheEights/Hydra) integrations are opt-in; default OFF. */
  ecosystemEnabled?: boolean;
}

export interface HookInput {
  phase: HookPhase;
  /** Tool name for Pre/PostToolUse (e.g. "archive_artifact", "finalize_stage", "Bash"). */
  tool?: string;
  /** Tool input payload (command string, artifact bytes, gate_type, …). */
  input?: Record<string, unknown>;
  /** Tool result payload (for PostToolUse). */
  result?: Record<string, unknown>;
  /** User prompt text (UserPromptSubmit). */
  prompt?: string;
  /** Working directory for shell-safety evaluation. */
  cwd?: string;
  /** Run summary markdown (Stop/summary-format-check). */
  summaryMd?: string;
  state?: HookState;
}

export interface Hook {
  id: string;
  phase: HookPhase;
  capability: string;
  /** Whether this hook applies to the given input. */
  matches(input: HookInput): boolean;
  run(input: HookInput): HookResult;
}

const allow = (): HookResult => ({ decision: "allow" });
const s = (i: HookInput): HookState => i.state ?? {};

/** Tools that persist run state and therefore require an open run (H8). */
const PERSISTENCE_TOOLS = new Set([
  "start_stage", "record_attempt", "record_verdict", "archive_artifact",
  "finalize_stage", "run_missability_checks", "retry_with_critique",
  "record_taxonomy_mapping", "record_smoke_status",
]);

const CROSS_VENDOR_GATES = new Set(["spec", "design", "security", "contract"]);

export const HOOKS: Hook[] = [
  // ── SessionStart (H1–H6): context preambles ────────────────────────────────
  {
    id: "H1", phase: "SessionStart", capability: "daemon-up — daemon reachability preamble",
    matches: () => true,
    run: (i) => s(i).daemonReachable === false
      ? { decision: "context", message: "pp state layer is unreachable — persistence calls will fail until it is restored." }
      : { decision: "context", message: "pp state layer: reachable." },
  },
  {
    id: "H2", phase: "SessionStart", capability: "vendor-matrix — vendor capability summary",
    matches: () => true,
    run: (i) => {
      const v = s(i).vendors ?? {};
      const on = Object.entries(v).filter(([, ok]) => ok).map(([k]) => k);
      return { decision: "context", message: `vendors configured: ${on.length ? on.join(", ") : "(none)"}`, data: { vendors: v } };
    },
  },
  {
    id: "H3", phase: "SessionStart", capability: "cli-version-pin — pin sub-CLI versions",
    matches: () => true,
    run: (i) => ({ decision: "context", message: "pinned runtime versions", data: { cli_versions: s(i).cliVersions ?? {} } }),
  },
  {
    id: "H4", phase: "SessionStart", capability: "master-plan-load — surface PROJECT_MASTER.md",
    matches: () => true,
    run: (i) => s(i).masterPlanExists
      ? { decision: "context", message: "PROJECT_MASTER.md present — loaded into context." }
      : { decision: "context", message: "no PROJECT_MASTER.md yet — it will be scaffolded on first finalize." },
  },
  {
    id: "H5", phase: "SessionStart", capability: "surfaced-runs — remind about surfaced runs",
    matches: () => true,
    run: (i) => {
      const n = s(i).surfacedRunCount ?? 0;
      return n > 0
        ? { decision: "context", message: `${n} surfaced run(s) need attention (see /pp:status).`, data: { surfaced: n } }
        : allow();
    },
  },
  {
    id: "H6", phase: "SessionStart", capability: "eights-recall-project — episodic project recall",
    matches: (i) => s(i).ecosystemEnabled === true,
    run: () => ({ decision: "context", message: "TheEights episodic recall (project scope) available." }),
  },

  // ── PreToolUse (H7–H14): guards / blockers ─────────────────────────────────
  {
    id: "H7", phase: "PreToolUse", capability: "block-destructive-shell — rm -rf guard",
    matches: (i) => i.tool === "Bash" && typeof i.input?.command === "string",
    run: (i) => {
      const verdict = evaluateShellSafety(String(i.input!.command), i.cwd ?? process.cwd());
      return verdict.decision === "block"
        ? { decision: "block", message: `destructive shell blocked: ${verdict.reason ?? verdict.pattern ?? "unsafe command"}` }
        : allow();
    },
  },
  {
    id: "H8", phase: "PreToolUse", capability: "enforce-active-run — require an open run",
    matches: (i) => !!i.tool && PERSISTENCE_TOOLS.has(i.tool),
    run: (i) => s(i).hasActiveRun === false
      ? { decision: "block", message: `${i.tool} requires an open run — call start_run first.` }
      : allow(),
  },
  {
    id: "H9", phase: "PreToolUse", capability: "enforce-vendor-matrix — cross-vendor availability",
    matches: (i) => i.tool === "record_verdict" || i.tool === "gate_eligible_judges",
    run: (i) => {
      const gate = String(i.input?.gate_type ?? "");
      if (CROSS_VENDOR_GATES.has(gate) && s(i).crossVendorReady === false) {
        return { decision: "block", message: `gate_type=${gate} requires cross-vendor judging but no second vendor is configured.` };
      }
      return allow();
    },
  },
  {
    id: "H10", phase: "PreToolUse", capability: "enforce-sandbox-policy — read-only vs workspace-write",
    matches: (i) => i.tool === "Write" || i.tool === "Edit" || i.tool === "Bash",
    run: (i) => s(i).sandboxPolicy === "read-only"
      ? { decision: "block", message: `${i.tool} blocked under read-only sandbox policy (readonly stage).` }
      : allow(),
  },
  {
    id: "H11", phase: "PreToolUse", capability: "enforce-no-secrets — block secret writes",
    matches: (i) => i.tool === "archive_artifact" && typeof i.input?.bytes === "string",
    run: (i) => {
      const matches = scanForSecrets(String(i.input!.bytes));
      return matches.length > 0
        ? { decision: "block", message: `archive blocked: ${matches.length} secret(s) detected in artifact bytes.`, data: { matches: matches.length } }
        : allow();
    },
  },
  {
    id: "H12", phase: "PreToolUse", capability: "enforce-validator-gate — block finalize without validation",
    matches: (i) => i.tool === "finalize_stage" && i.input?.status === "passed",
    run: (i) => s(i).validatorSatisfied === false
      ? { decision: "block", message: "finalize_stage(passed) blocked — a required artifact validator has not verified yet." }
      : allow(),
  },
  {
    id: "H13", phase: "PreToolUse", capability: "enforce-rfc2119-language — normative spec language",
    matches: (i) => i.tool === "archive_artifact" && (i.input?.kind === "spec" || i.input?.kind === "prd" || i.input?.kind === "acceptance_criteria"),
    run: (i) => {
      const text = String(i.input?.bytes ?? "");
      return /\b(MUST|SHALL|SHOULD|MAY|MUST NOT|SHALL NOT)\b/.test(text)
        ? allow()
        : { decision: "warn", message: "spec artifact lacks RFC-2119 normative keywords (MUST/SHALL/SHOULD/MAY)." };
    },
  },
  {
    id: "H14", phase: "PreToolUse", capability: "eights-recall-stage — episodic stage recall",
    matches: (i) => s(i).ecosystemEnabled === true && i.tool === "start_stage",
    run: () => ({ decision: "context", message: "TheEights episodic recall (stage scope) available." }),
  },

  // ── PostToolUse (H15–H21): middleware ──────────────────────────────────────
  {
    id: "H15", phase: "PostToolUse", capability: "cost-tally — accumulate token cost",
    matches: (i) => i.tool === "record_attempt",
    run: (i) => {
      const cost = Number(i.input?.cost_usd ?? 0);
      const tin = Number(i.input?.tokens_in ?? 0);
      const tout = Number(i.input?.tokens_out ?? 0);
      return { decision: "allow", data: { cost_usd: cost, tokens_in: tin, tokens_out: tout } };
    },
  },
  {
    id: "H16", phase: "PostToolUse", capability: "record-attempt — auto-record on tool result",
    matches: (i) => i.tool === "generate" || i.tool === "runCodingSession" || i.tool === "runAuthoringCompletion",
    run: () => ({ decision: "context", message: "generation completed — record_attempt should follow." }),
  },
  {
    id: "H17", phase: "PostToolUse", capability: "taxonomy-coverage-update — mark section coverage",
    matches: (i) => i.tool === "archive_artifact" && typeof i.input?.taxonomy_section === "string",
    run: (i) => ({ decision: "allow", data: { covered_section: String(i.input!.taxonomy_section) } }),
  },
  {
    id: "H18", phase: "PostToolUse", capability: "hash-artifact — content hash on archive",
    matches: (i) => i.tool === "archive_artifact",
    run: (i) => ({ decision: "allow", data: { sha256: String(i.result?.sha256 ?? "") } }),
  },
  {
    id: "H19", phase: "PostToolUse", capability: "loop-ceiling-tally — validator-call ceiling",
    matches: (i) => i.tool === "record_verdict",
    run: (i) => {
      const lc = s(i).loopCeiling;
      if (lc && lc.blocked) {
        return { decision: "block", message: `loop ceiling reached: ${lc.validator_calls}/${lc.ceiling} validator calls this run.`, data: { ...lc } };
      }
      return { decision: "allow", data: lc ? { ...lc } : {} };
    },
  },
  {
    id: "H20", phase: "PostToolUse", capability: "verdict-rubric-coverage — rubric dimensions covered",
    matches: (i) => i.tool === "record_verdict",
    run: (i) => {
      const dims = s(i).verdictDimensions ?? 0;
      return dims < 3
        ? { decision: "warn", message: `verdict scored only ${dims} rubric dimension(s); expected >= 3.`, data: { dimensions: dims } }
        : { decision: "allow", data: { dimensions: dims } };
    },
  },
  {
    id: "H21", phase: "PostToolUse", capability: "update-master-plan — patch master plan on finalize",
    matches: (i) => i.tool === "finalize_run" && i.input?.status === "complete",
    run: () => ({ decision: "context", message: "run complete — master-plan patch should follow." }),
  },

  // ── UserPromptSubmit (H22–H27): nudges ─────────────────────────────────────
  {
    id: "H22", phase: "UserPromptSubmit", capability: "taxonomy-nudge — suggest taxonomy sections",
    matches: (i) => !!i.prompt,
    run: (i) => {
      const mapping = heuristicMapping({ request_text: i.prompt! });
      const ids = mapping.sections.map((sec) => sec.id);
      return { decision: "context", message: `likely taxonomy sections: ${ids.join(", ")}`, data: { sections: ids } };
    },
  },
  {
    id: "H23", phase: "UserPromptSubmit", capability: "team-suggester — suggest a team",
    matches: (i) => !!i.prompt,
    run: (i) => {
      const t = i.prompt!.toLowerCase();
      const team = /\bbug|fix|repro\b/.test(t) ? "bug-fix-team"
        : /\brefactor\b/.test(t) ? "refactor-team"
        : /\bsecurity|threat|auth\b/.test(t) ? "security-review-team"
        : /\bfeature|build|add\b/.test(t) ? "feature-team"
        : null;
      return team ? { decision: "context", message: `consider /pp:team ${team}`, data: { team } } : allow();
    },
  },
  {
    id: "H24", phase: "UserPromptSubmit", capability: "risk-flag — flag risky requests",
    matches: (i) => !!i.prompt,
    run: (i) => /\b(delete|drop|migrat|prod(uction)?|secret|credential|rm -rf|force[- ]?push)\b/i.test(i.prompt!)
      ? { decision: "warn", message: "request contains risk keywords (destructive / production / secrets) — proceed carefully." }
      : allow(),
  },
  {
    id: "H25", phase: "UserPromptSubmit", capability: "surfaced-run-reminder — remind of open runs",
    matches: (i) => (s(i).surfacedRunCount ?? 0) > 0,
    run: (i) => ({ decision: "context", message: `${s(i).surfacedRunCount} surfaced run(s) still open — resolve or /pp:retry.` }),
  },
  {
    id: "H26", phase: "UserPromptSubmit", capability: "profile-aware-nudge — profile-specific hints",
    matches: (i) => !!s(i).profileName,
    run: (i) => ({ decision: "context", message: `active profile: ${s(i).profileName} — its gate/rubric bindings apply.`, data: { profile: s(i).profileName } }),
  },
  {
    id: "H27", phase: "UserPromptSubmit", capability: "eights-recall-request — recall on prompt",
    matches: (i) => s(i).ecosystemEnabled === true && !!i.prompt,
    run: () => ({ decision: "context", message: "TheEights recall (request scope) available." }),
  },

  // ── Stop (H28–H29): finalize guards ────────────────────────────────────────
  {
    id: "H28", phase: "Stop", capability: "decision-log-required — require decision log at stop",
    matches: () => true,
    run: (i) => s(i).decisionLogPresent === false
      ? { decision: "block", message: "run cannot stop cleanly — no decision-log / ADR evidence recorded." }
      : allow(),
  },
  {
    id: "H29", phase: "Stop", capability: "summary-format-check — validate run summary format",
    matches: (i) => typeof i.summaryMd === "string",
    run: (i) => {
      const md = i.summaryMd ?? "";
      const ok = /##\s*What changed/i.test(md) && /##\s*What'?s next/i.test(md);
      return ok
        ? allow()
        : { decision: "block", message: "run summary must contain '## What changed' and '## What's next' sections." };
    },
  },
];

if (HOOKS.length !== 29) {
  throw new Error(`hook registry drift: expected 29 hooks, got ${HOOKS.length}`);
}

/** Run every hook that matches the input's phase, in registry order. */
export function runHooks(input: HookInput): Array<{ id: string; capability: string; result: HookResult }> {
  return HOOKS.filter((h) => h.phase === input.phase && h.matches(input)).map((h) => ({
    id: h.id,
    capability: h.capability,
    result: h.run(input),
  }));
}

/** True when any matching PreToolUse/Stop hook blocked the action. */
export function isBlocked(input: HookInput): { blocked: boolean; by?: string; message?: string } {
  for (const { id, result } of runHooks(input)) {
    if (result.decision === "block") return { blocked: true, by: id, message: result.message };
  }
  return { blocked: false };
}

export function getHook(id: string): Hook | undefined {
  return HOOKS.find((h) => h.id === id);
}
