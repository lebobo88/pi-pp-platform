import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the platform dir BEFORE the engine/core modules load (their catalog
// tables are built at import time), and add ONE custom model via the user
// catalog override so the models.json projection has something to emit.
const platform = mkdtempSync(join(tmpdir(), "pp-eng-cat-"));
process.env.PP_PLATFORM_DIR = platform;
process.env.PP_SKIP_CLI_VERSIONS = "1";
writeFileSync(
  join(platform, "catalog.json"),
  JSON.stringify({
    providers: {
      anthropic: {
        models: { "claude-test-custom": { input_per_1m: 1.5, output_per_1m: 6, custom: true } },
      },
    },
  }),
  "utf8",
);

let core: typeof import("@pp/core");
let engine: typeof import("../src/index.js");
let projection: typeof import("../src/catalog-to-modelsjson.js");
let pi: typeof import("@earendil-works/pi-coding-agent");

beforeAll(async () => {
  core = await import("@pp/core");
  engine = await import("../src/index.js");
  projection = await import("../src/catalog-to-modelsjson.js");
  pi = await import("@earendil-works/pi-coding-agent");
});

describe("all-35 provider catalog", () => {
  it("enables every pi provider while keeping the curated big-3 blocks", () => {
    const enabled = core.enabledProviders();
    expect(enabled).toHaveLength(35);
    for (const id of ["openai", "google", "anthropic", "mistral", "openrouter", "github-copilot"]) {
      expect(enabled).toContain(id);
    }
    // Curated pricing untouched by the generator (verified 2026-07-03 rates).
    const c = core.catalog();
    expect(c.providers.openai!.models["gpt-5.4"]!.input_per_1m).toBe(2.5);
    expect(c.providers.google!.models["gemini-2.5-flash"]!.output_per_1m).toBe(2.5);
    expect(c.providers.anthropic!.models["claude-fable-5"]!.output_per_1m).toBe(50);
    // Generated entries are enabled; curated custom models (pi lacks them) survive regeneration.
    expect(c.providers.mistral).toMatchObject({ enabled: true, pi_provider: "mistral" });
    expect(c.providers.mistral!.models["mistral-large-3"]).toMatchObject({ custom: true, input_per_1m: 0.5 });
    expect(c.providers.deepseek).toMatchObject({ enabled: true, pi_provider: "deepseek", models: {} });
  });

  it("judge pool + eligibility still resolve over the big catalog", () => {
    expect(core.judgePoolProviders()).toEqual(["openai", "google", "anthropic"]);
    expect(engine.eligibleJudgeProviders("anthropic", true)).toEqual(["openai", "google"]);
    // A newly enabled provider is never in the judge pool, so cross-vendor
    // judging for it keeps the full pool.
    expect(engine.eligibleJudgeProviders("mistral", true)).toEqual(["openai", "google", "anthropic"]);
  });

  it("providerForModel fallbacks hold", () => {
    // Shared model ids may resolve to any pi provider that ships them (e.g.
    // gpt-5.4 also ships under azure-openai-responses) — but always to a real
    // owner of the model.
    const owner = engine.providerForModel("gpt-5.4");
    expect(engine.listPiModels(owner).some((m) => m.id === "gpt-5.4")).toBe(true);
    expect(engine.providerForModel("claude-fable-5")).toBe("anthropic");
    const mistralModel = engine.listPiModels("mistral")[0];
    expect(mistralModel).toBeTruthy();
    expect(engine.providerForModel(mistralModel!.id)).toBe("mistral");
    // Catalog-declared custom model folds onto its catalog provider.
    expect(engine.providerForModel("claude-test-custom")).toBe("anthropic");
    // Unknown ids fall back through the alias fold to anthropic.
    expect(engine.providerForModel("totally-unknown-model-xyz")).toBe("anthropic");
  });
});

describe("models.json projection (pi 0.80.3 schema)", () => {
  it("emits the providers/models shape pi's ModelRegistry validates", () => {
    projection.resetProjectedModelsJson();
    const path = projection.projectCatalogModelsJson();
    expect(path).toBeTruthy();
    const written = JSON.parse(readFileSync(path!, "utf8")) as {
      providers: Record<string, { models: Array<Record<string, unknown>> }>;
    };
    const def = written.providers.anthropic!.models[0]!;
    expect(def).toMatchObject({
      id: "claude-test-custom",
      reasoning: false,
      cost: { input: 1.5, output: 6, cacheRead: 1.5 * 0.1, cacheWrite: 1.5 * 1.25 },
      contextWindow: 128000,
      maxTokens: 16384,
    });
  });

  it("passes pi's ModelRegistry schema validation and resolves the custom model", () => {
    const registry = pi.ModelRegistry.create(pi.AuthStorage.inMemory(), projection.projectCatalogModelsJson());
    expect(registry.getError()).toBeUndefined();
    const model = registry.find("anthropic", "claude-test-custom");
    expect(model).toBeTruthy();
    expect(model!.cost.input).toBe(1.5);
    // api/baseUrl inherited from pi's built-in anthropic models.
    expect(model!.api).toBe("anthropic-messages");
    expect(model!.baseUrl).toContain("anthropic.com");
    // And pi-shipped models are still resolvable alongside the custom one.
    expect(registry.find("anthropic", "claude-opus-4-7")).toBeTruthy();
  });

  it("resolves the custom model through the engine ModelCatalog", () => {
    projection.resetProjectedModelsJson();
    const modelCatalog = new engine.ModelCatalog(pi.AuthStorage.inMemory());
    const m = modelCatalog.resolve("anthropic", "claude-test-custom");
    expect(m.id).toBe("claude-test-custom");
    expect(m.provider).toBe("anthropic");
  });
});
