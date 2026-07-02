/**
 * Pilot error taxonomy.
 *
 * These are the failure modes the master driver skill treats specially:
 * a broken judge environment halts the run (never fabricate a verdict), and
 * an unresolvable tier is a refuse-to-dispatch condition.
 */

/**
 * Thrown when the judge pool is empty for a stage — every eligible provider is
 * disabled (kill switch) or excluded by the cross-vendor requirement. Per the
 * judge-halt protocol this surfaces the stage and aborts the run; the harness
 * NEVER downgrades a cross-vendor gate to same-vendor and NEVER fabricates a
 * passing verdict to unblock the pipeline.
 */
export class JudgeUnavailableError extends Error {
  constructor(
    message: string,
    public readonly gate_type: string,
    public readonly required_cross_vendor: boolean,
    public readonly generator_provider: string,
  ) {
    super(message);
    this.name = "JudgeUnavailableError";
  }
}

/**
 * Thrown when a stage's agent has no entry in AGENT_TIER_DEFAULTS and no
 * `model:` frontmatter to derive one from. run.md: "Refusing to dispatch beats
 * silently inheriting Opus."
 */
export class TierResolutionError extends Error {
  constructor(message: string, public readonly agent: string) {
    super(message);
    this.name = "TierResolutionError";
  }
}

/** An unexpected internal failure that maps the run to status="crashed". */
export class PilotInternalError extends Error {
  constructor(message: string, public readonly cause_error?: unknown) {
    super(message);
    this.name = "PilotInternalError";
  }
}
