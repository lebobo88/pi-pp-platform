// Unit tests for the 2026-07-04 run-failure fixes:
//  - detectProfile request-text refinement (game/tauri routing, fs-detection precedence)
//  - archiveArtifact containment guard (relative_path escaping .harness/<run>)
//  - promoteArtifact (docs/pp/<run_id>/ copy + promoted_path provenance + guards)
//  - ensureTaxonomyBlueprint (scaffold-if-absent, idempotent)

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";

const SUITE_DIR = mkdtempSync(join(tmpdir(), "pp-ppb-home-"));
process.env.PP_HOME = SUITE_DIR;
process.env.EIGHTS_SKIP_AUDIT_CHECK = "1";
process.env.PP_SKIP_CLI_VERSIONS = "1";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

const { detectProfile } = await importDist("orchestrator/profile-detect.js");
const { classifyRequestText, ensureTaxonomyBlueprint } = await importDist("orchestrator/taxonomy.js");
const { startRun, archiveArtifact, promoteArtifact, ArchiveArtifactPathError } = await importDist("orchestrator/runs.js");

const tempProject = () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-ppb-proj-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const SNAKE_REQUEST =
  "create a tauri high powered scientific calculator app that also has the game snake programmed into it";

// ─── classifyRequestText ────────────────────────────────────────────────────

test("classifyRequestText: snake-calc request is game + tauri shell", () => {
  const cls = classifyRequestText(SNAKE_REQUEST.toLowerCase());
  assert.equal(cls.game, true);
  assert.equal(cls.desktopShell, "tauri");
});

test("classifyRequestText: plain CRUD request is not game-shaped", () => {
  const cls = classifyRequestText("add a rest endpoint for invoices");
  assert.equal(cls.game, false);
  assert.equal(cls.desktopShell, null);
});

// ─── detectProfile request-text refinement ─────────────────────────────────

test("detectProfile: empty project, no request text → unchanged null/none", () => {
  const det = detectProfile(tempProject());
  assert.equal(det.recommendation, null);
  assert.equal(det.confidence, "none");
});

test("detectProfile: empty project + snake-calc request → game-dev-web medium", () => {
  const det = detectProfile(tempProject(), { requestText: SNAKE_REQUEST });
  assert.equal(det.recommendation, "game-dev-web");
  assert.equal(det.confidence, "medium");
  assert.ok(det.signals.some((s) => s.includes("game-shaped")));
});

test("detectProfile: empty project + game request without shell → game-dev-custom medium", () => {
  const det = detectProfile(tempProject(), { requestText: "build the game snake with a boss encounter" });
  assert.equal(det.recommendation, "game-dev-custom");
  assert.equal(det.confidence, "medium");
});

test("detectProfile: tauri manifest without request text → web-ui medium", () => {
  const dir = tempProject();
  mkdirSync(join(dir, "src-tauri"), { recursive: true });
  writeFileSync(join(dir, "src-tauri", "tauri.conf.json"), "{}", "utf8");
  const det = detectProfile(dir);
  assert.equal(det.recommendation, "web-ui");
  assert.equal(det.confidence, "medium");
});

test("detectProfile: strong filesystem signal beats request text", () => {
  const dir = tempProject();
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" } }),
    "utf8",
  );
  const det = detectProfile(dir, { requestText: SNAKE_REQUEST });
  assert.equal(det.recommendation, "web-ui");
  assert.equal(det.confidence, "high");
});

// ─── archiveArtifact containment + promoteArtifact ─────────────────────────

const project = tempProject();
const { run_id } = await startRun({ request_text: SNAKE_REQUEST, project_path: project, mode: "single" });

test("archiveArtifact: relative_path escaping .harness/<run> is rejected", () => {
  assert.throws(
    () =>
      archiveArtifact({
        run_id,
        relative_path: "../../evil.md",
        bytes: "# escape\n",
      }),
    ArchiveArtifactPathError,
  );
  assert.equal(existsSync(join(project, "evil.md")), false);
});

test("promoteArtifact: archived spec lands in docs/pp/<run_id>/ with provenance", async () => {
  const archived = archiveArtifact({
    run_id,
    relative_path: "spec/spec-author.md",
    kind: "spec",
    taxonomy_section: "4.3",
    bytes: "# PRD\n\nFR-1: it MUST work.\n",
  });
  assert.equal(archived.status, "ok");

  const promoted = promoteArtifact({
    run_id,
    source_abs_path: archived.absolute_path,
    dest_name: "spec-spec-author.md",
  });
  assert.equal(promoted.status, "ok");
  const dest = join(project, "docs", "pp", run_id, "spec-spec-author.md");
  assert.ok(existsSync(dest));
  assert.match(readFileSync(dest, "utf8"), /FR-1: it MUST work/);

  const { db } = await importDist("db/database.js");
  const row = db()
    .prepare(`SELECT promoted_path FROM artifacts WHERE run_id = ? AND kind = 'spec'`)
    .get(run_id);
  assert.equal(row.promoted_path, `docs/pp/${run_id}/spec-spec-author.md`);
});

test("promoteArtifact: source outside the run artifact dir is skipped", () => {
  const outside = join(project, "README-outside.md");
  writeFileSync(outside, "outside\n", "utf8");
  const res = promoteArtifact({ run_id, source_abs_path: outside, dest_name: "x.md" });
  assert.equal(res.status, "skipped");
});

test("promoteArtifact: hostile dest_name cannot escape docs/pp/", () => {
  const archived = archiveArtifact({
    run_id,
    relative_path: "spec/other.md",
    kind: "adr",
    bytes: "# doc\n",
  });
  const res = promoteArtifact({
    run_id,
    source_abs_path: archived.absolute_path,
    dest_name: "../../../escape.md",
  });
  // Sanitization strips traversal — result stays inside docs/pp/<run_id>/.
  assert.equal(res.status, "ok");
  assert.ok(res.promoted_path.startsWith(`docs/pp/${run_id}/`));
  assert.equal(existsSync(join(project, "..", "escape.md")), false);
});

// ─── ensureTaxonomyBlueprint ────────────────────────────────────────────────

test("ensureTaxonomyBlueprint: scaffolds once, then reports exists", () => {
  const dir = tempProject();
  const first = ensureTaxonomyBlueprint(dir);
  assert.equal(first.status, "created");
  assert.ok(existsSync(join(dir, "docs", "taxonomy_blueprint.md")));
  const body = readFileSync(join(dir, "docs", "taxonomy_blueprint.md"), "utf8");
  assert.ok(body.length > 1000);

  const second = ensureTaxonomyBlueprint(dir);
  assert.equal(second.status, "exists");
});
