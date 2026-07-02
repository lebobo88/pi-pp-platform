import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    extensionAlias: {
      ".js": [".ts", ".js"],
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // pi has no codex/gemini/claude sub-CLIs; skip core's captureCliVersions()
    // subprocess probes (a slow `claude --version` otherwise adds ~6s to the
    // first startRun and can push run-driving tests past the timeout).
    env: { PP_SKIP_CLI_VERSIONS: "1" },
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
