/**
 * RunSupervisor — owns the lifecycle of live runs on top of the pilot.
 *
 * Responsibilities:
 *  - concurrency (PP_MAX_CONCURRENT_RUNS, default 2) with a FIFO queue (queued
 *    starts emit a run.queued frame and resolve with the real run_id once a slot
 *    frees — no placeholder ids),
 *  - bridge each run's pilot EventBus into the server BusPort (every pilot event
 *    is forwarded, tagged by run_id; the terminal run.finalized is owned by the
 *    supervisor so it fires exactly once with the authoritative RunResult status),
 *  - abort,
 *  - per-attempt budget: budget.tick after every attempt.completed, budget.tripwire
 *    on first crossing of a platform_settings cap (warn/downgrade at warn_pct,
 *    block + hard-abort at block_pct),
 *  - touchLastRun(project) on finalize.
 */
import { RunPilot, EventBus, type PilotEvent } from "@pp/pilot";
import type { Engine } from "@pp/engine";
import { budgetStatus, getBudgetCaps, touchLastRun } from "@pp/core";
import type { BusPort } from "./bus.js";

export interface StartRunInput {
  projectPath: string;
  requestText: string;
  mode: "single" | "team" | "best_of" | "review";
  team?: string;
  forum?: string;
  n?: number;
  scopeOverride?: "trivial" | "standard" | "major";
  tierCap?: "haiku" | "sonnet" | "opus" | "fable";
  tierFloor?: "haiku" | "sonnet" | "opus" | "fable";
  noTierPolicy?: boolean;
  /** Test/server seam: explicit stage set (bypasses scope/mode planning). */
  stagesOverride?: unknown;
}

export interface StartResult {
  run_id: string;
  queued: boolean;
}

interface RunEntry {
  abortController: AbortController;
  startedAt: number;
  projectPath: string;
  firedTripwires: Set<string>;
}

const DAY = () => new Date().toISOString().slice(0, 10);

export class RunSupervisor {
  private readonly active = new Map<string, RunEntry>();
  private readonly waiters: Array<() => void> = [];
  private readonly inflight = new Set<Promise<void>>();
  private running = 0;
  private readonly max: number;

  constructor(private readonly serverBus: BusPort, private readonly makeEngine: () => Engine) {
    this.max = Math.max(1, Number(process.env.PP_MAX_CONCURRENT_RUNS ?? 2));
  }

  /** Number of runs currently executing (excludes queued). */
  activeCount(): number {
    return this.active.size;
  }

  private acquire(): Promise<void> {
    if (this.running < this.max) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next(); // hand the slot straight to the next waiter (running unchanged)
    else this.running--;
  }

  /**
   * Start a run. Resolves with the real run_id once the pilot has allocated the
   * run row (run.started) — for immediate runs that's instant; for queued runs
   * it resolves when a slot frees (a run.queued frame fires immediately so the
   * UI shows the pending state). Rejects if the run fails to start (e.g. the
   * project lock is held).
   */
  async start(input: StartRunInput): Promise<StartResult> {
    const wasQueued = this.running >= this.max;
    if (wasQueued) {
      this.serverBus.publish({
        type: "run.queued",
        data: { project_path: input.projectPath, request_text: input.requestText, mode: input.mode },
      });
    }
    await this.acquire();

    const bus = new EventBus();
    const abortController = new AbortController();
    const engine = this.makeEngine();

    let resolvedRunId: ((id: string) => void) | null = null;
    const runIdPromise = new Promise<string>((resolve) => (resolvedRunId = resolve));

    bus.subscribe((ev) => {
      if (ev.type === "run.started" && resolvedRunId) {
        resolvedRunId(ev.run_id);
        resolvedRunId = null;
      }
      this.forward(ev);
    });

    const pilot = new RunPilot({
      projectPath: input.projectPath,
      requestText: input.requestText,
      mode: input.mode,
      team: input.team,
      forum: input.forum,
      n: input.n,
      scopeOverride: input.scopeOverride,
      tierCap: input.tierCap,
      tierFloor: input.tierFloor,
      noTierPolicy: input.noTierPolicy,
      // stagesOverride is a typed StageSpec[] in the pilot; the server passes it
      // through opaquely for the test seam.
      ...(input.stagesOverride ? { stagesOverride: input.stagesOverride as never } : {}),
      engine,
      bus,
      signal: abortController.signal,
    });

    const done = pilot.execute();

    const settled = done
      .then((res) => {
        if (res.run_id) this.active.delete(res.run_id);
        try {
          touchLastRun(input.projectPath);
        } catch {
          /* unregistered project — best effort */
        }
        this.serverBus.publish({
          type: "run.finalized",
          run_id: res.run_id || undefined,
          data: {
            run_id: res.run_id,
            status: res.status,
            finished_at: new Date().toISOString(),
            abort_reason: res.abort_reason,
          },
        });
      })
      .catch(() => {
        /* start failure surfaces via the race below */
      })
      .finally(() => this.release());
    this.inflight.add(settled);
    void settled.finally(() => this.inflight.delete(settled));

    // Resolve the run_id: whichever of run.started / execute-resolution comes first.
    const run_id = await Promise.race([
      runIdPromise,
      done.then((r) => r.run_id),
    ]);

    if (run_id) {
      this.active.set(run_id, {
        abortController,
        startedAt: Date.now(),
        projectPath: input.projectPath,
        firedTripwires: new Set(),
      });
    }
    return { run_id, queued: wasQueued };
  }

  /** Await all in-flight runs to fully settle (their finalize handlers included). */
  async drain(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }

  /** Abort a live run. Returns false if the run isn't active. */
  abort(runId: string): boolean {
    const entry = this.active.get(runId);
    if (!entry) return false;
    entry.abortController.abort();
    return true;
  }

  // ── event bridge ────────────────────────────────────────────────────────
  //
  // WIRE CONTRACT: the forwarded SSE frame shape below — event `type` = the
  // pilot event type, and `data` = the pilot event payload with stage_id /
  // attempt_id / pilot_seq folded in — is the SOURCE OF TRUTH the UI's live-run
  // store (ui/src/stores/liveRunStore.ts, M5i) is aligned to. Do NOT change the
  // forwarded shape (key names, id placement) without coordinating with
  // ui-foundation, or the live-run animation re-breaks.
  private forward(ev: PilotEvent): void {
    // The supervisor owns the terminal run.finalized (fired from done handler),
    // so it carries the authoritative RunResult status exactly once.
    if (ev.type === "run.finalized") return;
    this.serverBus.publish({
      type: ev.type,
      run_id: ev.run_id,
      data: { ...ev.data, stage_id: ev.stage_id, attempt_id: ev.attempt_id, pilot_seq: ev.seq },
    });
    if (ev.type === "attempt.completed") this.onAttemptCompleted(ev);
  }

  private onAttemptCompleted(ev: PilotEvent): void {
    const entry = this.active.get(ev.run_id);
    if (!entry) return;

    const runScope = `run:${ev.run_id}`;
    const dayScope = `day:${DAY()}`;
    const runBudget = budgetStatus(runScope) as { cost_usd?: number; tokens_in?: number; tokens_out?: number } | null;
    this.serverBus.publish({
      type: "budget.tick",
      run_id: ev.run_id,
      data: {
        scope: runScope,
        cost_usd: runBudget?.cost_usd ?? 0,
        tokens_in: runBudget?.tokens_in ?? 0,
        tokens_out: runBudget?.tokens_out ?? 0,
      },
    });

    for (const cap of getBudgetCaps()) {
      if (!cap.limit_usd || cap.limit_usd <= 0) continue;
      const scope = cap.scope === "run" ? runScope : cap.scope === "day" ? dayScope : null;
      if (!scope) continue;
      const b = budgetStatus(scope) as { cost_usd?: number } | null;
      const cost = b?.cost_usd ?? 0;
      const pct = cost / cap.limit_usd;

      if (pct >= cap.block_pct) {
        if (entry.firedTripwires.has(`${cap.scope}:block`)) continue;
        entry.firedTripwires.add(`${cap.scope}:block`);
        this.serverBus.publish({
          type: "budget.tripwire",
          run_id: ev.run_id,
          data: { scope: cap.scope, pct: 100, limit_usd: cap.limit_usd, cost_usd: cost, action: "block" },
        });
        // Hard cap: abort the run.
        entry.abortController.abort();
      } else if (pct >= cap.warn_pct) {
        if (entry.firedTripwires.has(`${cap.scope}:warn`)) continue;
        entry.firedTripwires.add(`${cap.scope}:warn`);
        this.serverBus.publish({
          type: "budget.tripwire",
          run_id: ev.run_id,
          data: { scope: cap.scope, pct: 80, limit_usd: cap.limit_usd, cost_usd: cost, action: "downgrade" },
        });
      }
    }
  }
}
