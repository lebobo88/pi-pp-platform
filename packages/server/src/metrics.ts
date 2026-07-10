/**
 * Prometheus metrics for the pp server — ops surface only.
 *
 * Uses a LOCAL prom-client Registry (not the global default) so test
 * isolation is possible and library code that also uses prom-client cannot
 * pollute these metrics.
 *
 * Every call that mutates a metric is wrapped in try/catch so a prom-client
 * bug or bad label value can never throw into the hot request/publish path.
 * (Same pattern as persistFrame in bus.ts.)
 */

import { Registry, collectDefaultMetrics, Gauge, Counter, Histogram } from "prom-client";

export const register = new Registry();

collectDefaultMetrics({ register });

/** Number of runs currently supervised (executing or queued). */
export const ppActiveRuns = new Gauge({
  name: "pp_active_runs",
  help: "Number of runs currently under supervision (executing, not queued).",
  registers: [register],
});

/**
 * Number of open SSE connections.
 * label `stream`: "global" | "run"
 */
export const ppSseConnections = new Gauge({
  name: "pp_sse_connections",
  help: "Number of open SSE connections.",
  labelNames: ["stream"] as const,
  registers: [register],
});

/**
 * HTTP request duration histogram.
 * labels: method, route, status_code
 * SSE long-poll routes and /metrics itself are excluded from recording.
 */
export const ppRequestDuration = new Histogram({
  name: "pp_request_duration_seconds",
  help: "HTTP request duration in seconds (excludes SSE streams and /metrics).",
  labelNames: ["method", "route", "status_code"] as const,
  buckets: [0.005, 0.025, 0.1, 0.25, 1, 2.5, 10],
  registers: [register],
});

/** Total SSE frames published through the bus. */
export const ppEventsPublished = new Counter({
  name: "pp_events_published_total",
  help: "Total SSE frames published through the bus.",
  registers: [register],
});

/**
 * Budget tripwire firings.
 * label `action`: "downgrade" | "block"
 */
export const ppBudgetTripwires = new Counter({
  name: "pp_budget_tripwires_total",
  help: "Number of budget tripwire events fired.",
  labelNames: ["action"] as const,
  registers: [register],
});
