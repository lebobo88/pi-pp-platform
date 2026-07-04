/**
 * Thin fetch wrapper. All requests send/expect JSON. Non-2xx responses are
 * decoded as the `{ error, details? }` envelope and thrown as ApiClientError;
 * 422 carries per-field validation errors in `details`.
 */
import type { ApiError } from "@shared/api-types";
import { getApiToken, markUnauthorized } from "@/stores/authStore";

export class ApiClientError extends Error {
  readonly status: number;
  readonly details?: ApiError["details"];

  constructor(status: number, message: string, details?: ApiError["details"]) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.details = details;
  }

  /** Per-field validation errors, when the server returned a 422 map. */
  get fieldErrors(): Record<string, string> | null {
    if (this.status !== 422) return null;
    if (this.details && typeof this.details === "object" && !Array.isArray(this.details)) {
      return this.details as Record<string, string>;
    }
    return null;
  }
}

export interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
}

async function request<T>(method: string, path: string, body?: unknown, opts: RequestOptions = {}): Promise<T> {
  const token = getApiToken();
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers: {
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...opts.headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: opts.signal,
    });
  } catch (err) {
    // Network / CORS / abort — surface as a client error with status 0.
    const message = err instanceof Error ? err.message : "Network request failed";
    throw new ApiClientError(0, message);
  }

  // Flag missing/bad token so the TokenGate can prompt, then throw as usual.
  if (res.status === 401) markUnauthorized();

  const raw = await res.text();
  let parsed: unknown = undefined;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Body wasn't JSON.
      if (!res.ok) {
        throw new ApiClientError(res.status, raw.slice(0, 300) || res.statusText);
      }
      throw new ApiClientError(res.status, "Expected JSON response but got non-JSON body");
    }
  }

  if (!res.ok) {
    const env = (parsed ?? {}) as Partial<ApiError>;
    const message = typeof env.error === "string" && env.error ? env.error : res.statusText || `HTTP ${res.status}`;
    throw new ApiClientError(res.status, message, env.details);
  }

  return parsed as T;
}

export const api = {
  get: <T>(path: string, opts?: RequestOptions) => request<T>("GET", path, undefined, opts),
  post: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("POST", path, body, opts),
  patch: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("PATCH", path, body, opts),
  put: <T>(path: string, body?: unknown, opts?: RequestOptions) => request<T>("PUT", path, body, opts),
  del: <T>(path: string, opts?: RequestOptions) => request<T>("DELETE", path, undefined, opts),
};

/** Exposed for unit tests that need to exercise the envelope decoder directly. */
export const __internal = { request };
