/**
 * buildApp — assemble the Fastify control-plane server.
 *
 * Registers: security (loopback + bearer gate), legacy reads, library/project/
 * run read routes for shared/api-types.ts, live run-control mutations via the
 * RunSupervisor + @pp/pilot, provider key management via @pp/engine auth, SSE
 * over an injected BusPort, and static UI serving.
 */
import Fastify, { type FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { setDbPath } from "@pp/core";
import { createEngine, type Engine } from "@pp/engine";
import { createInMemoryBus, type BusPort } from "./bus.js";
import { RunSupervisor } from "./supervisor.js";
import { registerSecurity } from "./security.js";
import { registerLegacyRoutes } from "./routes/legacy.js";
import { registerLibraryRoutes } from "./routes/library.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerRunControlRoutes } from "./routes/run-control.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerStatic } from "./routes/static.js";
import type { ServerDeps } from "./deps.js";
import { register, ppRequestDuration } from "./metrics.js";

export interface BuildAppOptions {
  /** Override the @pp/core SQLite path (tests). */
  dbPath?: string;
  /** Absolute path to the built UI (ui/dist) for static serving. */
  uiDistPath?: string;
  /** Inject an event bus; default in-memory. */
  bus?: BusPort;
  /** Bearer token gate; default process.env.PP_API_TOKEN. */
  token?: string;
  /**
   * Per-run engine factory used by the RunSupervisor. Default: createEngine
   * with mode "fake" when PP_LLM=fake, else "pi". Tests inject a scripted engine.
   */
  makeEngine?: () => Engine;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  if (opts.dbPath) setDbPath(opts.dbPath);

  // maxParamLength: URL-encoded absolute project paths (esp. deep Windows paths
  // like C:\Users\...\a\b\c\project → %5C… escapes) blow past Fastify's ~100-char
  // default and 414 on GET /projects/:path (+ /master-plan, /agents-md,
  // /constitution, /profile). 4096 comfortably covers real paths. Set via
  // routerOptions (the Fastify 5 forward-compatible location — the top-level
  // option is deprecated for fastify@6).
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      serializers: {
        req(request) {
          const match = request.url?.match(/^\/api\/v1\/runs\/([^/?]+)/);
          return {
            method: request.method,
            url: request.url,
            hostname: request.hostname,
            remoteAddress: request.ip,
            remotePort: request.socket.remotePort,
            run_id: match?.[1] ? decodeURIComponent(match[1]) : undefined,
          };
        },
      },
      redact: [
        "req.headers.authorization",
        "req.headers.cookie",
        "*.apiKey",
        "*.key",
        "*.token",
      ],
    },
    genReqId: (req) => {
      const match = req.url?.match(/^\/api\/v1\/runs\/([^/?]+)/);
      const runId = match?.[1] ? decodeURIComponent(match[1]) : undefined;
      const baseId = crypto.randomUUID();
      return runId ? `${runId}-${baseId}` : baseId;
    },
    bodyLimit: 8 * 1024 * 1024,
    routerOptions: { maxParamLength: 4096 },
  });

  const bus = opts.bus ?? createInMemoryBus();
  const makeEngine = opts.makeEngine ?? (() => createEngine({ mode: process.env.PP_LLM === "fake" ? "fake" : "pi" }));

  const deps: ServerDeps = {
    bus,
    // A "pi" engine for key management / doctor / gate re-judge (always the real
    // platform auth storage, independent of the per-run engine mode).
    engine: createEngine({ mode: "pi" }),
    supervisor: new RunSupervisor(bus, makeEngine, app.log),
    makeEngine,
    uiDistPath: opts.uiDistPath,
  };

  registerSecurity(app, { token: opts.token ?? process.env.PP_API_TOKEN });

  // ── Prometheus metrics ─────────────────────────────────────────────────────
  // /metrics is an ops surface consumed by Prometheus scrapers, not UI clients.
  // It is intentionally NOT included in shared/api-types.ts apiPaths because it
  // is outside the UI wire contract and should not be proxied or typed-checked
  // by the frontend.
  app.get("/metrics", async (_req, reply) => {
    reply
      .header("Content-Type", register.contentType)
      .send(await register.metrics());
  });

  // Stamp request start time for duration histogram.
  app.addHook("onRequest", (req, _reply, done) => {
    (req as unknown as Record<string, unknown>)._metricsStart = Date.now();
    done();
  });

  // Record request duration on response; skip SSE streams and /metrics itself.
  const SSE_ROUTES = new Set(["/api/v1/events", "/api/v1/runs/:id/events"]);
  app.addHook("onResponse", (req, reply, done) => {
    try {
      const route: string = (req.routeOptions as { url?: string }).url ?? "";
      if (route !== "/metrics" && !SSE_ROUTES.has(route)) {
        const startMs = (req as unknown as Record<string, unknown>)._metricsStart as number | undefined;
        if (startMs !== undefined) {
          const durationSec = (Date.now() - startMs) / 1000;
          ppRequestDuration.observe(
            {
              method: req.method,
              route: route || "unmatched",
              status_code: String(reply.statusCode),
            },
            durationSec,
          );
        }
      }
    } catch {
      /* metrics must never break the response path */
    }
    done();
  });
  // ──────────────────────────────────────────────────────────────────────────

  registerLegacyRoutes(app);
  registerLibraryRoutes(app, deps);
  registerProjectRoutes(app);
  registerRunRoutes(app);
  registerRunControlRoutes(app, deps);
  registerProviderRoutes(app, deps);
  registerEventRoutes(app, deps);

  if (opts.uiDistPath) await registerStatic(app, opts.uiDistPath);

  // Expose the supervisor for tests (drain in-flight runs) and future in-proc use.
  app.decorate("ppSupervisor", deps.supervisor);

  await app.ready();
  return app;
}
