/**
 * Project routes: registry CRUD, project detail (with managed-doc status),
 * managed-document content (master-plan / agents-md / constitution), and
 * per-project profile read/write + detect.
 *
 * Contract deltas (flagged for ui-foundation — NOT yet in apiPaths):
 *   PUT/GET /projects/:path/profile, POST /profiles/detect,
 *   POST/DELETE /projects (create/remove).
 */
import type { FastifyInstance } from "fastify";
import { existsSync, readFileSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import {
  listProjects, getProject, registerProject, removeProject, ProjectDirNotFoundError,
  loadProjectProfile, writeProjectProfile, detectProfile,
  readConstitution, agentsMdStatus, masterPlanStatus, listRuns,
  BUILTIN_PROFILE_NAMES, type ProfileName,
} from "@pp/core";
import { V1 } from "../deps.js";

interface DocContent { path: string; markdown: string; sha: string; updated_at: string }
interface DocStatus { present: boolean; sha: string | null; updated_at: string | null; sections: number | null }

function readDoc(absPath: string): DocContent | null {
  if (!existsSync(absPath)) return null;
  const markdown = readFileSync(absPath, "utf8");
  return {
    path: absPath,
    markdown,
    sha: createHash("sha256").update(markdown).digest("hex"),
    updated_at: statSync(absPath).mtime.toISOString(),
  };
}

function docStatus(absPath: string, sections: number | null): DocStatus {
  const d = readDoc(absPath);
  return d
    ? { present: true, sha: d.sha, updated_at: d.updated_at, sections }
    : { present: false, sha: null, updated_at: null, sections: null };
}

const masterPlanFile = (projectPath: string) => join(projectPath, "PROJECT_MASTER.md");
const agentsMdFile = (projectPath: string) => join(projectPath, "AGENTS.md");
const constitutionFile = (projectPath: string) => join(projectPath, "CONSTITUTION.md");
const profileFile = (projectPath: string) => join(projectPath, ".harness", "profile.yaml");

function projectProfileDocument(projectPath: string) {
  const path = profileFile(projectPath);
  if (!existsSync(path)) return null;
  const yaml = readFileSync(path, "utf8");
  const resolved = loadProjectProfile(projectPath);
  if (!resolved) return null;
  return { path, yaml, resolved };
}

export function registerProjectRoutes(app: FastifyInstance): void {
  // ── CRUD ──
  app.get(`${V1}/projects`, async () => listProjects());

  app.post(`${V1}/projects`, async (req, reply) => {
    const body = (req.body ?? {}) as { path?: string; project_path?: string; name?: string };
    const path = body.path ?? body.project_path;
    if (!path) return reply.code(422).send({ error: "validation failed", details: { path: "required" } });
    try {
      const row = registerProject({ path, name: body.name });
      return reply.code(201).send(getProject(row.path) ?? row);
    } catch (err) {
      if (err instanceof ProjectDirNotFoundError) {
        return reply.code(422).send({ error: "validation failed", details: { path: err.message } });
      }
      throw err;
    }
  });

  app.delete(`${V1}/projects/:path`, async (req) => {
    const { path } = req.params as { path: string };
    return { removed: removeProject(path), path };
  });

  // ── Managed-document content ──
  app.get(`${V1}/projects/:path/master-plan`, async (req, reply) => {
    const { path } = req.params as { path: string };
    const doc = readDoc(masterPlanFile(path));
    return doc ?? reply.code(404).send({ error: "PROJECT_MASTER.md not present" });
  });
  app.get(`${V1}/projects/:path/agents-md`, async (req, reply) => {
    const { path } = req.params as { path: string };
    const doc = readDoc(agentsMdFile(path));
    return doc ?? reply.code(404).send({ error: "AGENTS.md not present" });
  });
  app.get(`${V1}/projects/:path/constitution`, async (req, reply) => {
    const { path } = req.params as { path: string };
    const c = readConstitution(path);
    if (!c) return reply.code(404).send({ error: "CONSTITUTION.md not present" });
    return { path: c.path, markdown: c.body, sha: c.sha, updated_at: existsSync(c.path) ? statSync(c.path).mtime.toISOString() : new Date().toISOString() };
  });

  // ── Profile read/write (DELTA) ──
  app.get(`${V1}/projects/:path/profile`, async (req) => {
    const { path } = req.params as { path: string };
    return projectProfileDocument(path);
  });
  app.put(`${V1}/projects/:path/profile`, async (req, reply) => {
    const { path } = req.params as { path: string };
    const body = (req.body ?? {}) as { name?: string; yaml?: string };

    // Apply a built-in profile by name.
    if (body.name) {
      if (!(BUILTIN_PROFILE_NAMES as readonly string[]).includes(body.name)) {
        return reply.code(422).send({ error: "validation failed", details: { name: `unknown profile "${body.name}"` } });
      }
      return writeProjectProfile(path, body.name as ProfileName, { source: "user-selected" });
    }

    // Write a raw profile.yaml after validating it parses to an object with a name.
    if (typeof body.yaml === "string") {
      let parsed: unknown;
      try {
        parsed = parseYaml(body.yaml);
      } catch (err) {
        return reply.code(422).send({ error: "validation failed", details: { yaml: (err as Error).message } });
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof (parsed as { name?: unknown }).name !== "string") {
        return reply.code(422).send({ error: "validation failed", details: { yaml: "profile must be a mapping with a string `name`" } });
      }
      const dest = profileFile(path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, body.yaml, "utf8");
      return { path: dest, yaml: body.yaml };
    }

    return reply.code(422).send({ error: "validation failed", details: { body: "provide `name` (built-in) or `yaml` (raw profile)" } });
  });

  // ── Profile detect (DELTA) ──
  app.post(`${V1}/profiles/detect`, async (req, reply) => {
    const body = (req.body ?? {}) as { project_path?: string; request_text?: string };
    if (!body.project_path) return reply.code(422).send({ error: "validation failed", details: { project_path: "required" } });
    return detectProfile(body.project_path, { requestText: body.request_text });
  });

  // ── Project detail (bare :path LAST so sub-resources match first) ──
  app.get(`${V1}/projects/:path`, async (req, reply) => {
    const { path } = req.params as { path: string };
    const base = getProject(path);
    if (!base) return reply.code(404).send({ error: `project ${path} not found` });

    const mpStatus = safe(() => masterPlanStatus(path)) as { sections?: unknown[] } | null;
    const amStatus = safe(() => agentsMdStatus(path)) as { agents_md?: { sections?: unknown[] } } | null;
    const c = safe(() => readConstitution(path)) as { sha: string } | null;

    const recent = listRuns({ project_path: path, limit: 10 }).items;

    return {
      ...base,
      active_profile: base.profile,
      constitution: c
        ? { present: true, sha: c.sha, updated_at: statSync(constitutionFile(path)).mtime.toISOString(), sections: null }
        : { present: false, sha: null, updated_at: null, sections: null },
      agents_md: docStatus(agentsMdFile(path), amStatus?.agents_md?.sections?.length ?? null),
      master_plan: docStatus(masterPlanFile(path), mpStatus?.sections?.length ?? null),
      recent_runs: recent,
    };
  });
}

function safe<T>(fn: () => T): T | null {
  try {
    return fn();
  } catch {
    return null;
  }
}
