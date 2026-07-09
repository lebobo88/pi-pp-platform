import { describe, expect, it } from "vitest";
import type { ModelInfo } from "@shared/api-types";
import {
  normalizeLadderOverrides,
  normalizeTierPoolOverrides,
  resolveProviderModelChoice,
} from "./modelRouting";

const catalogModels: ModelInfo[] = [
  { id: "gpt-5.4-mini", vendor: "openai", tier: null, input_per_1m: 0.8, output_per_1m: 2.4 },
  { id: "gpt-5.4-mini", vendor: "azure-openai", tier: null, input_per_1m: 0.9, output_per_1m: 2.7 },
  { id: "claude-sonnet-4-6", vendor: "anthropic", tier: "sonnet", input_per_1m: 3, output_per_1m: 15 },
];

const routingCatalog = {
  configuredProviders: ["openai", "azure-openai", "anthropic"],
  catalogModels,
  providerLabels: new Map([
    ["openai", "OpenAI"],
    ["azure-openai", "Azure OpenAI"],
    ["anthropic", "Anthropic"],
  ]),
};

describe("model routing canonicalization", () => {
  it("canonicalizes an unambiguous bare id to provider/model", () => {
    const resolved = resolveProviderModelChoice("claude-sonnet-4-6", routingCatalog);
    expect(resolved).toMatchObject({
      ok: true,
      provider: "anthropic",
      modelId: "claude-sonnet-4-6",
      canonical: "anthropic/claude-sonnet-4-6",
    });
  });

  it("rejects an ambiguous bare id instead of guessing a provider", () => {
    const resolved = resolveProviderModelChoice("gpt-5.4-mini", routingCatalog);
    expect(resolved).toMatchObject({
      ok: false,
      reason: "ambiguous",
      providers: ["openai", "azure-openai"],
    });
  });

  it("rejects exact duplicate provider/model entries while preserving order", () => {
    const duplicate = normalizeTierPoolOverrides(
      { sonnet: ["openai/gpt-5.4-mini", "openai/gpt-5.4-mini"] },
      routingCatalog,
    );
    expect(duplicate).toMatchObject({
      ok: false,
      tier: "sonnet",
      index: 1,
      error: "duplicate",
    });

    const normalized = normalizeTierPoolOverrides(
      { sonnet: ["openai/gpt-5.4-mini", "azure-openai/gpt-5.4-mini", "claude-sonnet-4-6"] },
      routingCatalog,
    );
    expect(normalized).toEqual({
      ok: true,
      value: {
        sonnet: [
          "openai/gpt-5.4-mini",
          "azure-openai/gpt-5.4-mini",
          "anthropic/claude-sonnet-4-6",
        ],
      },
    });
  });

  it("normalizes ladder overrides to canonical provider/model values", () => {
    const normalized = normalizeLadderOverrides(
      {
        haiku: "openai/gpt-5.4-mini",
        sonnet: "claude-sonnet-4-6",
      },
      routingCatalog,
    );
    expect(normalized).toEqual({
      ok: true,
      value: {
        haiku: "openai/gpt-5.4-mini",
        sonnet: "anthropic/claude-sonnet-4-6",
      },
    });
  });
});
