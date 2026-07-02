/**
 * Single-shot completion seam.
 *
 * Wraps pi-ai/compat `completeSimple` with a linked abort + timeout race and a
 * uniform arg bag. The `LlmComplete` type is the dependency-injection point the
 * critique/authoring paths accept so tests can drive canned AssistantMessages
 * without any network.
 */
import {
  completeSimple,
  registerBuiltInApiProviders,
  type AssistantMessage,
  type Model,
  type Api,
  type ThinkingLevel,
} from "@earendil-works/pi-ai/compat";

export interface LlmCallArgs {
  model: Model<Api>;
  systemPrompt?: string;
  userPrompt: string;
  apiKey?: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  reasoning?: ThinkingLevel;
  /** Cap on generated tokens (doctor probes use a tiny value). */
  maxTokens?: number;
}

export type LlmComplete = (args: LlmCallArgs) => Promise<AssistantMessage>;

let _providersRegistered = false;
/** Idempotently register the builtin API implementations (needed by compat dispatch). */
export function ensureProvidersRegistered(): void {
  if (_providersRegistered) return;
  registerBuiltInApiProviders();
  _providersRegistered = true;
}

/**
 * Build an AbortController that fires when either the external signal aborts or
 * the timeout elapses. Returns a cleanup to clear the timer and detach the
 * listener. `timedOut` reports whether the timeout (not the caller) fired.
 */
export function withTimeout(signal: AbortSignal | undefined, timeoutMs: number | undefined): {
  controller: AbortController;
  cleanup: () => void;
  timedOut: () => boolean;
} {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let didTimeout = false;

  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  if (timeoutMs && timeoutMs > 0) {
    timer = setTimeout(() => {
      didTimeout = true;
      controller.abort(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  }

  return {
    controller,
    cleanup: () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
    timedOut: () => didTimeout,
  };
}

/** The production LlmComplete: pi-ai/compat completeSimple with abort + timeout. */
export const defaultComplete: LlmComplete = async (args) => {
  ensureProvidersRegistered();
  const { controller, cleanup } = withTimeout(args.signal, args.timeoutMs);
  try {
    return await completeSimple(
      args.model,
      {
        systemPrompt: args.systemPrompt,
        messages: [{ role: "user", content: args.userPrompt, timestamp: Date.now() }],
      },
      {
        apiKey: args.apiKey,
        headers: args.headers,
        signal: controller.signal,
        reasoning: args.reasoning,
        timeoutMs: args.timeoutMs,
        ...(args.maxTokens ? { maxTokens: args.maxTokens } : {}),
      },
    );
  } finally {
    cleanup();
  }
};
