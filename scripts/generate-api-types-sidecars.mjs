import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const projectSearchRoots = [
  join(root, "packages", "core"),
  join(root, "packages", "pilot"),
  join(root, "packages", "server"),
  join(root, "ui"),
];

let tscBin;
try {
  tscBin = require.resolve("typescript/bin/tsc", { paths: projectSearchRoots });
} catch (error) {
  console.error("Failed to resolve a workspace TypeScript binary for shared/api-types sidecar generation.");
  throw error;
}

const configPath = join(root, "shared", "tsconfig.emit.json");
const result = spawnSync(process.execPath, [tscBin, "-p", configPath], {
  cwd: root,
  stdio: "inherit",
});

process.exit(result.status ?? 1);
