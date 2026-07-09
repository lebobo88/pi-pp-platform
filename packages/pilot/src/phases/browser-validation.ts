/**
 * Browser-validation stage (web-ui / mobile profiles).
 *
 * When opted in (PP_BROWSER_VALIDATION=1) and Playwright is available, this
 * phase drives the spec's routes in a REAL headless chromium: it resolves a base
 * URL (PP_BROWSER_BASE_URL, else it boots the project's dev server via
 * runtime_smoke_test.dev_cmd), navigates each route, and records console/page/
 * network errors into core Findings, then finalizes — surfacing the stage when
 * the browser found runtime errors.
 *
 * It DEGRADES OPEN per core's contract whenever it cannot run (not opted in,
 * Playwright/chromium missing, or the dev server / drive failed): records an
 * "unavailable" result and surfaces the evidence gap without blocking the run.
 */

import { createRequire } from "node:module";
import {
  browserValidationStart,
  browserValidationFinalize,
  finalizeStage,
  startStage,
  type Finding,
} from "@pp/core";
import { emit, type RunContext, type StageSpec, type StageOutcome } from "../types.js";
import { bootDevServer, playwrightDrive, type BrowserDriver, type DevServer } from "./browser-drive.js";

const require = createRequire(import.meta.url);

// Injectable driver seam: production uses real Playwright; tests inject a fake
// so the finding→finalize→severity wiring is exercised without a chromium binary.
let _driver: BrowserDriver = playwrightDrive;
export function setBrowserDriver(driver: BrowserDriver): void { _driver = driver; }
export function resetBrowserDriver(): void { _driver = playwrightDrive; }

/** Best-effort: is a Playwright browser drive available and opted in? */
function browserAvailable(): boolean {
  if (process.env.PP_BROWSER_VALIDATION !== "1") return false;
  try {
    require.resolve("playwright");
    return true;
  } catch {
    return false;
  }
}

/** Degrade open: record "unavailable", surface the gap, do NOT block the run. */
async function degradeOpen(ctx: RunContext, stage_id: string, reason: string, marker: string): Promise<StageOutcome> {
  const out = browserValidationFinalize({
    run_id: ctx.run_id,
    stage_id,
    engine: "playwright",
    findings: [],
    engine_status: "unavailable",
    unavailable_reason: reason,
  });
  emit(ctx, "validation.result", { kind: "browser", severity: out.effective_severity, degraded: true }, { stage_id });
  await finalizeStage({ stage_id, status: "passed" });
  emit(ctx, "stage.finalized", { status: "passed", degraded: marker }, { stage_id });
  return "passed";
}

export async function runBrowserValidationStage(ctx: RunContext, stage: StageSpec): Promise<StageOutcome> {
  const { stage_id } = startStage({ run_id: ctx.run_id, kind: stage.kind, gate_type: stage.gate_type, plan_index: stage.planIndex ?? null });
  emit(ctx, "stage.started", { kind: stage.kind, gate_type: stage.gate_type, agent: stage.agent }, { stage_id });

  const routes = ctx.profile?.runtime_smoke_test?.routes ?? ["/"];
  browserValidationStart({ run_id: ctx.run_id, routes });

  if (!browserAvailable()) {
    return degradeOpen(
      ctx,
      stage_id,
      "no browser drive available (Playwright/chromium not installed or PP_BROWSER_VALIDATION!=1) — validation skipped, gap surfaced",
      "browser-unavailable",
    );
  }

  // Resolve a target and drive the routes for real.
  let devServer: DevServer | undefined;
  let baseUrl = process.env.PP_BROWSER_BASE_URL;
  let findings: Finding[] = [];
  let driveError: string | undefined;
  try {
    if (!baseUrl) {
      devServer = await bootDevServer(ctx.projectPath, ctx.profile?.runtime_smoke_test, ctx.signal);
      baseUrl = devServer.baseUrl;
    }
    findings = await _driver(baseUrl, routes);
  } catch (err) {
    driveError = (err as Error).message;
  } finally {
    if (devServer) {
      try { await devServer.stop(); } catch { /* best-effort teardown */ }
    }
  }

  if (driveError) {
    return degradeOpen(ctx, stage_id, `browser drive could not run: ${driveError}`, "browser-drive-failed");
  }

  const out = browserValidationFinalize({
    run_id: ctx.run_id,
    stage_id,
    engine: "playwright",
    base_url: baseUrl,
    findings,
    engine_status: "ran",
  });
  emit(
    ctx,
    "validation.result",
    { kind: "browser", severity: out.effective_severity, degraded: false, findings: findings.length },
    { stage_id },
  );
  if (out.effective_severity === "errors") {
    await finalizeStage({ stage_id, status: "surfaced" });
    emit(ctx, "stage.surfaced", { reason: "browser validation found runtime errors" }, { stage_id });
    return "surfaced";
  }
  await finalizeStage({ stage_id, status: "passed" });
  emit(ctx, "stage.finalized", { status: "passed" }, { stage_id });
  return "passed";
}
