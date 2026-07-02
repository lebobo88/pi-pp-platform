/**
 * @pp/engine — the pi-runtime engine layer.
 *
 * Replaces the pair-programmer codex/gemini/copilot CLI bridges with
 * @earendil-works/pi-{ai,coding-agent,agent-core} 0.80.3. Public surface:
 * envelope (GenResult), catalog (tiers/judges), auth (platform credentials),
 * generate (completion + coding session), critique (LLM judge), tool guards,
 * doctor probes, and deterministic fakes via createEngine.
 */
export * from "./envelope.js";
export * from "./catalog.js";
export * from "./models.js";
export * from "./auth.js";
export * from "./llm.js";
export * from "./critique.js";
export * from "./generate-completion.js";
export * from "./generate-session.js";
export * from "./tool-guards.js";
export * from "./session-store.js";
export * from "./doctor.js";
export * from "./fake.js";
