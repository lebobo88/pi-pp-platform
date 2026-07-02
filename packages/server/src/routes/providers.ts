/**
 * Provider key management. Keys are WRITE-ONLY: the raw key travels only in the
 * PUT body and is never echoed — responses carry the masked ProviderStatus.
 */
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { setProviderKey, clearProviderKey } from "@pp/engine";
import { allProviderStatuses, providerStatusWire, WIRE_VENDORS, type WireVendor } from "../wire.js";
import { V1, type ServerDeps } from "../deps.js";

const KeyBody = z.object({ api_key: z.string().min(8) });

function asVendor(v: string): WireVendor | null {
  return (WIRE_VENDORS as readonly string[]).includes(v) ? (v as WireVendor) : null;
}

export function registerProviderRoutes(app: FastifyInstance, deps: ServerDeps): void {
  const storage = deps.engine.authStorage;

  app.get(`${V1}/providers`, async () => allProviderStatuses(storage));

  app.put(`${V1}/providers/:vendor/key`, async (req, reply) => {
    const vendor = asVendor((req.params as { vendor: string }).vendor);
    if (!vendor) return reply.code(404).send({ error: "unknown vendor" });
    const parsed = KeyBody.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(422).send({ error: "validation failed", details: parsed.error.flatten() });
    }
    setProviderKey(storage, vendor, parsed.data.api_key);
    const status = providerStatusWire(storage, vendor);
    deps.bus.publish({ type: "provider.status", data: status });
    return status; // masked — never the raw key
  });

  app.delete(`${V1}/providers/:vendor/key`, async (req, reply) => {
    const vendor = asVendor((req.params as { vendor: string }).vendor);
    if (!vendor) return reply.code(404).send({ error: "unknown vendor" });
    clearProviderKey(storage, vendor);
    const status = providerStatusWire(storage, vendor);
    deps.bus.publish({ type: "provider.status", data: status });
    return status;
  });

  app.post(`${V1}/providers/:vendor/test`, async (req, reply) => {
    const vendor = asVendor((req.params as { vendor: string }).vendor);
    if (!vendor) return reply.code(404).send({ error: "unknown vendor" });
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
