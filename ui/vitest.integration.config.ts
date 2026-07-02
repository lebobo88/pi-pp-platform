import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

// Opt-in integration suite: boots the REAL built ppd and exercises the UI read
// paths + SSE against it. Kept OUT of the default `src/**` include so the fast
// unit suite never boots a server. Run with:  PP_INTEGRATION=1 pnpm -F @pp/ui test:integration
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@shared": fileURLToPath(new URL("../shared", import.meta.url)),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    include: ["integration/**/*.integration.test.{ts,tsx}"],
    testTimeout: 30_000,
    hookTimeout: 45_000,
    // Server + shared DB: run serially, single fork.
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
  },
});
