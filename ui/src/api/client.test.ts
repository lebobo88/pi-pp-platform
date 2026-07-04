import { describe, it, expect, vi, afterEach } from "vitest";
import { api, ApiClientError } from "./client";
import { useAuthStore } from "@/stores/authStore";

function mockFetch(body: string, init: { status?: number; contentType?: string } = {}) {
  const status = init.status ?? 200;
  const headers = new Headers();
  if (init.contentType) headers.set("Content-Type", init.contentType);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status, headers })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  useAuthStore.setState({ token: null, unauthorized: false });
  localStorage.removeItem("pp.apiToken");
});

describe("api client", () => {
  it("returns parsed JSON on 2xx", async () => {
    mockFetch(JSON.stringify({ ok: true, n: 3 }), { status: 200 });
    const out = await api.get<{ ok: boolean; n: number }>("/api/v1/thing");
    expect(out).toEqual({ ok: true, n: 3 });
  });

  it("returns undefined for an empty 2xx body", async () => {
    // Empty-body path: no JSON to parse → undefined. (Use 200; the test
    // Response constructor disallows a body on a 204.)
    mockFetch("", { status: 200 });
    const out = await api.del<undefined>("/api/v1/thing/1");
    expect(out).toBeUndefined();
  });

  it("throws ApiClientError with the envelope message on 404", async () => {
    mockFetch(JSON.stringify({ error: "run xyz not found" }), { status: 404 });
    await expect(api.get("/api/v1/runs/xyz")).rejects.toMatchObject({
      name: "ApiClientError",
      status: 404,
      message: "run xyz not found",
    });
  });

  it("exposes per-field errors on 422", async () => {
    mockFetch(
      JSON.stringify({ error: "validation failed", details: { request_text: "required", n: "must be >= 2" } }),
      { status: 422 },
    );
    try {
      await api.post("/api/v1/runs", { n: 1 });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ApiClientError);
      const e = err as ApiClientError;
      expect(e.status).toBe(422);
      expect(e.fieldErrors).toEqual({ request_text: "required", n: "must be >= 2" });
    }
  });

  it("returns null fieldErrors for non-422 errors", async () => {
    mockFetch(JSON.stringify({ error: "boom" }), { status: 500 });
    try {
      await api.get("/api/v1/thing");
      throw new Error("should have thrown");
    } catch (err) {
      expect((err as ApiClientError).fieldErrors).toBeNull();
    }
  });

  it("handles a non-JSON error body", async () => {
    mockFetch("<html>502 Bad Gateway</html>", { status: 502 });
    await expect(api.get("/api/v1/thing")).rejects.toMatchObject({
      status: 502,
      message: expect.stringContaining("502"),
    });
  });

  it("wraps network failures as status 0", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(api.get("/api/v1/thing")).rejects.toMatchObject({
      name: "ApiClientError",
      status: 0,
    });
  });

  it("falls back to statusText when the envelope has no error field", async () => {
    mockFetch(JSON.stringify({ nope: true }), { status: 400 });
    await expect(api.get("/api/v1/thing")).rejects.toMatchObject({ status: 400 });
  });
});

describe("api client auth", () => {
  it("sends no Authorization header when no token is set", async () => {
    mockFetch(JSON.stringify({ ok: true }), { status: 200 });
    await api.get("/api/v1/thing");
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("injects Authorization: Bearer when a token is set", async () => {
    useAuthStore.getState().setToken("tok_secret");
    mockFetch(JSON.stringify({ ok: true }), { status: 200 });
    await api.get("/api/v1/thing");
    const init = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer tok_secret");
  });

  it("marks the store unauthorized on 401 before throwing", async () => {
    mockFetch(JSON.stringify({ error: "unauthorized" }), { status: 401 });
    await expect(api.get("/api/v1/thing")).rejects.toMatchObject({ status: 401, message: "unauthorized" });
    expect(useAuthStore.getState().unauthorized).toBe(true);
  });

  it("does not mark unauthorized on other error statuses", async () => {
    mockFetch(JSON.stringify({ error: "boom" }), { status: 500 });
    await expect(api.get("/api/v1/thing")).rejects.toMatchObject({ status: 500 });
    expect(useAuthStore.getState().unauthorized).toBe(false);
  });
});
