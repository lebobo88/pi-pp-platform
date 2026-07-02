import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    extensionAlias: {
      ".js": [".ts", ".js"],
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // Generous headroom for run-driving tests (real RunPilot + git commits).
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
