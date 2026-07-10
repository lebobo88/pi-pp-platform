/**
 * WS2: DeepSeek balance probe (mocked fetch). The stored key is read
 * server-side only and NEVER echoed; other providers report no balance.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { AuthStorage } from "@earendil-works/pi-coding-agent";
import {
  ModelCatalog,
  probeProviderBalance,
  setProviderKey,
  getProviderHealth,
  __resetProviderHealthForTests,
} from "../src/index.js";

function makeDeps(withKey = true) {
  const authStorage = AuthStorage.inMemory();
  if (withKey) setProviderKey(authStorage, "deepseek", "sk-deepseek-test-abcd1234");
  const catalog = new ModelCatalog(authStorage);
  return { catalog, authStorage };
}

afterEach(() => {
  vi.unstubAllGlobals();
  __resetProviderHealthForTests();
});

describe("probeProviderBalance — DeepSeek", () => {
  it("parses /user/balance and records the balance without echoing the key", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: { headers?: Record<string, string> }) => {
      // The Authorization header carries the key server-side — assert it is sent
      // but never surfaces in the returned balance.
      expect(init?.headers?.Authorization).toBe("Bearer sk-deepseek-test-abcd1234");
      return {
        ok: true,
        json: async () => ({ balance_infos: [{ currency: "USD", total_balance: "88.80" }] }),
      };
    });
    vi.stubGlobal("fetch", fetchMock);

    const bal = await probeProviderBalance("deepseek", makeDeps());
    expect(bal).toEqual({ amount: 88.8, currency: "USD", as_of: expect.any(Number) });
    expect(JSON.stringify(bal)).not.toContain("sk-deepseek");
    // Recorded into the registry as last-known balance.
    expect(getProviderHealth("deepseek").balance?.amount).toBe(88.8);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns undefined on a non-ok HTTP response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, json: async () => ({}) })));
    expect(await probeProviderBalance("deepseek", makeDeps())).toBeUndefined();
  });

  it("returns undefined for a provider with no balance API (no fetch)", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await probeProviderBalance("openai", makeDeps())).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns undefined when no key is stored (never calls the API)", async () => {
    delete process.env.DEEPSEEK_API_KEY;
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await probeProviderBalance("deepseek", makeDeps(false))).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
