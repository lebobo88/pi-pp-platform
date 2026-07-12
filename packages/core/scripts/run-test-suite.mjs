import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tempHome = mkdtempSync(join(tmpdir(), "pp-core-home-"));

const commands = [
  ["pnpm", ["run", "build"]],
  ["node", ["test/ecosystem.unit.mjs"]],
  ["node", ["test/ecosystem-guard.unit.mjs"]],
  ["node", ["test/projects-migration.unit.mjs"]],
  ["node", ["test/stage-plan-migration.unit.mjs"]],
  ["node", ["test/provider-columns.unit.mjs"]],
  ["node", ["test/tdd-parser.unit.mjs"]],
  ["node", ["test/missability.unit.mjs"]],
  ["node", ["test/janitor.unit.mjs"]],
  ["node", ["test/runs-pagination.unit.mjs"]],
  ["node", ["test/cli-flags-persist.unit.mjs"]],
  ["node", ["test/tier-pools.unit.mjs"]],
  ["node", ["test/derive-outcome.unit.mjs"]],
  ["node", ["--test", "test/completion-readiness.unit.mjs"]],
  ["node", ["--test", "test/finalize-gates-b.unit.mjs", "test/finalize-gates-c.unit.mjs", "test/missability-producibility.unit.mjs", "test/fable-tier.unit.mjs", "test/findings-provenance.unit.mjs", "test/gemini-disable.unit.mjs", "test/missability-evidence-ref.unit.mjs", "test/rejudge-gate.unit.mjs", "test/retract-verdict.unit.mjs", "test/judge-stats.unit.mjs", "test/judge-usage.unit.mjs", "test/tail-fix-select.unit.mjs", "test/team-bon-policy.unit.mjs", "test/agents-library.unit.mjs", "test/team-recommend.unit.mjs", "test/skills-loader.unit.mjs", "test/team-skills.unit.mjs", "test/evolution-commit.unit.mjs", "test/profile-promote-blueprint.unit.mjs", "test/cli-login.unit.mjs", "test/workspace-detect.unit.mjs", "test/triage-greenfield.unit.mjs", "test/gates-greenfield.unit.mjs", "test/loop-ceiling-automatic.unit.mjs", "test/same-model-guard.unit.mjs", "test/archive-path-normalize.unit.mjs", "test/browser-validation-scoping.unit.mjs"]],
];

const env = {
  ...process.env,
  PP_HOME: tempHome,
  HOME: tempHome,
  USERPROFILE: tempHome,
  PP_SKIP_CLI_VERSIONS: "1",
};

let exitCode = 0;
try {
  for (const [command, args] of commands) {
    const result = spawnSync(command, args, {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
      env,
    });
    if ((result.status ?? 1) !== 0) {
      exitCode = result.status ?? 1;
      break;
    }
  }
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

process.exit(exitCode);
