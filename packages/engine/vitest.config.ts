import { defineConfig } from "vitest/config";

export default defineConfig({
  // Source uses NodeNext `.js` specifiers that resolve to `.ts` on disk.
  resolve: {
    extensionAlias: {
      ".js": [".ts", ".js"],
    },
  },
  test: {
    // live.smoke.ts is intentionally excluded from the default run — it makes
    // real network calls and is gated behind PP_LIVE=1 (see test/live.smoke.ts
    // and the `test:live` npm script).
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
