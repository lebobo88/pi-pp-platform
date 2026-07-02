/**
 * Resurrects the core of the deferred artifact-validators smoke
 * (packages/core/test/_deferred/artifact-validators.smoke.mjs) against the
 * MCP adapter: the adr_structure_lint validator works fully end-to-end, and
 * the finalize_stage validator gate refuses 'passed' on a violation.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAdapter, callTool, type Adapter } from "./mcp-client.js";

let adapter: Adapter;

beforeAll(async () => {
  adapter = await startAdapter();
});

afterAll(async () => {
  await adapter?.close();
});

// Known-good ADR (verbatim from the deferred artifact-validators smoke).
const VALID_ADR = `# ADR-0042: Adopt SQLite for local harness state

## Status

Accepted on 2026-05-09. Supersedes ADR-0033 which proposed RocksDB; that path
was abandoned after the on-disk corruption incident in late April.

## Context

The pair-programmer harness needs a local store for run / stage / attempt /
verdict / artifact rows. We considered three options. The store is single-writer
(one daemon process), embedded, and the access pattern is tiny ad-hoc queries
mixed with bulk artifact metadata writes. Operational simplicity matters more
than raw throughput at the scale we expect (thousands of rows per project, not
millions). We also need easy backup — a single file the user can zip.

## Decision

We will use SQLite in WAL mode with foreign keys enabled and a busy timeout
of five seconds. The daemon owns the only writer connection; the
\`better-sqlite3\` binding gives us synchronous access without a separate
process. Migrations are applied at boot via additive ALTER-TABLE statements.

## Consequences

Pros: zero ops, single-file backup, durable WAL semantics, fast on dev
laptops. Single-writer model trivially serializes the orchestrator. Cons:
no cross-host replication; future multi-daemon deployment would require
re-architecture or a Postgres swap. Schema migrations are append-only.

## Alternatives considered

We rejected RocksDB after the corruption event. We rejected Postgres on
ergonomic grounds: an embedded daemon should not require a separate
service. We rejected DuckDB because the workload is not analytical.

## References

- https://www.sqlite.org/wal.html
- ADR-0033 (RocksDB experiment, retired)
`;

const BAD_ADR_NO_DECISION = `# ADR-0099: Some change with missing structure

## Status

Proposed.

## Context

We need to do something.

## Consequences

Some consequences will follow.

## References

- nothing important
`;

async function seedStage(kind: string, gate: string) {
  // Fresh project dir per stage so the per-project advisory lock never contends.
  const projectPath = mkdtempSync(join(tmpdir(), "pp-mcp-av-"));
  const run = await callTool<{ run_id: string }>(adapter.client, "start_run", {
    request_text: "av test", project_path: projectPath, mode: "single",
  });
  const stage = await callTool<{ stage_id: string }>(adapter.client, "start_stage", {
    run_id: run.run_id, kind, gate_type: gate,
  });
  const att = await callTool<{ attempt_id: string }>(adapter.client, "record_attempt", {
    stage_id: stage.stage_id, producer: "claude", model_id: "claude-opus-4-7",
    tokens_in: 1, tokens_out: 1, cost_usd: 0.0001, status: "ok",
  });
  return { run, stage, att };
}

describe("artifact_validate — adr_structure_lint (full)", () => {
  it("verifies a well-formed ADR and allows finalize_stage(passed)", async () => {
    const { run, stage, att } = await seedStage("architecture", "design");
    await callTool(adapter.client, "archive_artifact", {
      run_id: run.run_id, stage_id: stage.stage_id, taxonomy_section: "4.6", kind: "adr",
      relative_path: "architecture/adr-0042-sqlite.md", bytes: VALID_ADR,
    });
    await callTool(adapter.client, "record_verdict", {
      attempt_id: att.attempt_id, judge_producer: "claude", judge_model_id: "claude-sonnet-4-6",
      outcome: "pass",
      critique_md: "Smoke verdict: ADR structure looks reasonable; the structural check is delegated to the validator gate. This critique exists to satisfy the anti-vacuous-pass refine.",
      score_json: { structure: 0.9, decision_clarity: 0.85 },
    });

    const v = await callTool<{ status: string }>(adapter.client, "artifact_validate", {
      stage_id: stage.stage_id, kind: "adr_structure_lint",
    });
    expect(v.status).toBe("verified");

    const got = await callTool<{ check: { status: string } | null }>(adapter.client, "get_artifact_validation", {
      stage_id: stage.stage_id, validator_kind: "adr_structure_lint",
    });
    expect(got.check?.status).toBe("verified");

    await callTool(adapter.client, "finalize_stage", {
      stage_id: stage.stage_id, status: "passed", winner_attempt_id: att.attempt_id,
    });
    await callTool(adapter.client, "finalize_run", { run_id: run.run_id, status: "complete" });
  });

  it("flags a malformed ADR as a violation and blocks finalize_stage(passed)", async () => {
    const { run, stage, att } = await seedStage("architecture", "design");
    await callTool(adapter.client, "archive_artifact", {
      run_id: run.run_id, stage_id: stage.stage_id, taxonomy_section: "4.6", kind: "adr",
      relative_path: "architecture/adr-0099-bad.md", bytes: BAD_ADR_NO_DECISION,
    });
    await callTool(adapter.client, "record_verdict", {
      attempt_id: att.attempt_id, judge_producer: "claude", judge_model_id: "claude-sonnet-4-6",
      outcome: "pass",
      critique_md: "Anti-vacuous-pass placeholder; the validator gate is the real check here and it should fire because the Decision section is missing from the ADR body.",
      score_json: { structure: 0.5 },
    });

    const v = await callTool<{ status: string; reason?: string }>(adapter.client, "artifact_validate", {
      stage_id: stage.stage_id, kind: "adr_structure_lint",
    });
    expect(v.status).toBe("violation");
    expect(v.reason ?? "").toMatch(/Decision/);

    const readiness = await callTool<{ can_pass: boolean; next_action: string }>(
      adapter.client, "get_stage_finalize_readiness", { stage_id: stage.stage_id },
    );
    expect(readiness.can_pass).toBe(false);
    expect(readiness.next_action).toBe("retry_or_surface");

    // finalize_stage(passed) must be refused (returned as an MCP tool error).
    const refused = (await adapter.client.callTool({
      name: "finalize_stage",
      arguments: { stage_id: stage.stage_id, status: "passed", winner_attempt_id: att.attempt_id },
    })) as { isError?: boolean };
    expect(refused.isError).toBe(true);

    // 'surfaced' is the escape hatch.
    await callTool(adapter.client, "finalize_stage", {
      stage_id: stage.stage_id, status: "surfaced", winner_attempt_id: att.attempt_id,
    });
    await callTool(adapter.client, "finalize_run", { run_id: run.run_id, status: "surfaced" });
  });
});
