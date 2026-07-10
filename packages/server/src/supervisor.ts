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
import { RunPilot, resumeRun, EventBus, type PilotEvent } from "@pp/pilot";
import type { Engine } from "@pp/engine";
import { budgetStatus, getBudgetCaps, touchLastRun, localDayKey, db, getFinalizationArtifacts, type RunStatus } from "@pp/core";
import type { BusPort } from "./bus.js";
import type { FastifyBaseLogger } from "fastify";

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
  /** Per-run effective-ladder overrides (top precedence): tier → model id / pool. */
  ladderOverride?: Partial<Record<"haiku" | "sonnet" | "opus" | "fable", string>>;
  tierPoolsOverride?: Partial<Record<"haiku" | "sonnet" | "opus" | "fable", string[]>>;
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

// Local-time day key — must match core tallyBudgets bucketing (see localDayKey).
const DAY = () => localDayKey();

export class RunSupervisor {
  private readonly active = new Map<string, RunEntry>();
  private readonly waiters: Array<() => void> = [];
  private readonly inflight = new Set<Promise<void>>();
  private running = 0;
  private readonly max: number;

  constructor(private readonly serverBus: BusPort, private readonly makeEngine: () => Engine, private readonly logger?: FastifyBaseLogger) {
    this.max = Math.max(1, Number(process.env.PP_MAX_CONCURRENT_RUNS ?? 2));
  }

  /** Number of runs currently executing (excludes queued). */
  activeCount(): number {
    return this.active.size;
  }

  /**
   * Synchronous in-process check: is `runId` already owned by this supervisor
   * (a live `start()` still executing, or a `resume()` already in flight)?
   * The resume HTTP route uses this for a fast, no-await 409 before doing any
   * DB work. `resume()` itself re-checks (and claims) synchronously too, so
   * this is a fast-path convenience, not the sole race guard — the atomic
   * `UPDATE ... WHERE status='surfaced'` inside `resumeRun` (packages/core)
   * is the second, DB-level line of defense for cross-process races.
   */
  isActive(runId: string): boolean {
    return this.active.has(runId);
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
      this.logger?.info({ project: input.projectPath, mode: input.mode }, "Run queued");
      this.serverBus.publish({
        type: "run.queued",
        data: { project_path: input.projectPath, request_text: input.requestText, mode: input.mode },
      });
    }
    await this.acquire();

    this.logger?.info({ project: input.projectPath, mode: input.mode }, "Run executing pilot phase");

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
      ladderOverride: input.ladderOverride,
      tierPoolsOverride: input.tierPoolsOverride,
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
        const runLog = res.run_id
          ? this.logger?.child({ run_id: res.run_id })
          : this.logger;
        if (res.run_id) {
          this.active.delete(res.run_id);
          runLog?.info({ status: res.status, abortReason: res.abort_reason }, "Run finalized");
        }
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
            ...(res.run_id ? { artifacts: getFinalizationArtifacts(res.run_id) } : {}),
          },
        });
      })
      .catch((err) => {
        this.logger?.error({ err, project: input.projectPath }, "Run crashed during execution");
        // Surface the reason instead of swallowing it — a run that rejects
        // (rather than returning status:crashed) still gets a finalized event
        // carrying why, so the UI/SSE never shows a bare "crashed".
        this.serverBus.publish({
          type: "run.finalized",
          data: {
            status: "crashed",
            finished_at: new Date().toISOString(),
            abort_reason: (err as Error)?.message ?? "run failed to start",
          },
        });
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
      this.logger?.child({ run_id }).info({ mode: input.mode, project: input.projectPath }, "Run started");
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

  /**
   * Resume a surfaced/blocked run on the SAME run_id. Mirrors `start()`'s
   * concurrency-slot + abort-controller + budget-tripwire bookkeeping, but
   * drives the pilot's `resumeRun` instead of a fresh `RunPilot.execute()`,
   * and — unlike `start()` — awaits the whole attempt before returning, so
   * the HTTP response body is the authoritative `RunResumeResponse` (resume
   * is closer in shape to the synchronous retry/gate post-hoc ops than to a
   * long-lived backgrounded `start()`).
   *
   * Race guard: `runId` is claimed in `this.active` synchronously, before any
   * `await`, closing the TOCTOU window between two concurrent resume calls in
   * this same process (the caller's `isActive()` pre-check is a fast-path
   * convenience on top of this, not the sole guard). The remaining gap
   * (a resume racing the original run's own `execute()`, or two separate
   * server processes) is covered by `resumeRun`'s own atomic
   * `UPDATE ... WHERE status='surfaced'` claim inside packages/core.
   */
  async resume(runId: string): Promise<Awaited<ReturnType<typeof resumeRun>>> {
    if (this.active.has(runId)) {
      return { run_id: runId, status: this.currentStatus(runId), resumed: false };
    }
    const row = db().prepare(`SELECT project_path FROM runs WHERE id = ?`).get(runId) as
      | { project_path: string }
      | undefined;
    if (!row) {
      return { run_id: runId, status: this.currentStatus(runId), resumed: false };
    }

    const abortController = new AbortController();
    // Claim the slot synchronously (no await yet) — see docblock race-guard note.
    this.active.set(runId, {
      abortController,
      startedAt: Date.now(),
      projectPath: row.project_path,
      firedTripwires: new Set(),
    });

    const wasQueued = this.running >= this.max;
    if (wasQueued) {
      this.logger?.info({ runId }, "Run resume queued");
      this.serverBus.publish({ type: "run.queued", run_id: runId, data: { run_id: runId, resumed: true } });
    }
    await this.acquire();

    this.logger?.info({ runId }, "Run executing resume");

    const bus = new EventBus();
    bus.subscribe((ev) => this.forward(ev));
    const engine = this.makeEngine();

    try {
      // Resume reuses the existing live-run event contract: surface the
      // reopened transition as `run.status=running` before the resumed stage
      // loop / completion phases begin, mirroring the same event family the UI
      // already follows for in-flight runs.
      this.serverBus.publish({
        type: "run.status",
        run_id: runId,
        data: { run_id: runId, status: "running" satisfies RunStatus },
      });
      const result = await resumeRun({ runId, engine, bus, signal: abortController.signal });
      try {
        touchLastRun(row.project_path);
      } catch {
        /* unregistered project — best effort */
      }
      if (!result.resumed) {
        // `resumeRun()` can still refuse progress after the optimistic
        // pre-resume status publish (e.g. atomic DB claim lost to another
        // process, or project-lock reacquire failed and reverted to surfaced).
        // Publish the authoritative non-terminal status so live consumers do
        // not get stranded in `running` without a matching finalize.
        this.serverBus.publish({
          type: "run.status",
          run_id: runId,
          data: { run_id: runId, status: result.status },
        });
      }
      if (result.resumed) {
        this.serverBus.publish({
          type: "run.finalized",
          run_id: runId,
          data: { run_id: runId, status: result.status, finished_at: new Date().toISOString(), artifacts: getFinalizationArtifacts(runId) },
        });
      }
      this.logger?.info({ runId, status: result.status, resumed: result.resumed }, "Run resume finalized");
      return result;
    } catch (err) {
      this.logger?.error({ err, runId }, "Run crashed during resume");
      this.serverBus.publish({
        type: "run.finalized",
        run_id: runId,
        data: {
          run_id: runId,
          status: "crashed",
          finished_at: new Date().toISOString(),
          abort_reason: (err as Error)?.message ?? "resume failed",
        },
      });
      throw err;
    } finally {
      this.active.delete(runId);
      this.release();
    }
  }

  private currentStatus(runId: string): RunStatus {
    const row = db().prepare(`SELECT status FROM runs WHERE id = ?`).get(runId) as { status?: RunStatus } | undefined;
    return row?.status ?? "surfaced";
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

    const runLog = this.logger?.child({ run_id: ev.run_id });
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

    // context.warning — mirrors the budget-tripwire pattern: fire once per
    // attempt when context fill exceeds 75%. Graceful-degradation: emit only
    // when the completed frame carries both context_used_tokens and
    // context_max_tokens (absent when the model's window is unknown).
    const d = ev.data as {
      stage_id?: string;
      attempt_id?: string;
      context_pct?: number | null;
      context_used_tokens?: number | null;
      context_max_tokens?: number | null;
    };
    if (
      d.context_pct != null &&
      d.context_pct > 0.75 &&
      d.context_used_tokens != null &&
      d.context_max_tokens != null &&
      d.stage_id &&
      d.attempt_id
    ) {
      runLog?.warn(
        { stage_id: d.stage_id, attempt_id: d.attempt_id, context_pct: d.context_pct },
        "context.warning: attempt context fill > 75%",
      );
      this.serverBus.publish({
        type: "context.warning",
        run_id: ev.run_id,
        data: {
          stage_id: d.stage_id,
          attempt_id: d.attempt_id,
          context_pct: d.context_pct,
          context_used_tokens: d.context_used_tokens,
          context_max_tokens: d.context_max_tokens,
        },
      });
    }

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
        runLog?.warn({ scope: cap.scope, limit_usd: cap.limit_usd, cost_usd: cost, action: "block" }, "Budget hard cap crossed; aborting run");
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
        runLog?.warn({ scope: cap.scope, limit_usd: cap.limit_usd, cost_usd: cost, action: "downgrade" }, "Budget warning cap crossed; downgrading tier");
        this.serverBus.publish({
          type: "budget.tripwire",
          run_id: ev.run_id,
          data: { scope: cap.scope, pct: 80, limit_usd: cap.limit_usd, cost_usd: cost, action: "downgrade" },
        });
      }
    }
  }
}
