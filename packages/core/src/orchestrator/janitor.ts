/**
 * Startup janitor: marks orphaned `running` runs as `crashed`, sweeps
 * stale candidate worktrees, removes orphan project locks, and surfaces
 * them on the next /pp:status. Idempotent — safe to call on every daemon
 * start and via /pp:doctor.
 *
 * Two-phase: the full sweep plan (entries with byte/age accounting) is
 * computed first; `dry_run: true` returns that plan without touching
 * anything, while a real run executes it and persists the report under
 * the `janitor:last_report` platform setting.
 */

import { execFileSync } from "node:child_process";
import { rmSync, existsSync, statSync, lstatSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { db, txImmediate } from "../db/database.js";
import { projectLockPath } from "../util/paths.js";
import { readLockMetadata, isPidAlive } from "../util/lock.js";
import { getPlatformSetting, setPlatformSetting } from "./settings.js";
import { log } from "../util/logger.js";

const STALE_RUN_HOURS = 6;
const STALE_LOCK_HOURS = 6;
/** Events older than this many days are purged on each janitor pass (dry-run reports count, not deletes). */
const EVENT_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const JANITOR_REPORT_KEY = "janitor:last_report";

/** One planned (or executed) sweep target. */
export interface JanitorEntry {
  path: string;
  kind: "worktree" | "branch" | "lock" | "run";
  bytes: number;
  age_days: number;
}

/** Result of a janitor pass — mirrors shared/api-types JanitorReport. */
export interface JanitorReport {
  ran_at: string;
  dry_run: boolean;
  crashed_runs: string[];
  entries: JanitorEntry[];
  swept: number;
  reclaimed_bytes: number;
}

/** A plan item pairs the reportable entry with its (deferred) sweep action. */
type PlanItem = {
  entry: JanitorEntry;
  sweep: () => boolean;
};

/**
 * Run the janitor sweep.
 *
 * Options:
 *   `dry_run`  — plan the sweep but do not mutate anything (default: false).
 *   `deep`     — when true, compute on-disk byte sizes for each worktree entry
 *                via a full recursive directory walk (may be slow on large trees).
 *                When false (the default, "quick mode"), the directory-size walk
 *                is skipped entirely and worktree entries report `bytes: 0`.
 *                All other sweep actions (stale-run crash-sweep, worktree prune,
 *                lock sweep, event purge) run identically in both modes.
 */
export function runJanitor(opts?: { dry_run?: boolean; deep?: boolean }): JanitorReport {
  const dryRun = opts?.dry_run === true;
  const deep = opts?.deep === true;
  const now = Date.now();
  const cutoff = new Date(now - STALE_RUN_HOURS * 60 * 60 * 1000).toISOString();

  // ── Phase 1: compute the full sweep plan without mutating anything. ──

  // 1. Stale `running`/`pending` rows that would be marked `crashed`.
  const stale = db()
    .prepare(`SELECT id, started_at FROM runs WHERE status IN ('running', 'pending') AND started_at < ?`)
    .all(cutoff) as Array<{ id: string; started_at: string }>;
  const staleRunIds = stale.map((r) => r.id);
  const runEntries: JanitorEntry[] = stale.map((r) => ({
    path: r.id,
    kind: "run",
    bytes: 0,
    age_days: ageDays(now - Date.parse(r.started_at)),
  }));

  const plan: PlanItem[] = [];
  // Projects whose worktree registry references missing paths — pruned on a
  // real run only (git worktree prune mutates .git, so never in dry_run).
  const pruneProjects = new Set<string>();

  const projects = db()
    .prepare(
      // Include every project that has *any* row, not just finished runs —
      // a project whose only run is currently `crashed` should still get
      // its stale lock cleaned up.
      `SELECT DISTINCT project_path FROM runs`,
    )
    .all() as Array<{ project_path: string }>;

  for (const { project_path } of projects) {
    // Worktree + branch plan
    try {
      const stdout = execFileGit(["worktree", "list", "--porcelain"], project_path);
      const wtBlocks = stdout.split(/\n\n/);
      for (const block of wtBlocks) {
        const wtMatch = /^worktree\s+(\S.+)/m.exec(block);
        const branchMatch = /^branch\s+refs\/heads\/(pp\/[\w./-]+)/m.exec(block);
        if (!wtMatch || !branchMatch) continue;
        const wtPath = wtMatch[1]!;
        const branch = branchMatch[1]!;
        if (!existsSync(wtPath)) {
          pruneProjects.add(project_path);
          continue;
        }
        const stat = statSync(wtPath);
        const ageMs = now - stat.mtime.getTime();
        if (ageMs > STALE_RUN_HOURS * 60 * 60 * 1000) {
          plan.push({
            entry: { path: wtPath, kind: "worktree", bytes: deep ? dirSizeBytes(wtPath) : 0, age_days: ageDays(ageMs) },
            sweep: () => {
              try {
                execFileSync("git", ["worktree", "remove", "--force", wtPath], {
                  cwd: project_path, encoding: "utf8", windowsHide: true,
                });
                return true;
              } catch (err) {
                log.warn({ err, wtPath }, "worktree remove failed during sweep");
                try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* ignore */ }
                return !existsSync(wtPath);
              }
            },
          });
          plan.push({
            entry: { path: branch, kind: "branch", bytes: 0, age_days: ageDays(ageMs) },
            sweep: () => {
              try {
                execFileSync("git", ["branch", "-D", branch], {
                  cwd: project_path, encoding: "utf8", windowsHide: true,
                });
                return true;
              } catch { /* branch may already be gone */ return false; }
            },
          });
        }
      }
    } catch { /* not a git project or other error */ }

    // Project-lock plan — sweep `<project>/.harness/.lock` if older than
    // STALE_LOCK_HOURS. The lock file is created at start_run via
    // ProjectLock.acquire() and deleted at finalize_run via release().
    // A leftover lock means the daemon crashed mid-run.
    try {
      const lockPath = projectLockPath(project_path);
      if (existsSync(lockPath)) {
        const stat = statSync(lockPath);
        const ageMs = now - stat.mtime.getTime();
        const meta = readLockMetadata(lockPath);
        const deadPid = meta && !isPidAlive(meta.pid);
        const ageExceeded = ageMs > STALE_LOCK_HOURS * 60 * 60 * 1000;
        if (deadPid || ageExceeded) {
          plan.push({
            entry: { path: lockPath, kind: "lock", bytes: stat.size, age_days: ageDays(ageMs) },
            sweep: () => {
              try {
                rmSync(lockPath, { force: true });
                log.info(
                  { lockPath, reason: deadPid ? `dead_pid=${meta!.pid}` : `age=${Math.round(ageMs / 1000)}s` },
                  "janitor removed stale project lock",
                );
                return true;
              } catch (err) {
                log.warn({ err, lockPath }, "stale lock removal failed");
                return false;
              }
            },
          });
        }
      }
    } catch { /* ignore */ }
  }

  const entries: JanitorEntry[] = [...runEntries, ...plan.map((p) => p.entry)];

  // ── Event retention: count rows older than EVENT_RETENTION_DAYS. ──
  const retentionCutoff = new Date(now - EVENT_RETENTION_DAYS * DAY_MS).toISOString();
  const { "COUNT(*)": expiredEventCount } = db()
    .prepare("SELECT COUNT(*) FROM events WHERE ts < ?")
    .get(retentionCutoff) as { "COUNT(*)": number };
  if (expiredEventCount > 0) {
    entries.push({
      path: `events:<${retentionCutoff}`,
      kind: "run",
      bytes: expiredEventCount * 256, // rough estimate: ~256 bytes per event row
      age_days: EVENT_RETENTION_DAYS,
    });
  }

  const ran_at = new Date().toISOString();

  if (dryRun) {
    return { ran_at, dry_run: true, crashed_runs: staleRunIds, entries, swept: 0, reclaimed_bytes: 0 };
  }

  // ── Phase 2: execute the plan. ──

  let swept = 0;
  let reclaimed_bytes = 0;

  const crashed: string[] = [];
  if (stale.length) {
    txImmediate(() => {
      const stmt = db().prepare(`UPDATE runs SET status = 'crashed', finished_at = ? WHERE id = ?`);
      const finished = new Date().toISOString();
      for (const r of stale) {
        stmt.run(finished, r.id);
        crashed.push(r.id);
      }
    });
    swept += crashed.length;
    log.info({ count: crashed.length }, "janitor marked stale runs as crashed");
  }

  for (const project_path of pruneProjects) {
    execFileGit(["worktree", "prune"], project_path);
  }

  for (const item of plan) {
    if (item.sweep()) {
      swept += 1;
      reclaimed_bytes += item.entry.bytes;
    }
  }

  // ── Purge expired events. ──
  if (expiredEventCount > 0) {
    const { changes } = db()
      .prepare("DELETE FROM events WHERE ts < ?")
      .run(retentionCutoff);
    if (changes > 0) {
      swept += 1;
      reclaimed_bytes += changes * 256;
      log.info({ deleted: changes, cutoff: retentionCutoff }, "janitor purged expired events");
    }
  }

  const report: JanitorReport = { ran_at, dry_run: false, crashed_runs: crashed, entries, swept, reclaimed_bytes };
  try {
    setPlatformSetting(JANITOR_REPORT_KEY, report);
  } catch (err) {
    log.warn({ err }, "janitor report persistence failed");
  }
  return report;
}

/** Last persisted (non-dry-run) janitor report, or null if none has run yet. */
export function getJanitorReport(): JanitorReport | null {
  return getPlatformSetting<JanitorReport>(JANITOR_REPORT_KEY);
}

/**
 * Recursive on-disk size of a directory (or file). Best-effort: unreadable
 * entries are skipped, and the walk bails out after `maxEntries` filesystem
 * entries so a pathological tree can't stall the janitor.
 */
export function dirSizeBytes(path: string, maxEntries = 50_000): number {
  let total = 0;
  let seen = 0;
  const stack: string[] = [path];
  while (stack.length) {
    const current = stack.pop()!;
    if (++seen > maxEntries) break;
    try {
      const stat = lstatSync(current);
      if (stat.isDirectory()) {
        for (const name of readdirSync(current)) stack.push(join(current, name));
      } else if (stat.isFile()) {
        total += stat.size;
      }
    } catch { /* skip unreadable entries */ }
  }
  return total;
}

function ageDays(ageMs: number): number {
  if (!Number.isFinite(ageMs) || ageMs < 0) return 0;
  return Math.round((ageMs / DAY_MS) * 10) / 10;
}

/** Synchronous git helper. Returns stdout (empty string on non-zero exit). */
function execFileGit(args: string[], cwd: string): string {
  try {
    const out = execFileSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
    return out.toString();
  } catch {
    return "";
  }
}
