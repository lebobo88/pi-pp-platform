/**
 * Serve the built UI (ui/dist) with an SPA fallback: any non-/api GET without a
 * file extension falls back to index.html (no-store) so client-side routes work
 * on hard refresh.
 */
import type { FastifyInstance } from "fastify";
import { extname } from "node:path";
import fastifyStatic from "@fastify/static";

export async function registerStatic(app: FastifyInstance, uiDistPath: string): Promise<void> {
  await app.register(fastifyStatic, { root: uiDistPath, prefix: "/", wildcard: false });

  app.setNotFoundHandler((req, reply) => {
    const pathname = (req.raw.url ?? "/").split("?")[0]!;
    const isApi = pathname.startsWith("/api") || pathname === "/healthz";
    if (req.method === "GET" && !isApi && !extname(pathname)) {
      // Disable @fastify/static's own Cache-Control so our no-store on the SPA
      // shell isn't clobbered — a stale index.html would pin an old asset graph.
      reply.header("Cache-Control", "no-store");
      return reply.type("text/html").sendFile("index.html", { cacheControl: false });
    }
    return reply.code(404).send({ error: "not_found", path: pathname });
  });
}
