/**
 * agent_sessions recording (schema v8).
 *
 * Every engine coding/authoring session that produces a session file
 * (`<role>-<attempt>.jsonl`) is recorded here so a run can be replayed and
 * audited: which role, provider, and model produced each attempt, and where the
 * verbatim session transcript lives. `agentSessionReplayRecords` adds a sha256
 * of each transcript so the replay bundle can prove the sessions were not
 * altered after the fact.
 *
 * Additive over the existing `agent_sessions` table — no schema migration.
 */

import { nanoid } from "nanoid";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { db, txImmediate } from "../db/database.js";

const now = () => new Date().toISOString();

export type RecordAgentSessionInput = {
  run_id: string;
  attempt_id?: string;
  role: string;
  provider: string;
  model_id: string;
  session_file: string;
};

export type AgentSessionRow = {
  id: string;
  run_id: string;
  attempt_id: string | null;
  role: string;
  provider: string;
  model_id: string;
  session_file: string;
  created_at: string;
};

/** Persist one engine session. No-op-safe: requires a non-empty session_file. */
export function recordAgentSession(input: RecordAgentSessionInput): { id: string } {
  if (!input.session_file) {
    throw new Error("recordAgentSession requires a non-empty session_file");
  }
  const id = `agsess_${nanoid(10)}`;
  txImmediate(() => {
    db()
      .prepare(
        `INSERT INTO agent_sessions(id, run_id, attempt_id, role, provider, model_id, session_file, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.run_id,
        input.attempt_id ?? null,
        input.role,
        input.provider,
        input.model_id,
        input.session_file,
        now(),
      );
  });
  return { id };
}

export function listAgentSessions(run_id: string): AgentSessionRow[] {
  return db()
    .prepare(
      `SELECT id, run_id, attempt_id, role, provider, model_id, session_file, created_at
         FROM agent_sessions WHERE run_id = ? ORDER BY created_at ASC`,
    )
    .all(run_id) as AgentSessionRow[];
}

export type AgentSessionReplayRecord = {
  role: string;
  provider: string;
  model_id: string;
  session_file: string;
  /** sha256 of the transcript on disk, or null when the file is gone. */
  sha256: string | null;
};

/** Replay-pinning records: each session's provenance + a transcript hash. */
export function agentSessionReplayRecords(run_id: string): AgentSessionReplayRecord[] {
  return listAgentSessions(run_id).map((s) => {
    let sha256: string | null = null;
    try {
      if (existsSync(s.session_file)) {
        sha256 = createHash("sha256").update(readFileSync(s.session_file)).digest("hex");
      }
    } catch {
      sha256 = null;
    }
    return { role: s.role, provider: s.provider, model_id: s.model_id, session_file: s.session_file, sha256 };
  });
}
