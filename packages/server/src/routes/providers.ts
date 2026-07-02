/**
 * Provider key management. Keys are WRITE-ONLY: the raw key travels only in the
 * PUT body and is never echoed — responses carry the masked ProviderStatus.
 *
 * The provider set is DYNAMIC — driven by the catalog (enabledProviders), not a
 * fixed openai|google|anthropic list. `GET /providers/available` surfaces the
 * full installable set (catalog + curated pi providers) for the add-provider UI.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { setProviderKey, clearProviderKey } from "@pp/engine";
import { installableProviders, modelsForProvider } from "@pp/core";
import { allProviderStatuses, providerStatusWire, wireVendors, type WireVendor } from "../wire.js";
import { V1, type ServerDeps } from "../deps.js";

const KeyBody = z.object({ api_key: z.string().min(8) });

/** Accept any enabled catalog provider (or one the operator is adding a key for). */
function asVendor(v: string): WireVendor | null {
  return wireVendors().includes(v) ? v : null;
}

export function registerProviderRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const storage = deps.engine.authStorage;

  app.get(`${V1}/providers`, async () => allProviderStatuses(storage));

  // Installable set for the add-provider picker: catalog providers (enabled or
  // not) + curated pi providers, each with an env-key hint and whether a key is
  // already configured.
  app.get(`${V1}/providers/available`, async () =>
    installableProviders().map((p) => ({
      ...p,
      configured: providerStatusWire(storage, p.id).has_api_key,
    })),
  );

  app.put(`${V1}/providers/:vendor/key`, async (req, reply) => {
    // A key may be set for ANY provider id (auth is provider-agnostic), so the
    // key route does not gate on the enabled set — that lets the operator
    // configure a provider before/without enabling it in the catalog.
    const vendor = (req.params as { vendor: string }).vendor;
    const parsed = KeyBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: "validation failed", details: parsed.error.flatten() });
    }
    setProviderKey(storage, vendor, parsed.data.api_key);
    const status = providerStatusWire(storage, vendor);
    deps.bus.publish({ type: "provider.status", data: status });
    return status; // masked — never the raw key
  });

  app.delete(`${V1}/providers/:vendor/key`, async (req) => {
    const vendor = (req.params as { vendor: string }).vendor;
    clearProviderKey(storage, vendor);
    const status = providerStatusWire(storage, vendor);
    deps.bus.publish({ type: "provider.status", data: status });
    return status;
  });

  app.get(`${V1}/providers/:vendor/models`, async (req) => {
    const vendor = (req.params as { vendor: string }).vendor;
    return { provider: vendor, models: modelsForProvider(vendor) };
  });

  app.post(`${V1}/providers/:vendor/test`, async (req, reply) => {
    const vendor = asVendor((req.params as { vendor: string }).vendor);
    if (!vendor) return reply.code(404).send({ error: "unknown or disabled provider" });
    const probe = await deps.engine.doctorProbe(vendor);
    return {
      vendor,
      ok: probe.ok,
      status: probe.ok ? "ok" : "fail",
      model: probe.model,
      wall_ms: probe.latency_ms,
      detail: probe.error,
    };
  });
}
