-- pp-daemon SQLite schema.
-- All timestamps stored as ISO-8601 text in UTC.

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

CREATE TABLE IF NOT EXISTS runs (
  id                       TEXT PRIMARY KEY,
  session_id               TEXT,
  project_path             TEXT NOT NULL,
  request_text             TEXT NOT NULL,
  team                     TEXT,
  mode                     TEXT NOT NULL,                  -- single | best_of | team | review
  forum                    TEXT,                            -- only set when mode = review
  n                        INTEGER,                         -- only set when mode = best_of
  status                   TEXT NOT NULL,                  -- pending | running | surfaced | complete | crashed | aborted
  profile_snapshot_json    TEXT,
  taxonomy_mapping_json    TEXT,
  head_sha                 TEXT,
  tree_dirty_hash          TEXT,
  cli_versions_json        TEXT,
  stage_plan_json          TEXT,                              -- v10: persisted resolved StageSpec[] plan for resume
  started_at               TEXT NOT NULL,
  finished_at              TEXT
);
CREATE INDEX IF NOT EXISTS idx_runs_project_started ON runs(project_path, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status          ON runs(status);

CREATE TABLE IF NOT EXISTS stages (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL,                       -- spec | design | architecture | contracts | code | security | tests_pre | tests | docs | release | ops | data | ux | design_system | release_plan | retirement | taxonomy_close
  gate_type           TEXT NOT NULL,                       -- spec | design | security | contract | code_style | docs_polish | lint_class
  status              TEXT NOT NULL,                       -- open | passed | surfaced | skipped
  winner_attempt_id   TEXT,
  started_at          TEXT NOT NULL,
  finished_at         TEXT,
  notes_json          TEXT,                                 -- per-stage metadata (e.g. best-of-N shuffle seed, candidate order)
  plan_index          INTEGER                               -- v10: index into runs.stage_plan_json for this stage
);
CREATE INDEX IF NOT EXISTS idx_stages_run ON stages(run_id);

CREATE TABLE IF NOT EXISTS attempts (
  id                  TEXT PRIMARY KEY,
  stage_id            TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  producer            TEXT NOT NULL,                       -- codex | gemini | claude | <subagent name>
  model_id            TEXT NOT NULL,
  prompt_hash         TEXT,
  artifact_path       TEXT,                                 -- relative to project .harness/
  tokens_in           INTEGER,
  tokens_out          INTEGER,
  cost_usd            REAL,
  wall_ms             INTEGER,
  retry_index         INTEGER NOT NULL DEFAULT 0,          -- 0 = first try, 1 = reflexion retry
  parent_attempt_id   TEXT,                                 -- non-null when this is a retry
  status              TEXT NOT NULL,                       -- ok | error | timeout
  -- v13: context-window usage observability (Opportunity 5). Both nullable;
  -- absent on legacy rows and when the model's context window is unknown.
  -- context_used = input + cacheRead + cacheWrite (prompt tokens for this call).
  -- context_max  = catalog context_window for the model at generation time.
  context_used        INTEGER,
  context_max         INTEGER,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_attempts_stage  ON attempts(stage_id);
CREATE INDEX IF NOT EXISTS idx_attempts_parent ON attempts(parent_attempt_id);

CREATE TABLE IF NOT EXISTS verdicts (
  id                  TEXT PRIMARY KEY,
  attempt_id          TEXT NOT NULL REFERENCES attempts(id) ON DELETE CASCADE,
  judge_producer      TEXT NOT NULL,
  judge_model_id      TEXT NOT NULL,
  rubric_id           TEXT,
  outcome             TEXT NOT NULL,                       -- pass | fail | revise
  critique_md         TEXT,
  score_json          TEXT,
  cross_vendor        INTEGER NOT NULL DEFAULT 0,          -- 1 if judge vendor != generator vendor
  -- v9: judge-usage cost attribution. NULL unless the judge reported spend;
  -- when present these are also credited to the run:/day:/model:<judge_model_id>
  -- budget scopes via tallyBudgets.
  tokens_in           INTEGER,
  tokens_out          INTEGER,
  cost_usd            REAL,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_verdicts_attempt ON verdicts(attempt_id);

CREATE TABLE IF NOT EXISTS artifacts (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage_id            TEXT,
  taxonomy_section    TEXT,                                 -- e.g. "4.6"
  kind                TEXT,                                 -- adr | prd | threat_model | changelog | screen_state_matrix | ...
  path                TEXT NOT NULL,                       -- relative to project .harness/
  sha256              TEXT NOT NULL,
  bytes               INTEGER NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_run ON artifacts(run_id);

CREATE TABLE IF NOT EXISTS missability_checks (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  check_id            TEXT NOT NULL,                       -- e.g. "nfrs-declared"
  status              TEXT NOT NULL,                       -- pass | fail | n/a
  evidence_path       TEXT,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_missability_run ON missability_checks(run_id);

CREATE TABLE IF NOT EXISTS master_plan_patches (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  section             TEXT NOT NULL,                       -- e.g. "11. Architecture and technical strategy"
  kind                TEXT NOT NULL,                       -- create | update | append
  prev_sha            TEXT,
  new_sha             TEXT NOT NULL,
  applied_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS budgets (
  scope               TEXT PRIMARY KEY,                    -- run:<id> | day:YYYY-MM-DD | project:<sha> | model:<id>
  tokens_in           INTEGER NOT NULL DEFAULT 0,
  tokens_out          INTEGER NOT NULL DEFAULT 0,
  cost_usd            REAL    NOT NULL DEFAULT 0,
  updated_at          TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS teams (
  name                TEXT PRIMARY KEY,
  origin              TEXT NOT NULL,                       -- builtin | user | project
  yaml_text           TEXT NOT NULL,
  loaded_at           TEXT NOT NULL
);

-- Skill registry cache (mirrors teams): last-resolved frontmatter-markdown
-- per skill id. getSkill always re-reads disk; this row is the audit copy.
CREATE TABLE IF NOT EXISTS skills (
  id                  TEXT PRIMARY KEY,
  origin              TEXT NOT NULL,                       -- builtin | user | project
  md_text             TEXT NOT NULL,
  loaded_at           TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sub_cli_sessions (
  project_path        TEXT NOT NULL,
  agent               TEXT NOT NULL,                       -- codex | gemini
  session_id          TEXT NOT NULL,
  last_used_at        TEXT NOT NULL,
  PRIMARY KEY(project_path, agent)
);

CREATE TABLE IF NOT EXISTS rubrics (
  id                  TEXT PRIMARY KEY,                    -- includes version, e.g. "wcag-2.2-aa@1"
  kind                TEXT NOT NULL,
  version             TEXT NOT NULL,
  markdown            TEXT NOT NULL,
  schema_json         TEXT,
  source_url          TEXT
);

-- Singleton row for daemon metadata (schema version etc.)
CREATE TABLE IF NOT EXISTS daemon_meta (
  key                 TEXT PRIMARY KEY,
  value               TEXT NOT NULL
);

INSERT OR IGNORE INTO daemon_meta(key, value) VALUES ('schema_version', '1');

-- TDD execution gate. One row per (stage_id, phase) records the actual
-- outcome of running the test-strategist's tests_pre suite against the
-- working tree. finalizeStage refuses status='passed' for a tests_pre
-- stage without a verified pre row, and refuses status='passed' for a
-- code stage whose immediate predecessor was tests_pre without a
-- verified post row. This makes the red/green property uncircumventable.
CREATE TABLE IF NOT EXISTS tdd_checks (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage_id            TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  phase               TEXT NOT NULL,                       -- 'pre' | 'post'
  mode                TEXT NOT NULL,                       -- 'bug-fix' | 'refactor' | 'feature-tdd'
  test_runner         TEXT NOT NULL,                       -- vitest | jest | mocha | pytest | go-test | cargo-test | unittest | other
  test_command        TEXT NOT NULL,
  test_files_json     TEXT NOT NULL,
  expected            TEXT NOT NULL,                       -- 'all_pass' | 'all_fail'
  actual              TEXT NOT NULL,                       -- 'all_pass' | 'all_fail' | 'mixed' | 'error'
  status              TEXT NOT NULL,                       -- 'verified' | 'violation' | 'execution_error'
  passed_count        INTEGER,
  failed_count        INTEGER,
  exit_code           INTEGER,
  duration_ms         INTEGER NOT NULL,
  output_path         TEXT,
  reason              TEXT,
  manifest_path       TEXT NOT NULL,
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tdd_checks_stage ON tdd_checks(stage_id, phase);
CREATE INDEX IF NOT EXISTS idx_tdd_checks_run   ON tdd_checks(run_id);

-- Artifact validator gate. One row per (stage_id, artifact_id, validator_kind)
-- records the outcome of running a structural validator (e.g. ADR section
-- linter, OpenAPI schema check, Mermaid renderer) over an archived artifact.
-- finalizeStage refuses status='passed' when the validator policy demands a
-- 'verified' row that's missing or in a 'violation' / 'execution_error' state.
-- Mirrors tdd_checks but generalized across validator kinds.
CREATE TABLE IF NOT EXISTS artifact_validations (
  id                  TEXT PRIMARY KEY,
  run_id              TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  stage_id            TEXT NOT NULL REFERENCES stages(id) ON DELETE CASCADE,
  artifact_id         TEXT,                                    -- artifacts.id; null for ad-hoc paths
  validator_kind      TEXT NOT NULL,                           -- adr_structure_lint | contracts_lint | tokens_build | mermaid_render | c4_render
  artifact_kind       TEXT,                                    -- e.g. 'adr', 'openapi', 'design_tokens'
  artifact_path       TEXT NOT NULL,                           -- relative to project root
  status              TEXT NOT NULL,                           -- 'verified' | 'violation' | 'execution_error' | 'skipped'
  exit_code           INTEGER,
  duration_ms         INTEGER NOT NULL,
  output_path         TEXT,                                    -- captured stdout+stderr log
  reason              TEXT,
  binary_resolved     TEXT,                                    -- 'in-process:adr-structure-lint' or 'PATH:/usr/bin/java' etc.
  created_at          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_av_stage ON artifact_validations(stage_id, validator_kind);
CREATE INDEX IF NOT EXISTS idx_av_run   ON artifact_validations(run_id);

-- Persistent event log (observability). Every SSE frame is written here for
-- historical replay, debugging, and analytics. The in-memory ring buffer (2048)
-- is for live delivery; this table is the durable store. Janitor purges rows
-- older than EVENT_RETENTION_DAYS (default 30) on startup.
CREATE TABLE IF NOT EXISTS events (
  id                  INTEGER PRIMARY KEY,
  run_id              TEXT REFERENCES runs(id) ON DELETE CASCADE,
  event_type          TEXT NOT NULL,
  payload             TEXT NOT NULL,
  seq                 INTEGER NOT NULL,
  ts                  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS idx_events_run_seq ON events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_type_ts ON events(event_type, ts);

-- v8 (A5): local evolution commit/rollback audit trail (mirrors schema.ts —
-- evolution_proposals itself is a v7 table defined there). One row per
-- commitProposal write to a project-scoped override target (always inside
-- <project>/.claude/ or <project>/.harness/). snapshot_path / sha_before are
-- NULL when the target did not exist before the commit (rollback then deletes
-- the target instead of restoring a snapshot). Rows persist for audit.
CREATE TABLE IF NOT EXISTS evolution_commits (
  id                  TEXT PRIMARY KEY,
  proposal_id         TEXT NOT NULL REFERENCES evolution_proposals(id) ON DELETE CASCADE,
  target_path         TEXT NOT NULL,
  snapshot_path       TEXT,
  sha_before          TEXT,
  sha_after           TEXT NOT NULL,
  note                TEXT,
  committed_at        TEXT NOT NULL,
  rolled_back_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_evolution_commits_proposal ON evolution_commits(proposal_id);

-- v12: Phase-level timing (observability Opportunity 3). One row per named
-- pilot phase per run. Additive-only; missing rows on legacy runs degrade
-- gracefully.
CREATE TABLE IF NOT EXISTS phases (
  id          INTEGER PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  phase       TEXT NOT NULL,
  started_at  TEXT NOT NULL,
  finished_at TEXT NOT NULL,
  wall_ms     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_phases_run ON phases(run_id);
