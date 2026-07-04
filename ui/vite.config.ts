import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const DAEMON_ORIGIN = process.env.PP_DAEMON_ORIGIN ?? "http://127.0.0.1:7878";

// Test config lives in vitest.config.ts — it uses vitest's own (vite@5) config
// factory, kept separate so this file can stay bound to vite@6's plugin types.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@shared": fileURLToPath(new URL("../shared", import.meta.url)),
    },
  },
  server: {
    port: 5273,
    proxy: {
      // REST + SSE both live under /api. `configure` strips the upstream
      // content-length so Server-Sent Events stream frame-by-frame instead of
      // stalling behind a buffered full response.
      "/api": {
        target: DAEMON_ORIGIN,
        changeOrigin: true,
        ws: false,
        configure: (proxy) => {
          proxy.on("proxyRes", (proxyRes) => {
            delete proxyRes.headers["content-length"];
          });
        },
      },
      "/healthz": {
        target: DAEMON_ORIGIN,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
