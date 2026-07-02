/**
 * @pp/server — Fastify REST/SSE control plane over @pp/core + @pp/engine.
 * Library surface (the executable entry point is dist/bin/ppd.js, bin `ppd`).
 */
export { buildApp, type BuildAppOptions } from "./app.js";
export {
  createInMemoryBus,
  noopBus,
  seededBus,
  type BusPort,
  type SseFrame,
  type SsePublish,
} from "./bus.js";
export { RunSupervisor, type StartRunInput, type StartResult } from "./supervisor.js";
export type { ServerDeps } from "./deps.js";
export {
  allProviderStatuses,
  providerStatusWire,
  modelsWire,
  type WireProviderStatus,
  type WireModelInfo,
  type WireVendor,
} from "./wire.js";
