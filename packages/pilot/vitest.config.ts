import { defineConfig } from "vitest/config";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// @pp/core's db() is a singleton bound to DB_PATH, which is derived from
// PP_HOME / PP_DB_PATH at module-load time (see core util/paths.ts). To keep
// the pilot's tests fully isolated from the developer's real ~/.pair-programmer
// state.db, point PP_HOME at a fresh temp dir here. This config is evaluated in
// the parent process before any worker imports @pp/core, and the env var is
// inherited by the forked workers.
if (!process.env.PP_HOME) {
  process.env.PP_HOME = mkdtempSync(join(tmpdir(), "pp-pilot-home-"));
}
// Always clear PP_DB_PATH so the fresh PP_HOME database is used,
// not a live developer dev.db that may have divergent model IDs in settings.
delete process.env.PP_DB_PATH;

// Isolate the user scope too: dev machines have ~/.claude/agents and
// ~/.claude/skills installed (AgentSmith), which would shadow the builtin
// prompts/skills under test now that loadRolePrompt and the skill registry
// consult homedir(). Point USERPROFILE/HOME at an empty temp dir for every
// worker; individual test files may still swap in their own fake home.
if (!process.env.PP_PILOT_FAKE_USER_HOME) {
  process.env.PP_PILOT_FAKE_USER_HOME = mkdtempSync(join(tmpdir(), "pp-pilot-userhome-"));
}

export default defineConfig({
  // Source uses NodeNext `.js` specifiers that resolve to `.ts` on disk.
  resolve: {
    extensionAlias: {
      ".js": [".ts", ".js"],
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // @pp/core's db() is a process-wide singleton over one shared state.db
    // file. Parallel test-file workers contend for the SQLite write lock, so
    // run the pilot's DB-touching suites sequentially to keep them deterministic.
    fileParallelism: false,
    env: {
      PP_HOME: process.env.PP_HOME,
      USERPROFILE: process.env.PP_PILOT_FAKE_USER_HOME,
      HOME: process.env.PP_PILOT_FAKE_USER_HOME,
    },
  },
});
