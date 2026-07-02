import type { BusPort } from "./bus.js";
import type { Engine } from "@pp/engine";

/** Everything the route registrars need, assembled by buildApp. */
export interface ServerDeps {
  bus: BusPort;
  /** pi engine (mode "pi"): carries authStorage, catalog, doctorProbe. */
  engine: Engine;
  /** Absolute path to the built UI (ui/dist) for static serving; omitted → no static. */
  uiDistPath?: string;
}

export const V1 = "/api/v1";
