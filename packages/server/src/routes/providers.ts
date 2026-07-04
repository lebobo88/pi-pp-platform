/**
 * Provider key management. Keys are WRITE-ONLY: the raw key travels only in the
 * PUT body and is never echoed — responses carry the masked ProviderStatus.
 *
 * The provider + model sets are DYNAMIC and sourced from pi's builtin catalog
 * (~35 providers) plus the platform catalog. GET /providers surfaces every
 * enabled-or-keyed provider; GET /providers/available lists the full installable
 * set for the add-provider UI; GET /providers/:vendor/models returns pi's models.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { setProviderKey, clearProviderKey, listPiProviders, listPiModels, piEnvKeyHint, refreshPiModels } from "@pp/engine";
import { catalog, knownProviderIds } from "@pp/core";
import { allProviderStatuses, providerStatusWire, visibleProviders, modelsForProviderMerged } from "../wire.js";
import { V1, type ServerDeps } from "../deps.js";

const KeyBody = z.object({ api_key: z.string().min(8) });

function prettyName(id: string): string {
  return id.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

export function registerProviderRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const storage = deps.engine.authStorage;

  app.get(`${V1}/providers`, async () => allProviderStatuses(storage));

  // Installable set for the add-provider picker: every catalog provider AND
  // every provider pi ships a catalog for, with an env-key hint + configured flag.
  app.get(`${V1}/providers/available`, async () => {
    const cat = catalog().providers;
    const ids = Array.from(new Set([...knownProviderIds(), ...listPiProviders()]));
    return ids
      .map((id) => {
        const c = cat[id];
        return {
          id,
          display_name: c?.display_name ?? prettyName(id),
          env_key_hint: c?.env_key_hint ?? piEnvKeyHint(id),
          in_catalog: !!c,
          enabled: c ? c.enabled !== false : false,
          configured: providerStatusWire(storage, id).has_api_key,
          model_count: listPiModels(id).length,
        };
      })
      .sort((a, b) =>
        a.in_catalog === b.in_catalog ? a.id.localeCompare(b.id) : a.in_catalog ? -1 : 1,
      );
  });

  app.put(`${V1}/providers/:vendor/key`, async (req, reply) => {
    // A key may be set for ANY provider id (auth is provider-agnostic). Once set,
    // the provider becomes visible in GET /providers with its pi model list.
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
    return { provider: vendor, models: modelsForProviderMerged(vendor).map((m) => m.id) };
  });

  app.post(`${V1}/providers/:vendor/models/refresh`, async (req, reply) => {
    // Re-fetch the live model list for a dynamic provider. `refreshed` is
    // honest: false when the provider is static or the live fetch failed
    // (the static built-in list is returned in both cases).
    const vendor = (req.params as { vendor: string }).vendor;
    const known = listPiModels(vendor).length > 0 || visibleProviders(storage).includes(vendor);
    if (!known) return reply.code(404).send({ error: "unknown provider" });
    const { models, refreshed } = await refreshPiModels(vendor);
    return { provider: vendor, refreshed, models: models.map((m) => m.id) };
  });

  app.post(`${V1}/providers/:vendor/test`, async (req, reply) => {
    // Testable when pi knows the provider or a key is stored for it.
    const vendor = (req.params as { vendor: string }).vendor;
    const known = listPiModels(vendor).length > 0 || visibleProviders(storage).includes(vendor);
    if (!known) return reply.code(404).send({ error: "unknown provider" });
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
