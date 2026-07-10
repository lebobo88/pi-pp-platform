/**
 * Doctor probes + the @pp/core critique-smoke attachment.
 *
 * doctorProbe() runs a 1-token completion against a provider's judge model to
 * confirm reachability + auth. attachToCore() wires cheap critique smokes into
 * @pp/core's injectable seam (setCritiqueSmokeProviders), mirroring the daemon's
 * SMOKE_ARTIFACT / SMOKE_RUBRIC.
 */
import {
  setCritiqueSmokeProviders,
  type CritiqueSmokeResult,
  type CritiqueSmokeFn,
} from "@pp/core";
import { judgePoolProviders } from "@pp/core";
import type { AuthStorage } from "@earendil-works/pi-coding-agent";
import { JUDGE_POOLS, isProviderDisabled, type ModelCatalog } from "./catalog.js";
import { listPiModels } from "./models.js";
import { resolveProviderApiKey } from "./auth.js";
import { defaultComplete, type LlmComplete } from "./llm.js";
import { critique } from "./critique.js";
import { assistantErrorMessage, classifyProviderError, type GenProvider } from "./envelope.js";
import {
  clearProviderCooldown,
  recordProviderError,
  recordProviderBalance,
  type ProviderBalanceEntry,
} from "./provider-health.js";

/** Any provider present in the catalog judge pool. */
export type ProbeProvider = string;

export interface DoctorDeps {
  catalog: ModelCatalog;
  authStorage: AuthStorage;
  /** Injected completion fn (defaults to the production pi-ai path). */
  complete?: LlmComplete;
}

export interface DoctorProbeResult {
  ok: boolean;
  latency_ms: number;
  model: string;
  provider: ProbeProvider;
  error?: string;
}

/** 1-token "Reply with OK" completion against the provider's judge model. */
export async function doctorProbe(provider: ProbeProvider, deps: DoctorDeps): Promise<DoctorProbeResult> {
  const complete = deps.complete ?? defaultComplete;
  // Prefer the provider's configured judge model; fall back to its first pi
  // model so any provider (deepseek/xai/…) can be reachability-tested.
  const modelId = JUDGE_POOLS[provider]?.default ?? listPiModels(provider)[0]?.id ?? "";
  try {
    if (!modelId) throw new Error(`no known model for provider "${provider}"`);
    const model = deps.catalog.resolve(provider, modelId);
    const apiKey = await resolveProviderApiKey(deps.authStorage, provider);
    const t0 = Date.now();
    const msg = await complete({ model, userPrompt: "Reply with OK", apiKey, maxTokens: 5, timeoutMs: 20_000 });
    // pi resolves a quota/rate/credit failure as stopReason:"error" (it never
    // rejects), so a healthy-looking probe can hide an exhausted provider.
    // Inspect the resolved message and report the real cause as ok:false.
    if (msg.stopReason === "error") {
      const errorMessage = assistantErrorMessage(msg) ?? "provider resolved stopReason=error";
      const errorClass = classifyProviderError(errorMessage);
      // Feed the health registry so cooldowns reflect a probe that hit quota/rate.
      recordProviderError(provider, errorClass, errorMessage);
      return {
        ok: false,
        latency_ms: Date.now() - t0,
        model: modelId,
        provider,
        error: `${errorClass}: ${errorMessage}`,
      };
    }
    // A healthy probe is a real success — clear any cooldown (this is exactly
    // the "successful manual probe clears state" path the /providers/:vendor/test
    // route relies on).
    clearProviderCooldown(provider);
    return { ok: true, latency_ms: Date.now() - t0, model: modelId, provider };
  } catch (err) {
    // A thrown error (auth/network) marks the provider unhealthy but sets no
    // cooldown — it is not a quota/rate signal, so routing is left untouched.
    recordProviderError(provider, "provider_error", (err as Error).message);
    return { ok: false, latency_ms: 0, model: modelId, provider, error: (err as Error).message };
  }
}

/**
 * Probe a provider's account balance where an API exists for it. Only DeepSeek
 * exposes a public balance endpoint (GET /user/balance); every other provider
 * returns undefined and the UI shows health-registry state instead. The stored
 * key is read server-side only and NEVER echoed. A successful probe is recorded
 * into the health registry as the provider's last-known balance.
 */
export async function probeProviderBalance(
  provider: ProbeProvider,
  deps: DoctorDeps,
): Promise<ProviderBalanceEntry | undefined> {
  if (provider !== "deepseek") return undefined;
  const apiKey = await resolveProviderApiKey(deps.authStorage, provider);
  if (!apiKey) return undefined;
  try {
    const res = await fetch("https://api.deepseek.com/user/balance", {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
    });
    if (!res.ok) return undefined;
    const body = (await res.json()) as {
      balance_infos?: Array<{ currency?: string; total_balance?: string }>;
    };
    const info = body.balance_infos?.[0];
    if (!info) return undefined;
    const amount = Number(info.total_balance);
    if (!Number.isFinite(amount)) return undefined;
    const balance: ProviderBalanceEntry = {
      amount,
      currency: info.currency ?? "USD",
      as_of: Date.now(),
    };
    recordProviderBalance(provider, balance);
    return balance;
  } catch {
    return undefined;
  }
}

const SMOKE_TIMEOUT_MS = 90 * 1000;
const SMOKE_ARTIFACT =
  "Smoke artifact: a tiny placeholder used to confirm the critique bridge returns a structured verdict.";
const SMOKE_RUBRIC =
  "Score 0..1 on correctness and minimality.\n" +
  "Return pass, fail, or revise according to the rubric and include a concise critique.";

function critiqueSmokeFor(provider: GenProvider, deps: DoctorDeps): CritiqueSmokeFn {
  const complete = deps.complete ?? defaultComplete;
  const modelId = JUDGE_POOLS[provider]?.default ?? "";
  return async (): Promise<CritiqueSmokeResult> => {
    const t0 = Date.now();
    try {
      const model = deps.catalog.resolve(provider, modelId);
      const apiKey = await resolveProviderApiKey(deps.authStorage, provider);
      const res = await critique({
        judgeModel: model,
        rubricMd: SMOKE_RUBRIC,
        artifactText: SMOKE_ARTIFACT,
        apiKey,
        timeoutMs: SMOKE_TIMEOUT_MS,
        complete,
      });
      const ok = res.parsed !== undefined;
      return {
        status: ok ? "ok" : "fail",
        model: modelId,
        exit_code: ok ? 0 : 1,
        wall_ms: Date.now() - t0,
        reason: ok ? undefined : res.stop_reason,
      };
    } catch (err) {
      return {
        status: "fail",
        model: modelId,
        exit_code: 1,
        wall_ms: Date.now() - t0,
        reason: (err as Error).message,
      };
    }
  };
}

/**
 * Register critique smokes into @pp/core so /pp:doctor's critique-smoke step
 * exercises the real pi judge path. Covers every catalog judge-pool provider
 * except anthropic (which runs in-process) and any provider disabled via its
 * kill switch. For the default catalog this is exactly {openai, google}.
 */
export function attachToCore(deps: DoctorDeps): void {
  const smokes: Record<string, CritiqueSmokeFn> = {};
  for (const provider of judgePoolProviders()) {
    if (provider === "anthropic") continue;
    if (isProviderDisabled(provider)) continue;
    smokes[provider] = critiqueSmokeFor(provider, deps);
  }
  setCritiqueSmokeProviders(smokes);
}
