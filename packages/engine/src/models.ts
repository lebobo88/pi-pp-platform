/**
 * pi builtin model catalog access.
 *
 * pi ships a complete, versioned model catalog for ~38 providers (anthropic,
 * openai, google, deepseek, xai, groq, mistral, openrouter, …) with pricing and
 * context windows — regenerated each pi release. We source the provider + model
 * lists (and pricing) from here rather than hand-maintaining them, so the
 * platform's catalog is always as complete and current as the installed pi.
 *
 * `refreshPiModels()` triggers pi's live model discovery for dynamic providers
 * (fetches the latest list from the provider endpoint when a credential exists).
 */
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { catalog, normalizeProviderAlias, detectCliLogin, CLI_LOGIN_PROVIDERS } from "@pp/core";
import type { AuthStorage } from "@earendil-works/pi-coding-agent";
import { createPlatformAuthStorage } from "./auth.js";

export interface PiModelInfo {
  id: string;
  provider: string;
  name?: string;
  /** USD per 1M input tokens (pi cost.input). */
  input_per_1m: number;
  /** USD per 1M output tokens (pi cost.output). */
  output_per_1m: number;
  context_window?: number;
  reasoning?: boolean;
}

// The builtin catalog is static; build the collection once.
let _models: ReturnType<typeof builtinModels> | null = null;
function models() {
  if (!_models) _models = builtinModels();
  return _models;
}

/** Env var pi reads a provider's key from (display hint; pi resolves the real
 * key via its own ladder). null for providers without a well-known single var. */
const PI_ENV_HINTS: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  "google-vertex": "GOOGLE_APPLICATION_CREDENTIALS",
  deepseek: "DEEPSEEK_API_KEY",
  xai: "XAI_API_KEY",
  groq: "GROQ_API_KEY",
  mistral: "MISTRAL_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  together: "TOGETHER_API_KEY",
  fireworks: "FIREWORKS_API_KEY",
  cerebras: "CEREBRAS_API_KEY",
  moonshotai: "MOONSHOT_API_KEY",
  nvidia: "NVIDIA_API_KEY",
  "azure-openai": "AZURE_OPENAI_API_KEY",
  "amazon-bedrock": "AWS_ACCESS_KEY_ID",
  huggingface: "HF_TOKEN",
  minimax: "MINIMAX_API_KEY",
  zai: "ZAI_API_KEY",
  "github-copilot": "COPILOT_GITHUB_TOKEN",
};

export function piEnvKeyHint(provider: string): string | null {
  return PI_ENV_HINTS[provider] ?? null;
}

/** All provider ids pi ships a catalog for. */
export function listPiProviders(): string[] {
  try {
    return models().getProviders().map((p) => p.id);
  } catch {
    return [];
  }
}

interface RawPiModel {
  id: string;
  provider?: string;
  name?: string;
  cost?: { input?: number; output?: number };
  contextWindow?: number;
  reasoning?: boolean;
}

function mapModel(m: RawPiModel, provider: string): PiModelInfo {
  return {
    id: m.id,
    provider: m.provider ?? provider,
    name: m.name,
    input_per_1m: m.cost?.input ?? 0,
    output_per_1m: m.cost?.output ?? 0,
    context_window: m.contextWindow,
    reasoning: m.reasoning,
  };
}

/** pi's builtin models for one provider (empty when pi has no catalog for it). */
export function listPiModels(provider: string): PiModelInfo[] {
  try {
    return (models().getModels(provider) as unknown as RawPiModel[]).map((m) => mapModel(m, provider));
  } catch {
    return [];
  }
}

/** pi's builtin models across every provider. */
export function allPiModels(): PiModelInfo[] {
  try {
    return (models().getModels() as unknown as RawPiModel[]).map((m) => mapModel(m, m.provider ?? ""));
  } catch {
    return [];
  }
}

let _modelProvidersMap: Map<string, string[]> | null = null;

/** Every provider that serves a given model id, in catalog enumeration order. */
function providersForModelId(modelId: string): string[] {
  if (!_modelProvidersMap) {
    _modelProvidersMap = new Map();
    const add = (id: string, provider: string) => {
      const list = _modelProvidersMap!.get(id);
      if (!list) _modelProvidersMap!.set(id, [provider]);
      else if (!list.includes(provider)) list.push(provider);
    };
    for (const m of allPiModels()) add(m.id, m.provider);
    for (const [provider, p] of Object.entries(catalog().providers)) {
      for (const id of Object.keys(p.models)) add(id, provider);
    }
  }
  return _modelProvidersMap.get(modelId) ?? [];
}

/** Lazy default storage for credential-aware resolution (tests inject their own). */
let _resolverStorage: AuthStorage | null = null;
function resolverStorage(): AuthStorage {
  if (!_resolverStorage) {
    _resolverStorage = createPlatformAuthStorage();
  }
  return _resolverStorage;
}

/**
 * Split a provider-qualified model id ("openai/gpt-5.5" → openai + gpt-5.5).
 * The prefix must name a KNOWN provider — openrouter-style ids whose first
 * segment is an org name ("meta-llama/llama-3…") pass through untouched.
 */
export function splitQualifiedModelId(id: string): { provider: string | null; model: string } {
  const slash = id.indexOf("/");
  if (slash > 0) {
    const prefix = id.slice(0, slash);
    const known =
      Object.prototype.hasOwnProperty.call(catalog().providers, prefix) ||
      allPiModels().some((m) => m.provider === prefix);
    if (known) return { provider: prefix, model: id.slice(slash + 1) };
  }
  return { provider: null, model: id };
}

/**
 * The provider that owns a given model id (pi catalog ∪ platform catalog
 * customs). A provider-qualified id ("openai/gpt-5.5") pins the provider
 * outright. Otherwise, ambiguous ids (served by several vendors — every
 * gpt-* id exists under azure-openai-responses, github-copilot, openai-codex,
 * …) prefer a provider that actually holds a credential, so a keyed
 * openai/openai-codex wins over an unkeyed azure that merely enumerates
 * first. Falls back to a provider-alias fold, else "anthropic".
 */
export function providerForModel(modelId: string, storage?: AuthStorage): string {
  const qualified = splitQualifiedModelId(modelId);
  if (qualified.provider) return qualified.provider;
  const providers = providersForModelId(modelId);
  if (providers.length === 0) return normalizeProviderAlias(modelId) ?? "anthropic";
  if (providers.length === 1) return providers[0]!;
  let auth: AuthStorage;
  try {
    auth = storage ?? resolverStorage();
  } catch {
    return providers[0]!;
  }
  for (const p of providers) {
    if (hasCredential(auth, p)) return p;
  }
  return providers[0]!;
}

/** True when a provider has a usable stored/ambient credential (no key exposed). */
export function hasCredential(storage: AuthStorage, provider: string): boolean {
  try {
    return storage.getAuthStatus(provider).configured;
  } catch {
    return false;
  }
}

/**
 * Providers that currently have a stored/ambient credential, among a candidate
 * set (defaults to every pi provider). Uses AuthStorage.getAuthStatus, which
 * does not expose the key.
 *
 * NOTE: this is the "pi can actually resolve a usable key" set — it gates
 * generation preflight (stage-loop / best-of) and judge eligibility, so it must
 * NOT include merely CLI-logged-in providers pi cannot obtain a token for. Use
 * {@link providersWithCliLogin} for visibility/display instead.
 */
export function providersWithCredential(storage: AuthStorage, candidates?: string[]): string[] {
  const ids = candidates ?? listPiProviders();
  const out: string[] = [];
  for (const id of ids) {
    try {
      if (storage.getAuthStatus(id).configured) out.push(id);
    } catch {
      /* provider not resolvable — skip */
    }
  }
  return out;
}

/**
 * Providers with a locally logged-in vendor CLI / subscription session (presence
 * detection only — see providers/cli-login.ts). This is a DISPLAY/visibility
 * signal: a provider here should get a card, but it is NOT necessarily usable
 * for generation (that still requires a resolvable credential — see
 * {@link providersWithCredential}). Defaults to the known CLI-login providers.
 */
export function providersWithCliLogin(candidates?: readonly string[]): string[] {
  const ids = candidates ?? CLI_LOGIN_PROVIDERS;
  return ids.filter((id) => detectCliLogin(id).loggedIn);
}

/** Result of `refreshPiModels`: the model list plus whether a live refresh ran. */
export interface PiModelRefreshResult {
  models: PiModelInfo[];
  /** True only when the provider supports live discovery AND the fetch succeeded. */
  refreshed: boolean;
}

/**
 * Best-effort live model refresh for a dynamic provider (fetches the latest
 * model list from the endpoint when a credential is present). Returns the
 * refreshed model list with `refreshed: true`, or the static list with
 * `refreshed: false` when the provider is static / offline.
 */
export async function refreshPiModels(provider: string): Promise<PiModelRefreshResult> {
  let refreshed = false;
  try {
    const prov = models().getProvider(provider) as
      | { refreshModels?: () => Promise<unknown> }
      | undefined;
    if (prov?.refreshModels) {
      await prov.refreshModels();
      refreshed = true;
    }
  } catch {
    /* refresh unsupported / offline — fall back to the static catalog */
  }
  return { models: listPiModels(provider), refreshed };
}
