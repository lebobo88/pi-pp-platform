/**
 * Provider/model catalog — the single source of truth for which providers
 * exist, their models + pricing, the generation ladders, and the judge pool.
 *
 * Every 3-vendor enumeration in the @pp/* layer (VENDORS, GenProvider,
 * WIRE_VENDORS, TIER_MODELS, JUDGE_POOLS, prices) is derived from this catalog
 * so that ANY of pi's ~34 providers can be enabled without code edits.
 *
 * Load order (mirrors util/prices.ts, but merges instead of seed-once):
 *   1. bundled default `packages/core/catalog.json` — always the base.
 *   2. user override `~/.pi-pp-platform/catalog.json` (dir honors
 *      PP_PLATFORM_DIR) — deep-merged over the base, winning per provider-id
 *      and per model-id. A partial user file only overrides what it names; an
 *      absent/empty one reproduces the bundled 3-vendor behavior exactly.
 */
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { log } from "../util/logger.js";

export interface CatalogModel {
  input_per_1m: number;
  output_per_1m: number;
  /** Context window size in tokens. Used by the observability layer to compute fill %. */
  context_window?: number;
  /** True when pi does NOT ship this model and it must be projected into a custom models.json. */
  custom?: boolean;
}

export interface CatalogProvider {
  display_name: string;
  /** Default true. `enabled:false` hides a provider from the wire/UI without deleting it. */
  enabled?: boolean;
  /** Display-only env var hint; pi resolves the real key ladder. */
  env_key_hint?: string;
  /** pi KnownProvider id, when it differs from the catalog key. Defaults to the key. */
  pi_provider?: string;
  models: Record<string, CatalogModel>;
}

export interface GenerationLadder {
  provider: string;
  /** Low→high tiers walked by shiftTier. */
  order: string[];
  /** Capability-gated tiers that are valid but never auto-escalated (e.g. fable). */
  off_ladder?: string[];
  /** tier name → concrete model id. */
  tiers: Record<string, string>;
  /** Copilot-mirror tier overrides, when present. */
  copilot_tiers?: Record<string, string>;
  /**
   * Optional per-tier model POOLS. When a tier has a pool, the pilot rotates
   * through it on Reflexion retry and across best-of candidates (index
   * pool[rotationIndex % pool.length]); the first attempt draws pool[0]. Entries
   * may be provider-qualified ids like "openai/gpt-5.5". A tier absent from this
   * map keeps the single-model behavior from `tiers`. Merged wholesale with the
   * rest of the ladder (a named ladder in the user catalog replaces the base
   * ladder — pools included).
   */
  tier_pools?: Record<string, string[]>;
}

export interface JudgePoolEntry {
  provider: string;
  model: string;
  escalated?: string;
}

export interface ProviderCatalog {
  version: number;
  default_ladder: string;
  generation_ladders: Record<string, GenerationLadder>;
  judge_pool: JudgePoolEntry[];
  providers: Record<string, CatalogProvider>;
}

type PriceEntry = { input: number; output: number };
type PriceTable = Record<string, Record<string, PriceEntry>>;

let _cached: ProviderCatalog | null = null;

const __dirname = dirname(fileURLToPath(import.meta.url));
// Bundled default at the package root (packages/core/catalog.json), two levels
// above {dist,src}/catalog/.
const BUNDLED_PATH = join(__dirname, "..", "..", "catalog.json");

/** Platform dir holding the user catalog + auth (honors PP_PLATFORM_DIR). */
export function platformDir(): string {
  const override = process.env.PP_PLATFORM_DIR;
  if (override && override.trim()) return override;
  return join(homedir(), ".pi-pp-platform");
}

export function userCatalogPath(): string {
  return join(platformDir(), "catalog.json");
}

function readJson(path: string): Partial<ProviderCatalog> | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8")) as Partial<ProviderCatalog>;
  } catch (err) {
    log.warn({ err, path }, "catalog.json unreadable; ignoring");
    return null;
  }
}

/** Deep-merge a (possibly partial) user catalog over the bundled base. */
function mergeCatalog(base: ProviderCatalog, over: Partial<ProviderCatalog>): ProviderCatalog {
  const providers: Record<string, CatalogProvider> = { ...base.providers };
  for (const [id, p] of Object.entries(over.providers ?? {})) {
    const prev = providers[id];
    providers[id] = prev
      ? { ...prev, ...p, models: { ...prev.models, ...(p.models ?? {}) } }
      : (p as CatalogProvider);
  }
  return {
    version: over.version ?? base.version,
    default_ladder: over.default_ladder ?? base.default_ladder,
    // A named ladder in the user file replaces that ladder wholesale.
    generation_ladders: { ...base.generation_ladders, ...(over.generation_ladders ?? {}) },
    // judge_pool is order-sensitive: user replaces it entirely when present.
    judge_pool: over.judge_pool ?? base.judge_pool,
    providers,
  };
}

const EMPTY_CATALOG: ProviderCatalog = {
  version: 1,
  default_ladder: "claude",
  generation_ladders: {},
  judge_pool: [],
  providers: {},
};

export function catalog(): ProviderCatalog {
  if (_cached) return _cached;
  const bundled = (readJson(BUNDLED_PATH) as ProviderCatalog | null) ?? EMPTY_CATALOG;
  const user = readJson(userCatalogPath());
  _cached = user ? mergeCatalog(bundled, user) : bundled;
  return _cached;
}

/** Test seam: drop the cache so the next catalog() re-reads from disk/env. */
export function refreshCatalog(): void {
  _cached = null;
}

// ─── Derivations (every hardcoded 3-vendor table folds through these) ───────

/** All provider ids present in the catalog (enabled or not). */
export function knownProviderIds(): string[] {
  return Object.keys(catalog().providers);
}

/** Provider ids that are enabled (enabled !== false). */
export function enabledProviders(): string[] {
  const { providers } = catalog();
  return Object.keys(providers).filter((id) => providers[id]!.enabled !== false);
}

/**
 * Fold a pi provider id onto its catalog provider for pricing/judge-key
 * alignment. Returns the catalog id, or null when nothing matches (the caller
 * then keeps the pi id verbatim — max flexibility, never throws).
 */
export function normalizeProviderAlias(provider: string): string | null {
  if (knownProviderIds().includes(provider)) return provider;
  const p = provider.toLowerCase();
  if (p.startsWith("openai") || p.includes("azure")) return has("openai");
  if (p.startsWith("google") || p.includes("gemini") || p.includes("vertex")) return has("google");
  if (p.startsWith("anthropic") || p.includes("claude")) return has("anthropic");
  return null;
}

function has(id: string): string | null {
  return knownProviderIds().includes(id) ? id : null;
}

export function defaultLadderName(): string {
  return catalog().default_ladder;
}

export function ladder(name?: string): GenerationLadder | undefined {
  return catalog().generation_ladders[name ?? defaultLadderName()];
}

/** tier name → model id for a ladder (default ladder when unspecified). */
export function tierModelsFor(name?: string): Record<string, string> {
  return ladder(name)?.tiers ?? {};
}

/** Copilot-mirror tier map for a ladder, falling back to its base tiers. */
export function copilotTierModelsFor(name?: string): Record<string, string> {
  const l = ladder(name);
  return l?.copilot_tiers ?? l?.tiers ?? {};
}

/** tier name → model POOL for a ladder (default ladder when unspecified). Empty when no pools configured. */
export function tierPoolsFor(name?: string): Record<string, string[]> {
  return ladder(name)?.tier_pools ?? {};
}

export function judgePool(): JudgePoolEntry[] {
  return catalog().judge_pool;
}

/** Distinct provider ids appearing in the judge pool, in pool order. */
export function judgePoolProviders(): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of judgePool()) {
    if (!seen.has(e.provider)) {
      seen.add(e.provider);
      out.push(e.provider);
    }
  }
  return out;
}

/** Env var name of a provider's kill switch, e.g. openai → PP_DISABLE_OPENAI. */
export function killSwitchEnvFor(provider: string): string {
  return `PP_DISABLE_${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/**
 * Well-known pi providers offered in the "add provider" picker even before they
 * are in the catalog. pi already ships API implementations + env-key mappings
 * for these; adding one to the catalog (with models/pricing) enables it fully.
 */
const CURATED_PI_PROVIDERS: ReadonlyArray<{ id: string; display_name: string; env_key_hint: string }> = [
  { id: "mistral", display_name: "Mistral", env_key_hint: "MISTRAL_API_KEY" },
  { id: "deepseek", display_name: "DeepSeek", env_key_hint: "DEEPSEEK_API_KEY" },
  { id: "groq", display_name: "Groq", env_key_hint: "GROQ_API_KEY" },
  { id: "xai", display_name: "xAI (Grok)", env_key_hint: "XAI_API_KEY" },
  { id: "openrouter", display_name: "OpenRouter", env_key_hint: "OPENROUTER_API_KEY" },
  { id: "together", display_name: "Together", env_key_hint: "TOGETHER_API_KEY" },
  { id: "fireworks", display_name: "Fireworks", env_key_hint: "FIREWORKS_API_KEY" },
  { id: "cerebras", display_name: "Cerebras", env_key_hint: "CEREBRAS_API_KEY" },
  { id: "moonshotai", display_name: "Moonshot (Kimi)", env_key_hint: "MOONSHOT_API_KEY" },
  { id: "nvidia", display_name: "NVIDIA", env_key_hint: "NVIDIA_API_KEY" },
  { id: "azure-openai", display_name: "Azure OpenAI", env_key_hint: "AZURE_OPENAI_API_KEY" },
  { id: "amazon-bedrock", display_name: "Amazon Bedrock", env_key_hint: "AWS_ACCESS_KEY_ID" },
  { id: "google-vertex", display_name: "Google Vertex", env_key_hint: "GOOGLE_APPLICATION_CREDENTIALS" },
];

export interface InstallableProviderInfo {
  id: string;
  display_name: string;
  env_key_hint: string | null;
  /** True when the provider already has a catalog entry (models + pricing). */
  in_catalog: boolean;
  /** True when the catalog entry is enabled. */
  enabled: boolean;
}

/** The union of catalog providers and the curated pi set, for the add-provider picker. */
export function installableProviders(): InstallableProviderInfo[] {
  const c = catalog();
  const out: InstallableProviderInfo[] = [];
  const seen = new Set<string>();
  for (const [id, p] of Object.entries(c.providers)) {
    seen.add(id);
    out.push({
      id,
      display_name: p.display_name ?? id,
      env_key_hint: p.env_key_hint ?? null,
      in_catalog: true,
      enabled: p.enabled !== false,
    });
  }
  for (const p of CURATED_PI_PROVIDERS) {
    if (seen.has(p.id)) continue;
    out.push({ id: p.id, display_name: p.display_name, env_key_hint: p.env_key_hint, in_catalog: false, enabled: false });
  }
  return out;
}

/** Model ids the catalog knows for a provider (for the ladder/judge editors). */
export function modelsForProvider(provider: string): string[] {
  return Object.keys(catalog().providers[provider]?.models ?? {});
}

/** Flatten the catalog's per-provider model pricing into a @pp/core price table. */
export function pricesFromCatalog(): PriceTable {
  const out: PriceTable = {};
  for (const [id, p] of Object.entries(catalog().providers)) {
    const models: Record<string, PriceEntry> = {};
    for (const [modelId, m] of Object.entries(p.models)) {
      models[modelId] = { input: m.input_per_1m, output: m.output_per_1m };
    }
    out[id] = models;
  }
  return out;
}
