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
    env: {
      PP_HOME: process.env.PP_HOME,
    },
  },
});
