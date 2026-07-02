import { describe, it, expect } from "vitest";

// Import every pi symbol the engine depends on — this test fails to compile if
// the 0.80.3 surface drifts from what the engine assumes.
import {
  AuthStorage,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
  createAgentSession,
  createReadOnlyTools,
  createBashToolDefinition,
  createWriteToolDefinition,
  createEditToolDefinition,
  defineTool,
  getLastAssistantUsage,
  type CreateAgentSessionOptions,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  completeSimple,
  registerBuiltInApiProviders,
  calculateCost,
  getModel,
  type Model,
  type Api,
  type AssistantMessage,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";

import {
  ModelCatalog,
  TIER_MODELS,
  JUDGE_POOLS,
  type CritiqueOpts,
  type CodingSessionOpts,
  type AuthoringCompletionOpts,
  type GenResult,
} from "../src/index.js";

// ── Type-level option-bag checks (compile-time assertions) ───────────────────

// createAgentSession option bag we actually pass.
const _agentOpts: CreateAgentSessionOptions = {
  cwd: ".",
  agentDir: ".",
  noTools: "all",
  customTools: [] as ToolDefinition[],
};
void _agentOpts;

// completeSimple option bag.
const _streamOpts: SimpleStreamOptions = {
  apiKey: "k",
  reasoning: "high",
  timeoutMs: 1000,
};
void _streamOpts;

// Engine option bags carry the fields the orchestrator will pass.
type _CritiqueHasFields = Pick<CritiqueOpts, "judgeModel" | "rubricMd" | "artifactText" | "signal" | "timeoutMs">;
type _CodingHasFields = Pick<CodingSessionOpts, "cwd" | "systemPrompt" | "taskPrompt" | "model" | "sessionDir" | "toolPolicy">;
type _AuthoringHasFields = Pick<AuthoringCompletionOpts, "model" | "systemPrompt" | "userPrompt">;
const _c: keyof _CritiqueHasFields = "judgeModel";
const _s: keyof _CodingHasFields = "toolPolicy";
const _a: keyof _AuthoringHasFields = "userPrompt";
void _c; void _s; void _a;

// Keep the imported values referenced so the import isn't elided.
void [SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession,
  createReadOnlyTools, createBashToolDefinition, createWriteToolDefinition,
  createEditToolDefinition, defineTool, getLastAssistantUsage, completeSimple,
  registerBuiltInApiProviders, calculateCost, getModel, ModelRegistry];

// ── Runtime catalog checks ───────────────────────────────────────────────────

const PINNED: Array<{ provider: string; id: string }> = [
  { provider: "anthropic", id: "claude-fable-5" },
  { provider: "anthropic", id: "claude-opus-4-7" },
  { provider: "anthropic", id: "claude-sonnet-4-6" },
  { provider: "anthropic", id: "claude-haiku-4-5-20251001" },
  { provider: "openai", id: "gpt-5.4" },
  { provider: "openai", id: "gpt-5.5" },
  { provider: "google", id: "gemini-3.1-pro-preview" },
];

describe("ModelCatalog", () => {
  const catalog = new ModelCatalog(AuthStorage.inMemory());

  it("resolves all 7 pinned models from the builtin catalog", () => {
    for (const { provider, id } of PINNED) {
      const model: Model<Api> = catalog.resolve(provider, id);
      expect(model.id).toBe(id);
      expect(model.provider).toBe(provider);
    }
  });

  it("exposes claude-fable-5 with cost { input: 10, output: 50 }", () => {
    const fable = catalog.resolveTier("fable");
    expect(fable.id).toBe("claude-fable-5");
    expect(fable.cost.input).toBe(10);
    expect(fable.cost.output).toBe(50);
  });

  it("maps every tier to a resolvable model", () => {
    for (const tier of Object.keys(TIER_MODELS) as Array<keyof typeof TIER_MODELS>) {
      const m = catalog.resolveTier(tier);
      expect(m.id).toBe(TIER_MODELS[tier].id);
    }
  });

  it("judge pools point at builtin models", () => {
    expect(catalog.resolve("openai", JUDGE_POOLS.openai.default).id).toBe("gpt-5.4");
    expect(catalog.resolve("openai", JUDGE_POOLS.openai.escalated).id).toBe("gpt-5.5");
    expect(catalog.resolve("google", JUDGE_POOLS.google.default).id).toBe("gemini-3.1-pro-preview");
    expect(catalog.resolve("anthropic", JUDGE_POOLS.anthropic.default).id).toBe("claude-opus-4-7");
  });
});
