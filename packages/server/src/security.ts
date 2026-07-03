/**
 * Localhost-only + optional bearer-token gate.
 *
 * The server binds 127.0.0.1 (see app.ts) so it isn't reachable off-box; this
 * hook is defense-in-depth: it rejects non-loopback peers and, when PP_API_TOKEN
 * is set, requires `Authorization: Bearer <token>`. GET /healthz is always open
 * (liveness probes). The two SSE endpoints (GET /api/v1/events and
 * GET /api/v1/runs/:id/events) additionally accept the token as a `?token=`
 * query param — EventSource cannot send headers.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** The only paths allowed to carry the bearer as ?token= (SSE streams). */
const SSE_PATH = /^\/api\/v1\/(?:events|runs\/[^/]+\/events)$/;

function isLoopback(ip: string | undefined): boolean {
  if (!ip) return false;
  return LOOPBACK.has(ip) || ip.startsWith("127.");
}

/** Constant-time equality (hash both sides so length is not observable). */
function tokenEqual(provided: string, expected: string): boolean {
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function registerSecurity(app: FastifyInstance, opts: { token?: string }): void {
  const token = opts.token;
  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    const [path, query] = req.url.split("?") as [string, string | undefined];

    // Always allow the liveness probe.
    if (req.method === "GET" && path === "/healthz") return;

    if (!isLoopback(req.ip)) {
      reply.code(403).send({ error: "forbidden", details: "server accepts loopback connections only" });
      return reply;
    }

    if (token) {
      const auth = req.headers["authorization"];
      let provided = typeof auth === "string" && auth.startsWith("Bearer ") ? auth.slice(7) : null;
      if (provided === null && req.method === "GET" && SSE_PATH.test(path)) {
        const qt = new URLSearchParams(query ?? "").get("token");
        if (qt !== null) provided = qt;
      }
      if (provided === null || !tokenEqual(provided, token)) {
        reply.code(401).send({ error: "unauthorized", details: "missing or invalid bearer token" });
        return reply;
      }
    }
  });
}
