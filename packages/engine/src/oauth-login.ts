/**
 * Subscription (OAuth) login for pi-native OAuth providers.
 *
 * pi ships OAuth login flows for `anthropic`, `github-copilot`, and
 * `openai-codex` (device-code + PKCE). Running `AuthStorage.login(id, cbs)`
 * drives the flow interactively and, on success, persists a `{type:"oauth"}`
 * credential into the platform auth.json — after which `getAuthStatus(id)`
 * reports `configured:true` and the existing key-resolution ladder can generate
 * on the subscription (no generate-path change needed).
 *
 * The flow is interactive (it surfaces a browser URL and/or a device code, and
 * some providers ask the user to paste a verification code back). We adapt pi's
 * callbacks onto a small, pi-free handle so the server can expose it over REST +
 * SSE without importing pi types: start → surface state → (optionally) provide
 * one input → await completion.
 */
import { randomUUID } from "node:crypto";
import type { AuthStorage } from "@earendil-works/pi-coding-agent";

/** A vendor the platform offers subscription login for. */
export interface OAuthProviderDescriptor {
  id: string;
  name: string;
}

/** Current, serializable state of an in-flight login (no secrets). */
export interface OAuthLoginState {
  id: string;
  vendor: string;
  status: "starting" | "awaiting_browser" | "awaiting_device_code" | "awaiting_input" | "done" | "error";
  /** Browser-flow authorization URL + instructions, when the flow opened one. */
  auth?: { url: string; instructions?: string };
  /** Device-code details the user enters at the verification URL. */
  deviceCode?: { userCode: string; verificationUri: string; intervalSeconds?: number; expiresInSeconds?: number };
  /** A pending prompt awaiting `provideInput` (e.g. "paste the code shown"). */
  prompt?: { message: string; placeholder?: string };
  /** Human-facing error when status === "error". */
  error?: string;
}

/** A controllable handle over a running login flow. */
export interface OAuthLoginHandle {
  readonly id: string;
  readonly vendor: string;
  state(): OAuthLoginState;
  /** Resolve a pending prompt (paste-a-code step). Returns false if none pending. */
  provideInput(value: string): boolean;
  /** Abort the flow (aborts pi's login via its AbortSignal). */
  abort(): void;
  /** Resolves when the flow finishes (`done`) or rejects on failure. */
  readonly done: Promise<OAuthLoginState>;
}

/** The pi providers we can drive a subscription login for. */
export function oauthProviderDescriptors(storage: AuthStorage): OAuthProviderDescriptor[] {
  try {
    return storage.getOAuthProviders().map((p) => ({ id: p.id, name: p.name }));
  } catch {
    return [];
  }
}

export function oauthProviderIds(storage: AuthStorage): string[] {
  return oauthProviderDescriptors(storage).map((p) => p.id);
}

export function isOAuthProvider(storage: AuthStorage, vendor: string): boolean {
  return oauthProviderIds(storage).includes(vendor);
}

/**
 * Begin a subscription login. Returns a handle immediately; the browser
 * URL / device code arrive asynchronously via `onUpdate` + `state()`. Throws
 * synchronously only if the vendor has no pi OAuth provider.
 */
export function startOAuthLogin(
  storage: AuthStorage,
  vendor: string,
  opts: { onUpdate?: (state: OAuthLoginState) => void } = {},
): OAuthLoginHandle {
  if (!isOAuthProvider(storage, vendor)) {
    throw new OAuthProviderUnavailableError(vendor);
  }
  const id = randomUUID();
  const controller = new AbortController();
  let pendingPrompt: ((value: string) => void) | null = null;

  const state: OAuthLoginState = { id, vendor, status: "starting" };
  const emit = () => opts.onUpdate?.({ ...state });
  const patch = (next: Partial<OAuthLoginState>) => {
    Object.assign(state, next);
    emit();
  };

  // Auto-answer a method selector by preferring a device-code option (keeps the
  // flow non-interactive where a choice would otherwise be required).
  const pickOption = (options: { id: string; label: string }[]): string | undefined => {
    const dc = options.find((o) => /device/i.test(o.id) || /device/i.test(o.label));
    return (dc ?? options[0])?.id;
  };

  const askForInput = (message: string, placeholder?: string): Promise<string> =>
    new Promise<string>((resolve) => {
      pendingPrompt = (value: string) => {
        pendingPrompt = null;
        patch({ status: state.deviceCode ? "awaiting_device_code" : "awaiting_browser", prompt: undefined });
        resolve(value);
      };
      patch({ status: "awaiting_input", prompt: { message, placeholder } });
    });

  const done = storage
    .login(vendor, {
      onAuth: (info: { url: string; instructions?: string }) =>
        patch({ status: "awaiting_browser", auth: { url: info.url, instructions: info.instructions } }),
      onDeviceCode: (info: {
        userCode: string;
        verificationUri: string;
        intervalSeconds?: number;
        expiresInSeconds?: number;
      }) =>
        patch({
          status: "awaiting_device_code",
          deviceCode: {
            userCode: info.userCode,
            verificationUri: info.verificationUri,
            intervalSeconds: info.intervalSeconds,
            expiresInSeconds: info.expiresInSeconds,
          },
        }),
      onPrompt: (prompt: { message: string; placeholder?: string }) =>
        askForInput(prompt.message, prompt.placeholder),
      onManualCodeInput: () => askForInput("Paste the verification code shown in your browser"),
      onSelect: async (prompt: { options: { id: string; label: string }[] }) => pickOption(prompt.options),
      onProgress: () => {},
      signal: controller.signal,
    })
    .then((): OAuthLoginState => {
      patch({ status: "done", prompt: undefined });
      return { ...state };
    })
    .catch((err: unknown): OAuthLoginState => {
      const msg = err instanceof Error ? err.message : String(err);
      patch({ status: "error", error: msg, prompt: undefined });
      return { ...state };
    });

  return {
    id,
    vendor,
    state: () => ({ ...state }),
    provideInput: (value: string) => {
      if (!pendingPrompt) return false;
      pendingPrompt(value);
      return true;
    },
    abort: () => controller.abort(),
    done,
  };
}

/** Thrown when a vendor has no pi OAuth provider (e.g. opencode). */
export class OAuthProviderUnavailableError extends Error {
  constructor(public readonly vendor: string) {
    super(`provider "${vendor}" does not support subscription (OAuth) login`);
    this.name = "OAuthProviderUnavailableError";
  }
}
