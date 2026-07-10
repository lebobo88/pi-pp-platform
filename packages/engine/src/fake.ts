/**
 * Deterministic, zero-token fakes + the createEngine factory.
 *
 * - FakeLlm: a deterministic {@link LlmComplete}. (rolePromptHash, callCount) ->
 *   fixture text. When the system prompt is a judge prompt it emits a
 *   schema-valid critique verdict - so the fake critique path still flows
 *   through the REAL validateCritiqueResult in critique.ts.
 * - FakeCodegenSession: writes a fixture file into cwd and commits it, matching
 *   the runCodingSession signature.
 * - createEngine({ mode }): returns the uniform engine surface for "pi" or "fake".
 *
 * The fakes build AssistantMessages by hand (rather than the pi-ai faux helpers)
 * so every usage field is a concrete number - buildGenResult stays NaN-free.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AssistantMessage } from "@earendil-works/pi-ai/compat";
import { critique, type CritiqueOpts } from "./critique.js";
import { runAuthoringCompletion, type AuthoringCompletionOpts } from "./generate-completion.js";
import { runCodingSession, type CodingSessionOpts } from "./generate-session.js";
import { buildGenResultFromTotals, toGenProvider, type GenResult } from "./envelope.js";
import { ModelCatalog, JUDGE_POOLS } from "./catalog.js";
import { makeSessionRef } from "./session-store.js";
import { createPlatformAuthStorage, resolveProviderApiKey } from "./auth.js";
import { doctorProbe, probeProviderBalance, attachToCore, type DoctorProbeResult, type ProbeProvider, type DoctorDeps } from "./doctor.js";
import { recordProviderResult, type ProviderBalanceEntry } from "./provider-health.js";
import type { LlmComplete } from "./llm.js";
import { AuthStorage } from "@earendil-works/pi-coding-agent";

/** Update the provider-health registry from a result, then return it. Wrapped
 * around every engine generation/critique/coding-session result so cooldowns
 * and health chips reflect what actually happened, for both real and fake
 * engines. */
async function recorded(p: Promise<GenResult>): Promise<GenResult> {
  const r = await p;
  recordProviderResult(r);
  return r;
}

/** pi's stop-reason union, derived from the message type so we never depend on
 * a separately-exported name that may drift across pi versions. */
type StopReason = AssistantMessage["stopReason"];

// --- deterministic helpers ---------------------------------------------------

/** djb2 string hash -> unsigned 32-bit. */
export function hashPrompt(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h >>> 0;
}

/**
 * Build a deterministic AssistantMessage. `opts` is additive: existing callers
 * pass only `text` and get a `stopReason:"stop"` message exactly as before.
 * Tests exercising the provider-error path pass `{ stopReason:"error",
 * errorMessage }` - pi resolves (never rejects) quota/rate failures this way, and
 * the real 0.80.3 type carries `errorMessage`, which the local fake omitted.
 */
function fakeAssistant(
  text: string,
  opts?: { stopReason?: StopReason; errorMessage?: string },
): AssistantMessage {
  const msg: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "fake",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: opts?.stopReason ?? "stop",
    timestamp: Date.now(),
  };
  // Attach errorMessage without an object-literal excess-property check - the
  // real 0.80.3 type declares it, but we stay robust if a compat re-export lags.
  if (opts?.errorMessage !== undefined) {
    (msg as { errorMessage?: string }).errorMessage = opts.errorMessage;
  }
  return msg;
}

/**
 * A deterministic error-resolving AssistantMessage (stopReason:"error" +
 * errorMessage), matching how pi surfaces a quota/rate/credit failure. Exported
 * so engine and pilot tests can drive the provider-error path through the real
 * envelope/critique/doctor code without a network.
 */
export function makeErroredAssistant(errorMessage: string): AssistantMessage {
  return fakeAssistant("", { stopReason: "error", errorMessage });
}

// --- FakeLlm -----------------------------------------------------------------

export class FakeLlm {
  private callCount = 0;

  /** A deterministic LlmComplete usable as the DI seam in critique/authoring. */
  readonly complete: LlmComplete = async (args) => {
    const retryIndex = this.callCount++;
    const seed = hashPrompt(`${args.systemPrompt ?? ""} ${args.userPrompt}`);
    const isJudge = (args.systemPrompt ?? "").toLowerCase().includes("impartial");
    if (isJudge) {
      return fakeAssistant(this.verdictJson(seed));
    }
    return fakeAssistant(`FAKE COMPLETION seed=${seed} retry=${retryIndex}\n${args.userPrompt.slice(0, 80)}`);
  };

  /** Deterministic schema-valid verdict JSON for a seed. */
  private verdictJson(seed: number): string {
    const outcome = seed % 3 === 0 ? "pass" : seed % 3 === 1 ? "revise" : "fail";
    const score = 0.5 + (seed % 50) / 100; // 0.50 .. 0.99
    const verdict = {
      outcome,
      critique_md: `Fake verdict for seed ${seed}.`,
      score_entries: [
        { dimension: "correctness", score: Math.min(1, score) },
        { dimension: "minimality", score: Math.min(1, 1 - (seed % 30) / 100) },
      ],
    };
    return JSON.stringify(verdict);
  }
}

// --- FakeCodegenSession ------------------------------------------------------

/**
 * Deterministic coding session: writes a fixture artifact into cwd and commits
 * it. Matches the runCodingSession signature. Ignores auth/model-registry.
 */
export async function fakeCodingSession(opts: CodingSessionOpts): Promise<GenResult> {
  const ref = makeSessionRef(opts.sessionDir, opts.role ?? "coder", opts.attempt ?? 0);
  const seed = hashPrompt(`${opts.systemPrompt} ${opts.taskPrompt}`);
  const t0 = Date.now();

  opts.onEvent?.({ type: "agent_start" } as never);

  const fileName = `FAKE_ARTIFACT_${ref.id}.md`;
  const filePath = join(opts.cwd, fileName);
  const content = `# Fake artifact (${ref.id})\n\nseed: ${seed}\n\n${opts.taskPrompt.slice(0, 200)}\n`;
  writeFileSync(filePath, content, "utf8");

  const git = (args: string[]): void => {
    execFileSync("git", ["-c", "user.email=fake@pp.local", "-c", "user.name=pp-fake", ...args], {
      cwd: opts.cwd,
      stdio: "ignore",
    });
  };
  git(["add", "-A"]);
  git(["commit", "-m", `fake: ${ref.id}`]);

  opts.onEvent?.({ type: "agent_end", messages: [], willRetry: false } as never);

  const text = `Wrote ${fileName} and committed.`;
  return buildGenResultFromTotals(
    opts.model,
    { tokens_in: 0, tokens_out: 0, cost_usd: 0 },
    {
      text,
      wall_ms: Date.now() - t0,
      session_id: ref.id,
      session_file: ref.path,
      stop_reason: "stop",
      tool_call_count: 1,
      files_changed: true,
      materialized_files: 0,
    },
  );
}

// --- Engine factory ----------------------------------------------------------

export interface Engine {
  /** "pi" = real providers (credentials required); "fake" = deterministic, no keys. */
  mode: "pi" | "fake";
  critique(opts: CritiqueOpts): Promise<GenResult>;
  runAuthoringCompletion(opts: AuthoringCompletionOpts): Promise<GenResult>;
  runCodingSession(opts: CodingSessionOpts): Promise<GenResult>;
  catalog: ModelCatalog;
  authStorage: AuthStorage;
  doctorProbe(provider: ProbeProvider): Promise<DoctorProbeResult>;
  /** Probe a provider's account balance where an API exists (DeepSeek only
   * today); undefined otherwise. Never echoes the stored key. */
  probeProviderBalance(provider: ProbeProvider): Promise<ProviderBalanceEntry | undefined>;
  /** Register critique smokes into @pp/core. */
  attachToCore(): void;
}

const CreateEngineOptions = z.object({ mode: z.enum(["pi", "fake"]) });
export type CreateEngineOptions = z.infer<typeof CreateEngineOptions>;

export function createEngine(options: CreateEngineOptions): Engine {
  const { mode } = CreateEngineOptions.parse(options);

  if (mode === "fake") {
    const authStorage = AuthStorage.inMemory();
    const catalog = new ModelCatalog(authStorage);
    const fake = new FakeLlm();
    const deps: DoctorDeps = { catalog, authStorage, complete: fake.complete };
    return {
      mode: "fake",
      catalog,
      authStorage,
      critique: (opts) => recorded(critique({ ...opts, complete: opts.complete ?? fake.complete })),
      runAuthoringCompletion: (opts) =>
        recorded(runAuthoringCompletion({ ...opts, complete: opts.complete ?? fake.complete })),
      runCodingSession: (opts) => recorded(fakeCodingSession(opts)),
      doctorProbe: (provider) => doctorProbe(provider, deps),
      probeProviderBalance: (provider) => probeProviderBalance(provider, deps),
      attachToCore: () => attachToCore(deps),
    };
  }

  // mode === "pi"
  const authStorage = createPlatformAuthStorage();
  const catalog = new ModelCatalog(authStorage);
  const deps: DoctorDeps = { catalog, authStorage };

  const withResolvedKey = async <T extends { apiKey?: string }>(
    provider: string,
    opts: T,
  ): Promise<T & { apiKey?: string }> => {
    if (opts.apiKey) return opts;
    const apiKey = await resolveProviderApiKey(authStorage, provider);
    return { ...opts, apiKey };
  };

  return {
    mode: "pi",
    catalog,
    authStorage,
    critique: async (opts) => recorded(critique(await withResolvedKey(opts.judgeModel.provider, opts))),
    runAuthoringCompletion: async (opts) =>
      recorded(runAuthoringCompletion(await withResolvedKey(opts.model.provider, opts))),
    runCodingSession: (opts) =>
      recorded(
        runCodingSession({
          ...opts,
          authStorage: opts.authStorage ?? authStorage,
          modelRegistry: opts.modelRegistry ?? catalog.registry,
        }),
      ),
    doctorProbe: (provider) => doctorProbe(provider, deps),
    probeProviderBalance: (provider) => probeProviderBalance(provider, deps),
    attachToCore: () => attachToCore(deps),
  };
}

// re-export for convenience
export { toGenProvider };
