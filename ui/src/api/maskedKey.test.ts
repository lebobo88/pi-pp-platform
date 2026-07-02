import { describe, it, expect, beforeAll } from "vitest";
import { installMockApi } from "@/mocks/mockApi";
import { api } from "@/api/client";
import { apiPaths, type ProviderStatus } from "@shared/api-types";

/**
 * The masked-key contract: a provider API key is write-only. Setting it must
 * never echo the raw value — only a masked fragment — and the providers listing
 * must never surface a raw key either.
 */
describe("masked-key contract", () => {
  const SECRET = "sk-ant-supersecret-DEADBEEF-9f2c";

  beforeAll(() => {
    installMockApi();
  });

  it("never echoes the raw key when setting it", async () => {
    const res = await api.put<ProviderStatus>(apiPaths.providerKey("anthropic"), { api_key: SECRET });
    const serialized = JSON.stringify(res);

    expect(res.has_api_key).toBe(true);
    expect(res.masked_key).toBeTruthy();
    // The raw secret and its distinctive middle must not appear anywhere.
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain("supersecret");
    expect(serialized).not.toContain("DEADBEEF");
    // The mask keeps only a short suffix.
    expect(res.masked_key).toContain("9f2c");
    expect(res.masked_key).toMatch(/…/);
  });

  it("rejects an obviously-too-short key with a 422 field error", async () => {
    await expect(api.put(apiPaths.providerKey("openai"), { api_key: "short" })).rejects.toMatchObject({
      status: 422,
    });
  });

  it("never surfaces a raw key in the providers listing", async () => {
    const providers = await api.get<ProviderStatus[]>(apiPaths.providers);
    const serialized = JSON.stringify(providers);
    expect(serialized).not.toContain(SECRET);
    for (const p of providers) {
      if (p.masked_key) expect(p.masked_key).toMatch(/…/);
      // No field named api_key / key should ever be present.
      expect(Object.keys(p)).not.toContain("api_key");
    }
  });
});
