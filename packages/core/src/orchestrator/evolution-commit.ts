/**
 * evolution-commit — local commit/rollback for approved autogenesis proposals.
 *
 * The autogenesis-analyzer only *detects* recurring drift and writes
 * `evolution_proposals` rows (no patch content). This module closes the loop
 * locally: an operator reviews a proposal, authors the actual override
 * content, and commits it to the project-scoped override location for the
 * proposal's resource kind:
 *
 *   resource:pp.rubric.<id>            → <project>/.claude/rubrics/<bareId>.md
 *                                        (loadRubric's project-override path)
 *   resource:pp.stage-prompt.<kind>    → <project>/.claude/agents/<role>.md
 *                                        (pilot loadRolePrompt's project layer;
 *                                        role = most recent attempts.agent_type
 *                                        for that stage kind, else a static map)
 *   resource:pp.missability.<check_id> → <project>/.harness/missability-overrides.json
 *                                        (read by runMissabilityChecks)
 *
 * Design invariants:
 *   - **Approved-only.** commitProposal refuses any status but `approved`;
 *     rollbackProposal refuses any status but `committed`. Typed errors let
 *     the server map wrong-status to 409 without string matching.
 *   - **Path-guarded.** The resolved target must live inside
 *     `<project>/.claude/` or `<project>/.harness/` — a proposal can never
 *     write outside the project's override roots (`..` in a rid component
 *     fails the prefix check after path.resolve).
 *   - **Reversible.** The pre-commit target is snapshotted to
 *     `<project>/.harness/evolution/<proposal_id>/before/<basename>`;
 *     rollback restores the snapshot (or deletes the target when it did not
 *     exist before the commit, i.e. sha_before is NULL).
 *   - **Audited.** Every commit inserts an `evolution_commits` row
 *     (target/snapshot paths + before/after SHAs); rollback stamps
 *     rolled_back_at on that row. Rows persist for replay.
 *   - **Best-effort eights mirror.** When the proposal was echoed by
 *     TheEights at propose time (eights_proposal_id), the commit/rollback is
 *     mirrored fire-and-forget, exactly like the analyzer's propose — a dead
 *     daemon never blocks the local write.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { nanoid } from "nanoid";
import { db } from "../db/database.js";
import { envelopeFor, evolution } from "./../ecosystem/eights-client.js";

const NOW = () => new Date().toISOString();
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Proposal id does not exist. Server maps this to 404. */
export class ProposalNotFoundError extends Error {
  constructor(id: string) {
    super(`evolution proposal ${id} not found`);
    this.name = "ProposalNotFoundError";
  }
}

/** Proposal is not in the status the operation requires. Server maps to 409. */
export class ProposalStatusError extends Error {
  constructor(id: string, required: string, actual: string) {
    super(`evolution proposal ${id} must be '${required}' (currently '${actual}')`);
    this.name = "ProposalStatusError";
  }
}

/** commitProposal called without override content. Server maps to 422. */
export class CommitContentRequiredError extends Error {
  constructor(id: string) {
    super(
      `evolution proposal ${id}: commit requires 'content' — the analyzer detects drift but authors no patch; ` +
      `the reviewer supplies the override body to write`,
    );
    this.name = "CommitContentRequiredError";
  }
}

/** Unresolvable resource_rid OR a target escaping the override roots. Server maps to 409. */
export class EvolutionTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvolutionTargetError";
  }
}

export type EvolutionTargetKind = "rubric" | "stage-prompt" | "missability";

export type ResolvedEvolutionTarget = {
  kind: EvolutionTargetKind;
  /** Absolute path, guaranteed inside <project>/.claude/ or <project>/.harness/. */
  target_path: string;
};

/**
 * Static stage-kind → generator-role map, used when the project has no
 * recorded attempt for the stage kind (fresh project, or the drift predates
 * agent_type provenance). Mirrors the default single-mode + team pipelines.
 */
const STAGE_ROLE_FALLBACK: Record<string, string> = {
  spec: "spec-author",
  code: "engineer",
  tests: "test-strategist",
  docs: "docs-author",
  architecture: "architect",
  contracts: "api-designer",
};

/** Most recent generator role that ran this stage kind in the project, else the static map. */
function roleForStageKind(stage_kind: string, project_path: string): string {
  const row = db()
    .prepare(
      `SELECT att.agent_type AS agent_type
         FROM attempts att
         JOIN stages s ON s.id = att.stage_id
         JOIN runs   r ON r.id = s.run_id
        WHERE r.project_path = ? AND s.kind = ? AND att.agent_type IS NOT NULL
        ORDER BY att.created_at DESC, att.rowid DESC
        LIMIT 1`,
    )
    .get(project_path, stage_kind) as { agent_type: string } | undefined;
  return row?.agent_type ?? STAGE_ROLE_FALLBACK[stage_kind] ?? stage_kind;
}

/** Throws EvolutionTargetError unless abs is inside <project>/.claude/ or <project>/.harness/. */
function assertInsideOverrideRoots(abs: string, project_path: string): void {
  const roots = [resolve(project_path, ".claude"), resolve(project_path, ".harness")];
  const inside = roots.some(root => abs === root || abs.startsWith(root + sep));
  if (!inside) {
    throw new EvolutionTargetError(
      `evolution commit target escapes the project override roots (.claude/, .harness/): ${abs}`,
    );
  }
}

/**
 * Resolve a proposal's resource_rid to its project-scoped override file.
 * Exposed for tests / the review UI (shows the target before committing).
 */
export function resolveProposalTarget(resource_rid: string, project_path: string): ResolvedEvolutionTarget {
  let kind: EvolutionTargetKind;
  let rel: string;
  if (resource_rid.startsWith("resource:pp.rubric.")) {
    kind = "rubric";
    // Same bare-id normalization as rubrics/loader.ts (strip a @version suffix).
    const bareId = resource_rid.slice("resource:pp.rubric.".length).replace(/@.*$/, "");
    rel = join(".claude", "rubrics", `${bareId}.md`);
  } else if (resource_rid.startsWith("resource:pp.stage-prompt.")) {
    kind = "stage-prompt";
    const stageKind = resource_rid.slice("resource:pp.stage-prompt.".length);
    rel = join(".claude", "agents", `${roleForStageKind(stageKind, project_path)}.md`);
  } else if (resource_rid.startsWith("resource:pp.missability.")) {
    kind = "missability";
    rel = join(".harness", "missability-overrides.json");
  } else {
    throw new EvolutionTargetError(`evolution proposal has an unrecognized resource_rid: ${resource_rid}`);
  }
  const target_path = resolve(project_path, rel);
  assertInsideOverrideRoots(target_path, project_path);
  return { kind, target_path };
}

type ProposalRow = {
  id: string;
  run_id: string;
  resource_rid: string;
  status: string;
  eights_proposal_id: string | null;
  project_path: string;
};

function getProposalWithProject(id: string): ProposalRow {
  const row = db()
    .prepare(
      `SELECT ep.id, ep.run_id, ep.resource_rid, ep.status, ep.eights_proposal_id, r.project_path
         FROM evolution_proposals ep
         JOIN runs r ON r.id = ep.run_id
        WHERE ep.id = ?`,
    )
    .get(id) as ProposalRow | undefined;
  if (!row) throw new ProposalNotFoundError(id);
  return row;
}

export type CommitProposalResult = {
  id: string;
  status: "committed";
  commit_id: string;
  kind: EvolutionTargetKind;
  target_path: string;
  snapshot_path: string | null;
  sha_before: string | null;
  sha_after: string;
};

/**
 * Commit an APPROVED proposal: write the reviewer-authored `content` to the
 * resource's project-override target, snapshotting whatever was there first.
 */
export function commitProposal(input: { id: string; content?: string; note?: string }): CommitProposalResult {
  const row = getProposalWithProject(input.id);
  if (row.status !== "approved") throw new ProposalStatusError(input.id, "approved", row.status);
  if (typeof input.content !== "string" || input.content.length === 0) {
    throw new CommitContentRequiredError(input.id);
  }

  const target = resolveProposalTarget(row.resource_rid, row.project_path);

  // Snapshot the pre-commit target (when one exists) so rollback can restore it.
  let sha_before: string | null = null;
  let snapshot_path: string | null = null;
  if (existsSync(target.target_path)) {
    const prior = readFileSync(target.target_path, "utf8");
    sha_before = sha256(prior);
    const snapDir = join(row.project_path, ".harness", "evolution", input.id, "before");
    mkdirSync(snapDir, { recursive: true });
    snapshot_path = join(snapDir, basename(target.target_path));
    writeFileSync(snapshot_path, prior, "utf8");
  }

  mkdirSync(dirname(target.target_path), { recursive: true });
  writeFileSync(target.target_path, input.content, "utf8");
  const sha_after = sha256(input.content);

  const commit_id = `evc_${nanoid(10)}`;
  db()
    .prepare(
      `INSERT INTO evolution_commits
         (id, proposal_id, target_path, snapshot_path, sha_before, sha_after, note, committed_at, rolled_back_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .run(commit_id, input.id, target.target_path, snapshot_path, sha_before, sha_after, input.note ?? null, NOW());
  db()
    .prepare(`UPDATE evolution_proposals SET status = 'committed' WHERE id = ? AND status = 'approved'`)
    .run(input.id);

  // Best-effort eights mirror (fire-and-forget, same pattern as the analyzer's
  // propose): only when TheEights echoed a proposal id at propose time.
  if (row.eights_proposal_id) {
    try {
      const env = envelopeFor({ run_id: row.run_id, project_path: row.project_path });
      void evolution.commit(env, row.eights_proposal_id);
    } catch { /* ignore */ }
  }

  return {
    id: input.id,
    status: "committed",
    commit_id,
    kind: target.kind,
    target_path: target.target_path,
    snapshot_path,
    sha_before,
    sha_after,
  };
}

export type RollbackProposalResult = {
  id: string;
  status: "rolled_back";
  commit_id: string;
  target_path: string;
  snapshot_path: string | null;
  /** true = snapshot restored; false = target deleted (did not exist pre-commit). */
  restored: boolean;
};

/**
 * Roll back a COMMITTED proposal: restore the pre-commit snapshot, or delete
 * the target when the commit created it (sha_before NULL).
 */
export function rollbackProposal(input: { id: string }): RollbackProposalResult {
  const row = getProposalWithProject(input.id);
  if (row.status !== "committed") throw new ProposalStatusError(input.id, "committed", row.status);

  const commit = db()
    .prepare(
      `SELECT id, target_path, snapshot_path, sha_before
         FROM evolution_commits
        WHERE proposal_id = ? AND rolled_back_at IS NULL
        ORDER BY committed_at DESC, rowid DESC
        LIMIT 1`,
    )
    .get(input.id) as
    | { id: string; target_path: string; snapshot_path: string | null; sha_before: string | null }
    | undefined;
  if (!commit) {
    // Status says committed but no live commit row — corrupt state; refuse.
    throw new ProposalStatusError(input.id, "committed", "committed-without-commit-row");
  }

  // Defense-in-depth: re-guard the persisted path before touching disk.
  const target_path = resolve(commit.target_path);
  assertInsideOverrideRoots(target_path, row.project_path);

  let restored: boolean;
  if (commit.sha_before === null) {
    // The commit created the target — rollback deletes it.
    try { unlinkSync(target_path); } catch { /* already gone */ }
    restored = false;
  } else {
    if (!commit.snapshot_path || !existsSync(commit.snapshot_path)) {
      throw new EvolutionTargetError(
        `evolution rollback for ${input.id}: snapshot missing at ${commit.snapshot_path ?? "(null)"}`,
      );
    }
    mkdirSync(dirname(target_path), { recursive: true });
    writeFileSync(target_path, readFileSync(commit.snapshot_path, "utf8"), "utf8");
    restored = true;
  }

  db().prepare(`UPDATE evolution_commits SET rolled_back_at = ? WHERE id = ?`).run(NOW(), commit.id);
  db()
    .prepare(`UPDATE evolution_proposals SET status = 'rolled_back' WHERE id = ? AND status = 'committed'`)
    .run(input.id);

  if (row.eights_proposal_id) {
    try {
      const env = envelopeFor({ run_id: row.run_id, project_path: row.project_path });
      void evolution.rollback(env, row.eights_proposal_id);
    } catch { /* ignore */ }
  }

  return {
    id: input.id,
    status: "rolled_back",
    commit_id: commit.id,
    target_path,
    snapshot_path: commit.snapshot_path,
    restored,
  };
}
