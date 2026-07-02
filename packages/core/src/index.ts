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
// M7a (@pp/mcp-adapter): pure read/record helpers the pp_harness-compat MCP
// server needs. Exported here because @pp/core only publishes the "." entry.
export * from "./orchestrator/loop-ceiling.js";
export * from "./orchestrator/profile-detect.js";
export * from "./orchestrator/design-templates.js";
export { forceUnlock, type ForceUnlockResult } from "./util/lock.js";
// Pilot seam (M3): autogenesis analyzer consumed by @pp/pilot's finalize phase.
export { analyzeAndPropose, listProposals, setProposalStatus } from "./orchestrator/autogenesis-analyzer.js";
export type { DetectedProposal } from "./orchestrator/autogenesis-analyzer.js";
// Pilot seam (M7): visual regression + browser validation stage drivers.
export * from "./orchestrator/browser-validation.js";
export * from "./orchestrator/visual-regression.js";
// Pilot seam (M7.5): agent_sessions recording + replay session-hash records.
export * from "./orchestrator/agent-sessions.js";
// Server seam (M5c / v8): project registry + platform settings kv.
export * from "./orchestrator/projects.js";
export * from "./orchestrator/settings.js";

// Rubrics
export * from "./rubrics/registry.js";
export * from "./rubrics/loader.js";

// Persistence + config
export * from "./db/database.js";
export * from "./config.js";

// Security
export * from "./security/secret-scan.js";
export * from "./security/untrusted-envelope.js";

// Engine seams (M2): the @pp/engine layer reuses these pure helpers. Exported
// here because @pp/core only publishes the "." entry point (no subpath exports).
export * from "./hooks/bash-safety.js";
export { buildCritiqueOutputSchema, validateCritiqueResult, normalizeCritiqueResult, extractJsonValue } from "./mcp/critique-schema.js";
export type { CritiqueOutcome, CritiqueVerdict } from "./mcp/critique-schema.js";

// Provider/model catalog (dynamic vendor space — single source of truth).
export * from "./catalog/config.js";

// Pricing
export * from "./util/prices.js";

// Read-only HTTP control plane (kept; compiles without the removed modules).
export * from "./http/server.js";
