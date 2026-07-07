// Unit tests for R6 monorepo-aware profile detection:
//   - resolveWorkspaceMembers handles the three real pnpm workspace shapes
//     (`packages/*`, `packages/**`, bare `ui`/`apps/web` entries)
//   - combineMemberClassifications: strict-majority, plurality-without-majority,
//     and count-tie (precedence fallback) cases
//   - request-text blending guardrail: a game-shaped request MAY tip a MEDIUM
//     filesystem recommendation but MUST NOT override a HIGH one (both directions)
//
// Self-contained: pure functions + tmpdir fixtures, no daemon, no DB, no LLM.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(__dirname, "..", "dist");
const importDist = (relPath) => import(pathToFileURL(join(DIST, relPath)).href);

const { resolveWorkspaceMembers, combineMemberClassifications, detectProfile } =
  await importDist("orchestrator/profile-detect.js");

const tempProject = () => {
  const dir = mkdtempSync(join(tmpdir(), "pp-ws-"));
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const writePkg = (root, rel, pkg) => {
  mkdirSync(join(root, rel), { recursive: true });
  writeFileSync(join(root, rel, "package.json"), JSON.stringify(pkg), "utf8");
};
const writeWorkspace = (root, patterns) =>
  writeFileSync(
    join(root, "pnpm-workspace.yaml"),
    `packages:\n${patterns.map((p) => `  - '${p}'`).join("\n")}\n`,
    "utf8",
  );

// ─── WORKSPACE GLOBS ───────────────────────────────────────────────────────

test("resolveWorkspaceMembers: 'packages/*' expands direct children only", () => {
  const dir = tempProject();
  writeWorkspace(dir, ["packages/*"]);
  writePkg(dir, "packages/core", { name: "core" });
  writePkg(dir, "packages/ui", { name: "ui" });
  writePkg(dir, "packages/nested/deep", { name: "deep" }); // one level too deep for '*'
  mkdirSync(join(dir, "packages/node_modules/pkg-x"), { recursive: true });
  writeFileSync(join(dir, "packages/node_modules/pkg-x/package.json"), "{}", "utf8");

  const members = resolveWorkspaceMembers(dir).sort();
  assert.deepEqual(members, ["packages/core", "packages/ui"]);
  assert.ok(!members.includes("packages/nested/deep"), "'*' must not recurse");
  assert.ok(!members.some((m) => m.includes("node_modules")), "node_modules skipped");
});

test("resolveWorkspaceMembers: 'packages/**' recurses into subdirectories", () => {
  const dir = tempProject();
  writeWorkspace(dir, ["packages/**"]);
  writePkg(dir, "packages/core", { name: "core" });
  writePkg(dir, "packages/group/inner", { name: "inner" });
  mkdirSync(join(dir, "packages/node_modules/dep"), { recursive: true });
  writeFileSync(join(dir, "packages/node_modules/dep/package.json"), "{}", "utf8");

  const members = resolveWorkspaceMembers(dir).sort();
  assert.deepEqual(members, ["packages/core", "packages/group/inner"]);
  assert.ok(!members.some((m) => m.includes("node_modules")), "node_modules skipped in recursion");
});

test("resolveWorkspaceMembers: bare directory entries resolve directly", () => {
  const dir = tempProject();
  writeWorkspace(dir, ["ui", "apps/web"]);
  writePkg(dir, "ui", { name: "ui" });
  writePkg(dir, "apps/web", { name: "web" });
  writePkg(dir, "apps/api", { name: "api" }); // not listed → not a member

  const members = resolveWorkspaceMembers(dir).sort();
  assert.deepEqual(members, ["apps/web", "ui"]);
});

test("resolveWorkspaceMembers: reads workspaces array from package.json too", () => {
  const dir = tempProject();
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "root", workspaces: ["packages/*"] }),
    "utf8",
  );
  writePkg(dir, "packages/a", { name: "a" });
  assert.deepEqual(resolveWorkspaceMembers(dir), ["packages/a"]);
});

// ─── COMBINER ───────────────────────────────────────────────────────────────

test("combiner: strict majority (> half) wins", () => {
  const r = combineMemberClassifications([
    { member: "a", profile: "web-ui" },
    { member: "b", profile: "web-ui" },
    { member: "c", profile: "api-platform" },
  ]);
  assert.equal(r.recommendation, "web-ui");
  assert.equal(r.method, "majority");
  assert.ok(r.trace.some((t) => t.includes("strict majority")));
});

test("combiner: plurality without majority wins (highest count, not > half)", () => {
  const r = combineMemberClassifications([
    { member: "a", profile: "web-ui" },
    { member: "b", profile: "web-ui" },
    { member: "c", profile: "api-platform" },
    { member: "d", profile: "non-ui-cli" },
  ]); // web-ui 2/4 — highest but not a majority
  assert.equal(r.recommendation, "web-ui");
  assert.equal(r.method, "plurality");
  assert.ok(r.trace.some((t) => t.includes("plurality")));
});

test("combiner: count tie falls back to classifier precedence order", () => {
  const r = combineMemberClassifications([
    { member: "a", profile: "api-platform" },
    { member: "b", profile: "web-ui" },
  ]); // 1–1 tie; precedence ranks web-ui above api-platform
  assert.equal(r.recommendation, "web-ui");
  assert.equal(r.method, "precedence-tie");
  assert.ok(r.trace.some((t) => t.includes("count tie")));
});

test("combiner: empty input → no recommendation, trace still present", () => {
  const r = combineMemberClassifications([]);
  assert.equal(r.recommendation, null);
  assert.equal(r.method, "none");
  assert.deepEqual(r.trace, []);
});

// ─── REQUEST-TEXT BLENDING GUARDRAIL (both directions) ──────────────────────

test("blending: game request TIPS a MEDIUM filesystem recommendation (with trace)", () => {
  const dir = tempProject();
  // openapi.yaml at root → api-platform at MEDIUM confidence.
  writeFileSync(join(dir, "openapi.yaml"), "openapi: 3.1.0\n", "utf8");
  const det = detectProfile(dir, { requestText: "build the game snake with a boss encounter" });
  assert.match(det.recommendation, /^game-dev-/, "medium api-platform should be tipped to game-dev");
  assert.equal(det.confidence, "medium");
  assert.ok(det.signals.some((s) => s.includes("blended over medium")), "tip must be traced");
});

test("blending: game request MUST NOT override a HIGH filesystem recommendation", () => {
  const dir = tempProject();
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ dependencies: { react: "^18.0.0", "react-dom": "^18.0.0" } }),
    "utf8",
  );
  const det = detectProfile(dir, { requestText: "build the game snake with a boss encounter" });
  assert.equal(det.recommendation, "web-ui", "high web-ui is authoritative");
  assert.equal(det.confidence, "high");
  assert.ok(!det.signals.some((s) => s.includes("game-shaped")), "no blend trace on a high signal");
});

test("blending: a MEDIUM recommendation stands when the request is not game-shaped", () => {
  const dir = tempProject();
  writeFileSync(join(dir, "openapi.yaml"), "openapi: 3.1.0\n", "utf8");
  const det = detectProfile(dir, { requestText: "add a rest endpoint for invoices" });
  assert.equal(det.recommendation, "api-platform");
  assert.equal(det.confidence, "medium");
});
