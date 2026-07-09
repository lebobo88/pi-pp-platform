import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const vitestBin = require.resolve("vitest/vitest.mjs");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tempHome = join(root, ".tmp-test-home");

rmSync(tempHome, { recursive: true, force: true });
mkdirSync(tempHome, { recursive: true });

const args = process.argv.slice(2);
const result = spawnSync(process.execPath, [vitestBin, ...(args.length > 0 ? args : ["run"])], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    PP_HOME: tempHome,
    HOME: tempHome,
    USERPROFILE: tempHome,
    PP_SKIP_CLI_VERSIONS: "1",
  },
});

rmSync(tempHome, { recursive: true, force: true });
process.exit(result.status ?? 1);
