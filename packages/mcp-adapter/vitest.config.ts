import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    extensionAlias: {
      ".js": [".ts", ".js"],
    },
  },
  test: {
    include: ["test/**/*.test.ts"],
    // The round-trip test spawns the built server as a subprocess; give it room.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
