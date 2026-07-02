/**
 * Launch-wizard state machine. Pure and framework-agnostic so the step-gating
 * and the request it produces are unit-tested independently of the React view.
 */
import type { RunMode, ClaudeTier, StartRunRequest } from "@shared/api-types";

export type WizardStep = 1 | 2 | 3 | 4;
export type ScopeOverride = "auto" | "trivial" | "standard" | "major";

export interface WizardState {
  step: WizardStep;
  projectPath: string;
  requestText: string;
  mode: RunMode;
  team: string;
  forum: string;
  n: number;
  scope: ScopeOverride;
  tierCap: ClaudeTier | "";
  tierFloor: ClaudeTier | "";
  profile: string;
}

export const initialWizardState: WizardState = {
  step: 1,
  projectPath: "",
  requestText: "",
  mode: "single",
  team: "",
  forum: "architecture-review",
  n: 3,
  scope: "auto",
  tierCap: "",
  tierFloor: "",
  profile: "",
};

export type WizardAction =
  | { type: "set"; patch: Partial<WizardState> }
  | { type: "mode"; mode: RunMode }
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
      const next: WizardState = { ...state, mode: action.mode };
      if (tierControlsDisabled(action.mode)) {
        next.tierCap = "";
        next.tierFloor = "";
      }
      return next;
    }
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

/** Project the wizard state into the POST /runs request body. */
export function toStartRequest(state: WizardState): StartRunRequest {
  const bestOf = state.mode === "best_of";
  return {
    project_path: state.projectPath.trim(),
    request_text: state.requestText.trim(),
    mode: state.mode,
    profile: state.profile || null,
    team: state.mode === "team" ? state.team || null : null,
    forum: state.mode === "review" ? state.forum || null : null,
    n: bestOf ? state.n : null,
    tier_cap: bestOf ? null : state.tierCap || null,
    tier_floor: bestOf ? null : state.tierFloor || null,
  };
}
