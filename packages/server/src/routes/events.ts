/**
 * Server-Sent Events. Two streams: a global stream (GET /api/v1/events) and a
 * per-run stream (GET /api/v1/runs/:id/events, bus frames filtered by run_id).
 *
 * - Last-Event-ID (header or ?lastEventId=) replays newer frames from the bus
 *   ring buffer before going live.
 * - 15s heartbeat comment keeps proxies from idling the connection.
 * - no-transform so SSE frames flush frame-by-frame instead of being buffered.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import type { ServerResponse } from "node:http";
import { V1, type ServerDeps } from "../deps.js";
import type { SseFrame } from "../bus.js";
import { ppSseConnections } from "../metrics.js";

function writeFrame(raw: ServerResponse, frame: SseFrame): void {
  raw.write(`id: ${frame.seq}\n`);
  raw.write(`event: ${frame.type}\n`);
  raw.write(`data: ${JSON.stringify(frame)}\n\n`);
}

function stream(req: FastifyRequest, reply: FastifyReply, deps: ServerDeps, runId?: string): void {
  const raw = reply.raw;
  reply.hijack(); // take over the socket; Fastify won't send its own response
  raw.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const streamLabel = runId === undefined ? "global" : "run";
  try { ppSseConnections.inc({ stream: streamLabel }); } catch { /* ignore */ }
  req.log.info({ runId }, "SSE stream opened");

  // Replay from the ring buffer on Last-Event-ID resume.
  const headerId = req.headers["last-event-id"];
  const queryId = (req.query as { lastEventId?: string }).lastEventId;
  const lastSeq = Number(headerId ?? queryId ?? NaN);
  if (Number.isFinite(lastSeq)) {
    for (const f of deps.bus.ringBuffer({ runId, afterSeq: lastSeq })) writeFrame(raw, f);
  }

  const unsubscribe = deps.bus.subscribe((f) => {
    if (runId !== undefined && f.run_id !== runId) return;
    try {
      writeFrame(raw, f);
    } catch (err) {
      req.log.warn({ err }, "Failed to write SSE frame");
      /* socket gone; cleanup handler will fire */
    }
  });

  const heartbeat = setInterval(() => {
    try {
      raw.write(": ping\n\n");
    } catch {
      /* ignore */
    }
  }, 15_000);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    req.log.info({ runId }, "SSE stream closed");
    try { ppSseConnections.dec({ stream: streamLabel }); } catch { /* ignore */ }
    clearInterval(heartbeat);
    unsubscribe();
  };
  req.raw.on("close", cleanup);
  raw.on("close", cleanup);
}

export function registerEventRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get(`${V1}/events`, (req, reply) => stream(req, reply, deps));
  app.get(`${V1}/runs/:id/events`, (req, reply) => {
    const { id } = req.params as { id: string };
    stream(req, reply, deps, id);
  });
}
