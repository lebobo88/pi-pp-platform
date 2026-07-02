/**
 * Localhost-only + optional bearer-token gate.
 *
 * The server binds 127.0.0.1 (see app.ts) so it isn't reachable off-box; this
 * hook is defense-in-depth: it rejects non-loopback peers and, when PP_API_TOKEN
 * is set, requires `Authorization: Bearer <token>`. GET /healthz is always open
 * (liveness probes).
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  return LOOPBACK.has(ip) || ip.startsWith("127.");
}

export function registerSecurity(app: FastifyInstance, opts: { token?: string }): void {
  const token = opts.token;
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    // Always allow the liveness probe.
    if (req.method === "GET" && req.url.split("?")[0] === "/healthz") return;

    if (!isLoopback(req.ip)) {
      reply.code(403).send({ error: "forbidden", details: "server accepts loopback connections only" });
      return reply;
    }

    if (token) {
      const auth = req.headers["authorization"];
      const provided = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : null;
      if (provided !== token) {
        reply.code(401).send({ error: "unauthorized", details: "missing or invalid bearer token" });
        return reply;
      }
    }
  });
}
