import { describe, it, expect, vi, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the platform dir BEFORE the engine/core modules load.
process.env.PP_PLATFORM_DIR = mkdtempSync(join(tmpdir(), "pp-eng-pfm-"));
process.env.PP_SKIP_CLI_VERSIONS = "1";

// A model id served by several vendors (the gpt-5.4 situation): the unkeyed
// vendor enumerates FIRST. Plus one unambiguous id.
vi.mock("@earendil-works/pi-ai/providers/all", () => ({
  builtinModels: () => ({
    getProviders: () => [{ id: "unkeyed-first" }, { id: "keyed-second" }, { id: "solo-prov" }],
    getModels: (provider?: string) => {
      const all = [
        { id: "ambiguous-model-x", provider: "unkeyed-first", cost: { input: 1, output: 2 } },
        { id: "ambiguous-model-x", provider: "keyed-second", cost: { input: 1, output: 2 } },
        { id: "solo-model-x", provider: "solo-prov", cost: { input: 1, output: 2 } },
      ];
      return provider ? all.filter((m) => m.provider === provider) : all;
    },
    getProvider: () => ({}),
  }),
}));

let models: typeof import("../src/models.js");
let auth: typeof import("../src/auth.js");

beforeAll(async () => {
  models = await import("../src/models.js");
  auth = await import("../src/auth.js");
});

describe("providerForModel — credential-aware ambiguity resolution", () => {
  it("prefers the provider holding a credential when the id is ambiguous", () => {
    const storage = auth.createPlatformAuthStorage();
    auth.setProviderKey(storage, "keyed-second", "sk-test-not-a-real-key");
    expect(models.providerForModel("ambiguous-model-x", storage)).toBe("keyed-second");
  });

  it("falls back to first-enumerated provider when nothing is keyed", () => {
    const storage = auth.createPlatformAuthStorage();
    auth.clearProviderKey(storage, "keyed-second");
    expect(models.providerForModel("ambiguous-model-x", storage)).toBe("unkeyed-first");
  });

  it("resolves single-provider ids directly without touching credentials", () => {
    // No storage passed — must not need one for the unambiguous case.
    expect(models.providerForModel("solo-model-x")).toBe("solo-prov");
  });
});
