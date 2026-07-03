/**
 * Project catalog-declared models that pi does NOT ship into a models.json that
 * pi's ModelRegistry can merge (custom wins by provider+id).
 *
 * A model is projected when it is flagged `custom: true` in the catalog. For the
 * default catalog (every model is pi-shipped) there is nothing to project and
 * this returns undefined — so ModelRegistry.create(authStorage, undefined)
 * behaves exactly as before.
 *
 * Schema verified against pi 0.80.3 (pi-coding-agent dist/core/model-registry.js,
 * ModelsConfigSchema): the file is `{ providers: { <id>: { baseUrl?, api?,
 * models: ModelDefinition[] } } }`. Each ModelDefinition needs `id`; for pi
 * built-in providers `api`/`baseUrl` are inherited from the provider's built-in
 * models, while non-built-in providers must set `baseUrl` (provider level) and
 * `api` (provider or model level). `cost` must carry all four of
 * input/output/cacheRead/cacheWrite; `contextWindow`/`maxTokens` default below
 * to the same values pi applies when they are omitted (128000 / 16384).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { catalog, platformDir, type CatalogModel, type CatalogProvider } from "@pp/core";

/** Optional per-model fields the catalog MAY carry for custom models. */
type ProjectableCatalogModel = CatalogModel & {
  display_name?: string;
  api?: string;
  base_url?: string;
  reasoning?: boolean;
  context_window?: number;
  max_tokens?: number;
  cache_read_per_1m?: number;
  cache_write_per_1m?: number;
};

/** Optional provider-level fields for non-pi-built-in providers. */
type ProjectableCatalogProvider = CatalogProvider & { api?: string; base_url?: string };

/** One entry of pi's ModelDefinitionSchema (models.json providers.<id>.models[]). */
interface ProjectedModel {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

interface ProjectedProvider {
  api?: string;
  baseUrl?: string;
  models: ProjectedModel[];
}

// pi's own parseModels defaults, kept in lock-step so explicit === implicit.
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;

function projectModel(id: string, m: ProjectableCatalogModel): ProjectedModel {
  return {
    id,
    ...(m.display_name ? { name: m.display_name } : {}),
    ...(m.api ? { api: m.api } : {}),
    ...(m.base_url ? { baseUrl: m.base_url } : {}),
    reasoning: m.reasoning ?? false,
    cost: {
      input: m.input_per_1m,
      output: m.output_per_1m,
      // Cache pricing is provider-specific; default to the Anthropic-style
      // multipliers (conservative on writes) unless the catalog overrides.
      cacheRead: m.cache_read_per_1m ?? m.input_per_1m * 0.1,
      cacheWrite: m.cache_write_per_1m ?? m.input_per_1m * 1.25,
    },
    contextWindow: m.context_window ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: m.max_tokens ?? DEFAULT_MAX_TOKENS,
  };
}

let _cachedPath: string | null | undefined;

/** Returns the models.json path, or undefined when there is nothing custom to project. */
export function projectCatalogModelsJson(): string | undefined {
  if (_cachedPath !== undefined) return _cachedPath ?? undefined;

  const c = catalog();
  const providers: Record<string, ProjectedProvider> = {};
  let projected = 0;
  for (const [providerId, raw] of Object.entries(c.providers)) {
    const p = raw as ProjectableCatalogProvider;
    const piProvider = p.pi_provider ?? providerId;
    for (const [id, m] of Object.entries(p.models)) {
      if (!m.custom) continue;
      const entry = (providers[piProvider] ??= {
        ...(p.api ? { api: p.api } : {}),
        ...(p.base_url ? { baseUrl: p.base_url } : {}),
        models: [],
      });
      entry.models.push(projectModel(id, m as ProjectableCatalogModel));
      projected++;
    }
  }

  if (projected === 0) {
    _cachedPath = null;
    return undefined;
  }

  try {
    const dir = platformDir();
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "models.json");
    writeFileSync(path, JSON.stringify({ providers }, null, 2), "utf8");
    _cachedPath = path;
    return path;
  } catch {
    // Best-effort: if projection fails, fall back to pi's built-in registry.
    _cachedPath = null;
    return undefined;
  }
}

/** Test seam. */
export function resetProjectedModelsJson(): void {
  _cachedPath = undefined;
}
