import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

// Unit tests (diff parser, SSE manager, api client) are plain TS + jsdom — no
// React plugin needed, which also keeps this file off the vite@6 plugin types
// that vite.config.ts carries. Aliases mirror vite.config.ts.
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
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
  },
});
