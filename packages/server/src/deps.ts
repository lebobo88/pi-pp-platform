import type { BusPort } from "./bus.js";
import type { Engine } from "@pp/engine";
import type { RunSupervisor } from "./supervisor.js";

/** Everything the route registrars need, assembled by buildApp. */
export interface ServerDeps {
  bus: BusPort;
  /** pi engine (mode "pi"): carries authStorage, catalog, doctorProbe. Used for key mgmt + doctor + gate re-judge. */
  engine: Engine;
  /** Live-run lifecycle owner (concurrency, abort, budget, pilot→SSE bridge). */
  supervisor: RunSupervisor;
  /** Per-op engine factory (same mode as runs: fake when PP_LLM=fake, else pi). Used by post-hoc retry/gate. */
  makeEngine: () => Engine;
  /** Absolute path to the built UI (ui/dist) for static serving; omitted → no static. */
  uiDistPath?: string;
}

export const V1 = "/api/v1";
