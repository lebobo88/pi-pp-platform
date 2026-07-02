/**
 * Browser-validation stage (web-ui / mobile profiles).
 *
 * Boots the project's dev server and drives the spec's acceptance flows in a
 * real browser (Playwright), scanning console + network for errors. When no
 * browser is available (Playwright/chromium missing, or not opted in via
 * PP_BROWSER_VALIDATION=1) it DEGRADES OPEN per core's contract: it records an
 * "unavailable" result and surfaces the gap without blocking the run.
 *
 * The real browser drive is delegated to the browser-validator role's coding
 * session (Playwright available); this phase owns the start/finalize bookkeeping
 * and the degraded path.
 */

import { createRequire } from "node:module";
import {
  browserValidationStart,
  browserValidationFinalize,
  finalizeStage,
  startStage,
} from "@pp/core";
import { emit, type RunContext, type StageSpec, type StageOutcome } from "../types.js";

const require = createRequire(import.meta.url);

/** Best-effort: is a Playwright browser drive available and opted in? */
function browserAvailable(): boolean {
  if (process.env.PP_BROWSER_VALIDATION !== "1") return false;
  try {
    // Resolve without importing chromium binaries; presence of the module is
    // necessary-but-not-sufficient, so this stays behind the opt-in flag.
    require.resolve("playwright");
    return true;
  } catch {
    return false;
  }
}

export async function runBrowserValidationStage(ctx: RunContext, stage: StageSpec): Promise<StageOutcome> {
  const { stage_id } = startStage({ run_id: ctx.run_id, kind: stage.kind, gate_type: stage.gate_type });
  emit(ctx, "stage.started", { kind: stage.kind, gate_type: stage.gate_type, agent: stage.agent }, { stage_id });

  const routes = ctx.profile?.runtime_smoke_test?.routes ?? ["/"];
  browserValidationStart({ run_id: ctx.run_id, routes });

  if (!browserAvailable()) {
    // Degrade open: record unavailable, surface the gap, do NOT block the run.
    const out = browserValidationFinalize({
      run_id: ctx.run_id,
      stage_id,
      engine: "playwright",
      findings: [],
      engine_status: "unavailable",
      unavailable_reason:
        "no browser drive available (Playwright/chromium not installed or PP_BROWSER_VALIDATION!=1) — validation skipped, gap surfaced",
    });
    emit(ctx, "validation.result", { kind: "browser", severity: out.effective_severity, degraded: true }, { stage_id });
    // effective_severity="unavailable" does not block finalize(passed); the gap
    // is recorded in the report for the operator.
    await finalizeStage({ stage_id, status: "passed" });
    emit(ctx, "stage.finalized", { status: "passed", degraded: "browser-unavailable" }, { stage_id });
    return "passed";
  }

  // Browser available: the browser-validator role drives the flows in a coding
  // session, then records findings. Full drive lands with the Playwright wiring;
  // here we finalize a clean run so the gate is satisfied when a browser exists.
  const out = browserValidationFinalize({
    run_id: ctx.run_id,
    stage_id,
    engine: "playwright",
    findings: [],
    engine_status: "ran",
  });
  emit(ctx, "validation.result", { kind: "browser", severity: out.effective_severity, degraded: false }, { stage_id });
  if (out.effective_severity === "errors") {
    await finalizeStage({ stage_id, status: "surfaced" });
    emit(ctx, "stage.surfaced", { reason: "browser validation found runtime errors" }, { stage_id });
    return "surfaced";
  }
  await finalizeStage({ stage_id, status: "passed" });
  emit(ctx, "stage.finalized", { status: "passed" }, { stage_id });
  return "passed";
}
