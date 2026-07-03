/**
 * @pp/pilot — public surface.
 *
 * The in-process lifecycle driver (RunPilot) plus its supporting primitives:
 * the typed event bus, the layered tier resolver, the judge-selection policy,
 * and the role-prompt loader. Consumed by the ppp CLI (bin/ppp.ts) and, in
 * later milestones, by @pp/server's REST+SSE control plane.
 */

export { RunPilot, type RunResult } from "./run-pilot.js";
export { regateStage, retryStage, type PostHocOptions, type PostHocResult } from "./post-hoc.js";
export { EventBus, type PilotEvent, type PilotEventType, type PilotEventListener, type EmitInput } from "./events.js";
export { JudgeUnavailableError, TierResolutionError, PilotInternalError } from "./errors.js";

export {
  resolveTier,
  escalateTierForRetry,
  parseTierFlag,
  AGENT_TIER_DEFAULTS,
  type TierResolution,
  type TierResolveInput,
  type TierTraceEntry,
  type TierFlags,
} from "./tier-resolver.js";

export {
  JudgePolicy,
  producerToProvider,
  providerToProducer,
  type JudgeSelectInput,
  type JudgeSelection,
  type Producer,
} from "./judge-policy.js";

export {
  loadRolePrompt,
  renderSystemPrompt,
  parseFrontmatter,
  cleanClaudeCodeProcedure,
  classifyExecution,
  tierForModel,
  listRolePrompts,
  CODING_ROLES,
  READONLY_ROLES,
  type RolePrompt,
  type RolePromptOrigin,
  type ExecutionMode,
  type RenderContext,
} from "./prompts/loader.js";

export type {
  RunPilotOptions,
  RunMode,
  RunContext,
  StageSpec,
  StageOutcome,
  Clock,
} from "./types.js";

export {
  HOOKS,
  runHooks,
  isBlocked,
  getHook,
  type Hook,
  type HookInput,
  type HookResult,
  type HookState,
  type HookPhase,
  type HookDecision,
} from "./hooks/index.js";
