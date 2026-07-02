/**
 * Project registry (v8 / M5c). The harness otherwise keys everything off
 * `project_path`; the @pp/server control plane needs an explicit registry so
 * the UI can list/register/remove projects and show a display name. Run counts
 * and last-run timestamps are derived from the `runs` table.
 */
import { existsSync, statSync } from "node:fs";
import { basename } from "node:path";
import { nanoid } from "nanoid";
import { db } from "../db/database.js";
import { loadProjectProfile } from "./profiles.js";

export interface ProjectRow {
  id: string;
  name: string;
  path: string;
  created_at: string;
  last_run_at: string | null;
}

/** Wire shape consumed by the UI (mirrors shared/api-types Project). */
export interface ProjectDTO {
  path: string;
  name: string;
  last_run_at: string | null;
  run_count: number;
  profile: string | null;
}

export class ProjectDirNotFoundError extends Error {
  constructor(public readonly path: string) {
    super(`project path does not exist or is not a directory: ${path}`);
    this.name = "ProjectDirNotFoundError";
  }
}

const now = (): string => new Date().toISOString();

/** Register (or upsert the display name of) a project. Validates the dir exists. */
export function registerProject(input: { path: string; name?: string }): ProjectRow {
  const path = input.path;
  let isDir = false;
  try {
    isDir = existsSync(path) && statSync(path).isDirectory();
  } catch {
    isDir = false;
  }
  if (!isDir) throw new ProjectDirNotFoundError(path);

  const existing = db().prepare("SELECT * FROM projects WHERE path = ?").get(path) as ProjectRow | undefined;
  if (existing) {
    if (input.name && input.name !== existing.name) {
      db().prepare("UPDATE projects SET name = ? WHERE id = ?").run(input.name, existing.id);
      return { ...existing, name: input.name };
    }
    return existing;
  }
  const row: ProjectRow = {
    id: `proj_${nanoid(12)}`,
    name: input.name ?? (basename(path) || path),
    path,
    created_at: now(),
    last_run_at: null,
  };
  db()
    .prepare("INSERT INTO projects (id, name, path, created_at, last_run_at) VALUES (?, ?, ?, ?, ?)")
    .run(row.id, row.name, row.path, row.created_at, row.last_run_at);
  return row;
}

/** Remove a project from the registry. Returns true if a row was deleted. */
export function removeProject(path: string): boolean {
  const r = db().prepare("DELETE FROM projects WHERE path = ?").run(path);
  return r.changes > 0;
}

/** Bump last_run_at for a project (best-effort; no-op if unregistered). */
export function touchLastRun(path: string, at: string = now()): void {
  db().prepare("UPDATE projects SET last_run_at = ? WHERE path = ?").run(at, path);
}

function toDTO(row: ProjectRow): ProjectDTO {
  const stats = db()
    .prepare("SELECT COUNT(*) AS n, MAX(started_at) AS last FROM runs WHERE project_path = ?")
    .get(row.path) as { n: number; last: string | null };
  let profile: string | null = null;
  try {
    profile = loadProjectProfile(row.path)?.name ?? null;
  } catch {
    profile = null;
  }
  return {
    path: row.path,
    name: row.name,
    last_run_at: row.last_run_at ?? stats.last ?? null,
    run_count: stats.n ?? 0,
    profile,
  };
}

export function listProjects(): ProjectDTO[] {
  const rows = db().prepare("SELECT * FROM projects ORDER BY name COLLATE NOCASE").all() as ProjectRow[];
  return rows.map(toDTO);
}

export function getProject(path: string): ProjectDTO | null {
  const row = db().prepare("SELECT * FROM projects WHERE path = ?").get(path) as ProjectRow | undefined;
  return row ? toDTO(row) : null;
}
