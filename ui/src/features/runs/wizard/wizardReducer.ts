/**
 * Launch-wizard state machine. Pure and framework-agnostic so the step-gating
 * and the request it produces are unit-tested independently of the React view.
 */
import type { RunMode, ClaudeTier, StartRunRequest } from "@shared/api-types";

export type WizardStep = 1 | 2 | 3 | 4;
export type ScopeOverride = "auto" | "trivial" | "standard" | "major";
export type TeamSource = "manual" | "recommended";

export interface WizardState {
  step: WizardStep;
  projectPath: string;
  requestText: string;
  mode: RunMode;
  team: string;
  /** Who last set `team` — a recommendation must never clobber a manual pick. */
  teamSource: TeamSource;
  forum: string;
  n: number;
  scope: ScopeOverride;
  tierCap: ClaudeTier | "";
  tierFloor: ClaudeTier | "";
  profile: string;
  ladderOverrides: Partial<Record<ClaudeTier, string>>;
  tierPoolOverrides: Partial<Record<ClaudeTier, string[]>>;
  /** User dismissed the "switch to team mode" nudge (reset on manual mode change). */
  dismissedModeSuggestion: boolean;
}

export const initialWizardState: WizardState = {
  step: 1,
  projectPath: "",
  requestText: "",
  mode: "single",
  team: "",
  teamSource: "manual",
  forum: "architecture-review",
  n: 3,
  scope: "auto",
  tierCap: "",
  tierFloor: "",
  profile: "",
  ladderOverrides: {},
  tierPoolOverrides: {},
  dismissedModeSuggestion: false,
};

export type WizardAction =
  | { type: "set"; patch: Partial<WizardState> }
  | { type: "mode"; mode: RunMode }
  /** Explicit user pick in the team grid — always wins, flips source to manual. */
  | { type: "teamManual"; team: string }
  /** Recommender preselect — applies only when team is empty or still recommended. */
  | { type: "applyRecommendation"; team: string }
  /** Accept the "use team mode" nudge: switch mode and jump to step 2. */
  | { type: "suggestMode"; mode: RunMode }
  | { type: "dismissModeSuggestion" }
  | { type: "next" }
  | { type: "back" }
  | { type: "goto"; step: WizardStep };

export const MIN_REQUEST_CHARS = 8;
export const N_MIN = 2;
export const N_MAX = 8;

/** Tier cap/floor are meaningless in best-of (mirrors the daemon's 422). */
export function tierControlsDisabled(mode: RunMode): boolean {
  return mode === "best_of";
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  switch (action.type) {
    case "set":
      return { ...state, ...action.patch };
    case "mode": {
      // A manual mode change re-arms the team-mode nudge.
      const next: WizardState = { ...state, mode: action.mode, dismissedModeSuggestion: false };
      if (tierControlsDisabled(action.mode)) {
        next.tierCap = "";
        next.tierFloor = "";
      }
      return next;
    }
    case "teamManual":
      return { ...state, team: action.team, teamSource: "manual" };
    case "applyRecommendation": {
      // Never clobber a manual pick; only fill an empty slot or replace an
      // earlier recommendation.
      if (state.team !== "" && state.teamSource !== "recommended") return state;
      if (state.team === action.team && state.teamSource === "recommended") return state;
      return { ...state, team: action.team, teamSource: "recommended" };
    }
    case "suggestMode": {
      const next: WizardState = { ...state, mode: action.mode, step: 2 };
      if (tierControlsDisabled(action.mode)) {
        next.tierCap = "";
        next.tierFloor = "";
      }
      return next;
    }
    case "dismissModeSuggestion":
      return { ...state, dismissedModeSuggestion: true };
    case "next":
      return { ...state, step: Math.min(4, state.step + 1) as WizardStep };
    case "back":
      return { ...state, step: Math.max(1, state.step - 1) as WizardStep };
    case "goto":
      return { ...state, step: action.step };
    default:
      return state;
  }
}

/** Is a given step's required input satisfied? */
export function stepValid(state: WizardState, step: WizardStep): boolean {
  switch (step) {
    case 1:
      return state.projectPath.trim().length > 0 && state.requestText.trim().length >= MIN_REQUEST_CHARS;
    case 2:
      if (state.mode === "team") return state.team.length > 0;
      if (state.mode === "review") return state.forum.length > 0;
      if (state.mode === "best_of") return state.n >= N_MIN && state.n <= N_MAX;
      return true;
    case 3:
      return true;
    case 4:
      return true;
    default:
      return false;
  }
}

/** Can the wizard advance past its current step? */
export function canProceed(state: WizardState): boolean {
  return stepValid(state, state.step);
}

/** Are all steps satisfied (ready to launch)? */
export function canLaunch(state: WizardState): boolean {
  return ([1, 2, 3] as WizardStep[]).every((s) => stepValid(state, s));
}

/**
 * Project the wizard state into the POST /runs request body. Fields are OMITTED
 * (not set to null) when unused: the server's schema uses zod `.optional()`,
 * which accepts `undefined` but rejects `null`. Sending nulls 422s the run.
 */
export function toStartRequest(state: WizardState): StartRunRequest {
  const bestOf = state.mode === "best_of";
  const req: StartRunRequest = {
    project_path: state.projectPath.trim(),
    request_text: state.requestText.trim(),
    mode: state.mode,
  };
  if (state.profile) req.profile = state.profile;
  if (state.mode === "team" && state.team) req.team = state.team;
  if (state.mode === "review" && state.forum) req.forum = state.forum;
  if (bestOf) req.n = state.n;
  if (!bestOf && state.tierCap) req.tier_cap = state.tierCap;
  if (!bestOf && state.tierFloor) req.tier_floor = state.tierFloor;
  if (Object.keys(state.ladderOverrides).length > 0) req.ladder_override = state.ladderOverrides;
  if (Object.keys(state.tierPoolOverrides).length > 0) req.tier_pools_override = state.tierPoolOverrides;
  if (state.scope !== "auto") req.scope_override = state.scope;
  return req;
}
