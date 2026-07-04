import { describe, it, expect, vi, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the platform dir BEFORE the engine/core modules load (their catalog
// tables are built at import time).
process.env.PP_PLATFORM_DIR = mkdtempSync(join(tmpdir(), "pp-eng-refresh-"));
process.env.PP_SKIP_CLI_VERSIONS = "1";

// Stub pi's builtin catalog with one static and two dynamic providers so both
// refresh outcomes are exercised without touching the network. `refreshed`
// must be true ONLY when a live refreshModels() call actually succeeded.
const refreshOk = vi.fn(async () => {});
vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getProviders: () => [{ id: "staticprov" }, { id: "dynprov" }, { id: "offlineprov" }],
    getModels: (provider?: string) => {
      const all = [
        { id: "static-model", provider: "staticprov", cost: { input: 1, output: 2 } },
        { id: "dyn-model", provider: "dynprov", cost: { input: 1, output: 2 } },
        { id: "offline-model", provider: "offlineprov", cost: { input: 1, output: 2 } },
      ];
      return provider ? all.filter((m) => m.provider === provider) : all;
    },
    getProvider: (id: string) => {
      if (id === "dynprov") return { refreshModels: refreshOk };
      if (id === "offlineprov") {
        return {
          refreshModels: async () => {
            throw new Error("offline");
          },
        };
      }
      return {};
    },
  }),
}));

let models: typeof import("../src/models.js");

beforeAll(async () => {
  models = await import("../src/models.js");
});

describe("refreshPiModels refresh honesty", () => {
  it("static provider (no refreshModels) → refreshed:false with the static list", async () => {
    const r = await models.refreshPiModels("staticprov");
    expect(r.refreshed).toBe(false);
    expect(r.models.map((m) => m.id)).toEqual(["static-model"]);
  });

  it("dynamic provider whose live refresh succeeds → refreshed:true", async () => {
    const r = await models.refreshPiModels("dynprov");
    expect(refreshOk).toHaveBeenCalledTimes(1);
    expect(r.refreshed).toBe(true);
    expect(r.models.map((m) => m.id)).toEqual(["dyn-model"]);
  });

  it("dynamic provider whose live refresh throws → refreshed:false with the static fallback", async () => {
    const r = await models.refreshPiModels("offlineprov");
    expect(r.refreshed).toBe(false);
    expect(r.models.map((m) => m.id)).toEqual(["offline-model"]);
  });

  it("unknown provider → refreshed:false with an empty list", async () => {
    const r = await models.refreshPiModels("not-a-provider");
    expect(r.refreshed).toBe(false);
    expect(r.models).toEqual([]);
  });
});
