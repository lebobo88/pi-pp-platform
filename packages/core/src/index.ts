/**
 * @pp/core — public surface.
 *
 * Library entry point for the Pair Programmer platform core. Unlike the
 * original pp-daemon `index.ts`, this file performs NO CLI subcommand handling
 * and starts NO MCP / HTTP server — those return in a later milestone as
 * `@pp/server`. `@pp/core` is consumed as a library: import the orchestration
 * primitives below directly.
 *
 * The CLI critique bridges (codex-server / gemini-server / copilot-runner) and
 * the harness/critique MCP servers were removed in M1. Critique-smoke providers
 * are injected via `setCritiqueSmokeProviders` (re-exported from runs.js).
 */

// Orchestrator core
export * from "./orchestrator/runs.js";
export * from "./orchestrator/gates.js";
export * from "./orchestrator/best-of-n.js";
export * from "./orchestrator/taxonomy.js";
export * from "./orchestrator/missability.js";
export * from "./orchestrator/profiles.js";
export * from "./orchestrator/teams.js";
export * from "./orchestrator/forums.js";
export * from "./orchestrator/master-plan.js";
export * from "./orchestrator/agents-md.js";
export * from "./orchestrator/constitution.js";
export * from "./orchestrator/replay.js";
export * from "./orchestrator/janitor.js";
export * from "./orchestrator/tdd-gate.js";
export * from "./orchestrator/artifact-validators/index.js";

// Rubrics
export * from "./rubrics/registry.js";
export * from "./rubrics/loader.js";

// Persistence + config
export * from "./db/database.js";
export * from "./config.js";

// Security
export * from "./security/secret-scan.js";
export * from "./security/untrusted-envelope.js";

// Pricing
export * from "./util/prices.js";

// Read-only HTTP control plane (kept; compiles without the removed modules).
export * from "./http/server.js";
