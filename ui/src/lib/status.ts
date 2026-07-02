/**
 * Maps the harness's status/outcome vocabularies onto the token status palette
 * (--run/--pass/--fail/--warn/--judge/--dim). Kept in one place so every
 * surface — chips, dots, tables, the run tree — colors the same value the same
 * way.
 */
import type {
  RunStatus,
  StageStatus,
  AttemptStatus,
  VerdictOutcome,
} from "@shared/api-types";

export type StatusTone = "run" | "pass" | "fail" | "warn" | "judge" | "dim";

/** CSS var for a tone. */
export function toneVar(tone: StatusTone): string {
  return `var(--${tone})`;
}

/** Whether a tone should pulse (i.e. represents an in-flight state). */
export function toneIsLive(tone: StatusTone): boolean {
  return tone === "run";
}

export function runTone(status: RunStatus): StatusTone {
  switch (status) {
    case "running":
      return "run";
    case "pending":
      return "dim";
    case "complete":
      return "pass";
    case "surfaced":
      return "warn";
    case "crashed":
      return "fail";
    case "aborted":
      return "dim";
    default:
      return "dim";
  }
}

export function stageTone(status: StageStatus): StatusTone {
  switch (status) {
    case "open":
      return "run";
    case "passed":
      return "pass";
    case "surfaced":
      return "warn";
    case "skipped":
      return "dim";
    default:
      return "dim";
  }
}

export function attemptTone(status: AttemptStatus): StatusTone {
  switch (status) {
    case "ok":
      return "pass";
    case "error":
      return "fail";
    case "timeout":
      return "fail";
    case "needs_review":
      return "warn";
    default:
      return "dim";
  }
}

export function verdictTone(outcome: VerdictOutcome): StatusTone {
  switch (outcome) {
    case "pass":
      return "pass";
    case "fail":
      return "fail";
    case "revise":
      return "warn";
    default:
      return "dim";
  }
}
