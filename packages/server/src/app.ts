/**
 * buildApp — assemble the Fastify control-plane server.
 *
 * Foundation scope (M5c): all read routes for shared/api-types.ts, provider key
 * management via @pp/engine auth, SSE over an injected BusPort, and static UI
 * serving. Run-control routes are registered but return 501 until the pilot is
 * wired (M5d). No @pp/pilot dependency.
 */
import Fastify, { type FastifyInstance } from "fastify";
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
    logger: false,
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
    supervisor: new RunSupervisor(bus, makeEngine),
    makeEngine,
    uiDistPath: opts.uiDistPath,
  };

  registerSecurity(app, { token: opts.token ?? process.env.PP_API_TOKEN });

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
