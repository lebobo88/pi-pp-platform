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
import { createEngine } from "@pp/engine";
import { createInMemoryBus, type BusPort } from "./bus.js";
import { registerSecurity } from "./security.js";
import { registerLegacyRoutes } from "./routes/legacy.js";
import { registerLibraryRoutes } from "./routes/library.js";
import { registerProjectRoutes } from "./routes/projects.js";
import { registerRunRoutes } from "./routes/runs.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerEventRoutes } from "./routes/events.js";
import { registerStatic } from "./routes/static.js";
import type { ServerDeps } from "./deps.js";

export interface BuildAppOptions {
  /** Override the @pp/core SQLite path (tests). */
  dbPath?: string;
  /** Absolute path to the built UI (ui/dist) for static serving. */
  uiDistPath?: string;
  /** Inject an event bus (the pilot's real bus in M5d); default in-memory. */
  bus?: BusPort;
  /** Bearer token gate; default process.env.PP_API_TOKEN. */
  token?: string;
}

export async function buildApp(opts: BuildAppOptions = {}): Promise<FastifyInstance> {
  if (opts.dbPath) setDbPath(opts.dbPath);

  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });

  const deps: ServerDeps = {
    bus: opts.bus ?? createInMemoryBus(),
    engine: createEngine({ mode: "pi" }),
    uiDistPath: opts.uiDistPath,
  };

  registerSecurity(app, { token: opts.token ?? process.env.PP_API_TOKEN });

  registerLegacyRoutes(app);
  registerLibraryRoutes(app, deps);
  registerProjectRoutes(app);
  registerRunRoutes(app);
  registerProviderRoutes(app, deps);
  registerEventRoutes(app, deps);

  if (opts.uiDistPath) await registerStatic(app, opts.uiDistPath);

  await app.ready();
  return app;
}
