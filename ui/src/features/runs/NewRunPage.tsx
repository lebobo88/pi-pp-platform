import { useEffect, useMemo, useReducer, useRef, useState } from "react";
import { useNavigate } from "react-router";
import type {
  RunMode,
  ClaudeTier,
  ModelInfo,
  TeamSpec,
  Forum,
  TeamRecommendResponse,
  TeamRecommendation,
} from "@shared/api-types";
import { RUN_MODE, CLAUDE_TIERS } from "@shared/api-types";
import { Page } from "@/layout/Page";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { Pill } from "@/features/common/chips";
import { cn } from "@/lib/cn";
import { useProjects } from "@/api/queries/projects";
import { useProfiles, useTeams, useForums } from "@/api/queries/library";
import { useModels } from "@/api/queries/providers";
import { useBudgets, useCaps } from "@/api/queries/budgets";
import { useStartRun } from "@/api/mutations/runs";
import { useRecommendTeams } from "@/api/mutations/recommend";
import { toast } from "@/stores/uiStore";
import { ApiClientError } from "@/api/client";
import { formatUsd, formatTokens, estimateTokens } from "@/lib/format";
import {
  wizardReducer,
  initialWizardState,
  stepValid,
  canProceed,
  canLaunch,
  toStartRequest,
  tierControlsDisabled,
  N_MIN,
  N_MAX,
  type WizardState,
  type WizardStep,
  type ScopeOverride,
  type TeamSource,
} from "./wizard/wizardReducer";
import { RecommendationBanner } from "./wizard/RecommendationBanner";
import { estimateRunCost, defaultStageCount, type TierPrice } from "./wizard/costEstimator";

const STEP_TITLES: Record<WizardStep, string> = {
  1: "Request",
  2: "Mode & team",
  3: "Options",
  4: "Review & launch",
};

const SCOPE_HINT: Record<ScopeOverride, string> = {
  auto: "Let triage classify the request (recommended).",
  trivial: "Minimum artifacts — changelog only.",
  standard: "Full pipeline with standard gate strictness.",
  major: "Forces team mode and best-of races on high-surface stages.",
};

export function NewRunPage() {
  const navigate = useNavigate();
  const [state, dispatch] = useReducer(wizardReducer, initialWizardState);

  const { data: projects } = useProjects();
  const { data: profiles } = useProfiles();
  const { data: teams } = useTeams();
  const { data: forums } = useForums();
  const { data: models } = useModels();
  const { data: caps } = useCaps();
  const { data: budgets } = useBudgets();
  const startRun = useStartRun();
  const recommend = useRecommendTeams();

  // Fire the recommender on entering step 2 with valid step-1 data. Memoized
  // on (project_path, request_text) in a ref so unchanged inputs never refetch.
  const recommendKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (state.step !== 2 || !stepValid(state, 1)) return;
    const key = JSON.stringify([state.projectPath, state.requestText]);
    if (recommendKeyRef.current === key) return;
    recommendKeyRef.current = key;
    recommend.mutate({
      request_text: state.requestText.trim(),
      project_path: state.projectPath.trim(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.step, state.projectPath, state.requestText]);

  const recommendation: TeamRecommendResponse | null = recommend.data ?? null;
  const topRecommendation = recommendation?.recommendations[0] ?? null;

  // Preselect the top team while in team mode. The reducer guards on
  // teamSource, so a manual pick is never clobbered and re-runs are no-ops.
  useEffect(() => {
    if (topRecommendation && state.mode === "team") {
      dispatch({ type: "applyRecommendation", team: topRecommendation.team });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topRecommendation, state.mode]);

  // Default the forum to a real one once /forums loads.
  useEffect(() => {
    if (forums && forums.length > 0 && !forums.some((f) => f.id === state.forum)) {
      dispatch({ type: "set", patch: { forum: forums[0]!.id } });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [forums]);

  const project = projects?.find((p) => p.path === state.projectPath) ?? null;
  const projectProfile = project?.profile ?? null;

  const set = (patch: Partial<WizardState>) => dispatch({ type: "set", patch });

  const priceForTier = (tier: ClaudeTier): TierPrice => {
    const m = (models ?? []).find((x) => x.tier === tier);
    return { input_per_1m: m?.input_per_1m ?? 3, output_per_1m: m?.output_per_1m ?? 15 };
  };

  const selectedTeam = teams?.find((t) => t.name === state.team) ?? null;
  // The teams list omits stages; fall back to the default when unknown.
  const teamStageCount = selectedTeam?.stages?.length;
  const stageCount = state.mode === "team" && teamStageCount ? teamStageCount : defaultStageCount(state.mode);
  const dearTier: ClaudeTier = state.tierCap || "opus";
  const estimate = useMemo(
    () =>
      estimateRunCost({
        mode: state.mode,
        stageCount,
        n: state.n,
        cheapPrice: priceForTier("haiku"),
        dearPrice: priceForTier(dearTier),
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.mode, stageCount, state.n, state.tierCap, models],
  );

  const today = new Date().toISOString().slice(0, 10);
  const daySpend = budgets?.find((b) => b.scope === `day:${today}`)?.cost_usd ?? budgets?.find((b) => b.scope.startsWith("day:"))?.cost_usd ?? 0;
  // No fabricated cap: when the server reports no day cap, show that honestly.
  const dayCap = caps?.find((c) => c.scope === "day")?.limit_usd ?? null;
  const dayRemaining = dayCap == null ? null : Math.max(0, dayCap - daySpend);
  const overCap = dayRemaining != null && estimate.maxUsd > dayRemaining;

  const launch = () => {
    startRun.mutate(toStartRequest(state), {
      onSuccess: (res) => {
        toast({ tone: "success", title: "Run started", message: res.run_id });
        navigate(`/runs/${res.run_id}`);
      },
      onError: (err) => {
        if (err instanceof ApiClientError && err.fieldErrors) {
          toast({ tone: "error", title: "Validation failed", message: Object.values(err.fieldErrors).join("; ") });
        } else {
          toast({ tone: "error", title: "Could not start run", message: err instanceof Error ? err.message : "" });
        }
      },
    });
  };

  return (
    <Page title="New run" description="Compose a request and dispatch it through the lifecycle.">
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[200px_minmax(0,1fr)]">
        <Stepper state={state} onGoto={(s) => dispatch({ type: "goto", step: s })} />

        <div className="space-y-4">
          {state.step === 1 && (
            <StepRequest
              projects={projects ?? []}
              projectPath={state.projectPath}
              projectProfile={projectProfile}
              requestText={state.requestText}
              onProject={(v) => set({ projectPath: v })}
              onRequest={(v) => set({ requestText: v })}
              onFixProfile={() => project && navigate(`/projects/${encodeURIComponent(project.path)}`)}
            />
          )}

          {state.step === 2 && (
            <StepMode
              state={state}
              teams={teams ?? []}
              forums={forums ?? []}
              projectProfile={projectProfile}
              models={models ?? []}
              recommendation={recommendation}
              recommendLoading={recommend.isPending}
              onMode={(m) => dispatch({ type: "mode", mode: m })}
              onTeam={(t) => dispatch({ type: "teamManual", team: t })}
              onUseTeamMode={() => dispatch({ type: "suggestMode", mode: "team" })}
              onForum={(f) => set({ forum: f })}
              onN={(n) => set({ n })}
            />
          )}

          {state.step === 3 && (
            <StepOptions
              state={state}
              profiles={(profiles ?? []).map((p) => p.name)}
              estimate={estimate}
              dayRemaining={dayRemaining}
              overCap={overCap}
              suggestTeamMode={!!recommendation?.suggest_team_mode}
              suggestedTeam={topRecommendation?.team ?? null}
              onScope={(s) => set({ scope: s })}
              onProfile={(p) => set({ profile: p })}
              onTierCap={(t) => set({ tierCap: t })}
              onTierFloor={(t) => set({ tierFloor: t })}
              onSwitchToTeamMode={() => dispatch({ type: "suggestMode", mode: "team" })}
              onDismissSuggestion={() => dispatch({ type: "dismissModeSuggestion" })}
            />
          )}

          {state.step === 4 && (
            <StepReview
              state={state}
              stageCount={stageCount}
              estimate={estimate}
              overCap={overCap}
              recommendation={recommendation}
            />
          )}

          <div className="flex items-center justify-between">
            <Button variant="ghost" onClick={() => (state.step === 1 ? navigate("/runs") : dispatch({ type: "back" }))}>
              {state.step === 1 ? "Cancel" : "Back"}
            </Button>
            {state.step < 4 ? (
              <Button variant="primary" disabled={!canProceed(state)} onClick={() => dispatch({ type: "next" })} data-testid="wizard-next">
                Next
              </Button>
            ) : (
              <Button variant="primary" disabled={!canLaunch(state) || startRun.isPending} onClick={launch} data-testid="wizard-launch">
                {startRun.isPending ? "Launching…" : "Launch run"}
              </Button>
            )}
          </div>

          {!projects?.length && (
            <EmptyState compact title="No projects yet" description="Register a project first from the Projects screen." />
          )}
        </div>
      </div>
    </Page>
  );
}

/* ── Stepper ───────────────────────────────────────────────────────────── */

function Stepper({ state, onGoto }: { state: WizardState; onGoto: (s: WizardStep) => void }) {
  const steps: WizardStep[] = [1, 2, 3, 4];
  return (
    <ol className="space-y-1">
      {steps.map((s) => {
        const active = state.step === s;
        const done = s < state.step && stepValid(state, s);
        const reachable = s <= state.step || ([1, 2, 3] as WizardStep[]).slice(0, s - 1).every((x) => stepValid(state, x));
        return (
          <li key={s}>
            <button
              type="button"
              disabled={!reachable}
              onClick={() => reachable && onGoto(s)}
              className={cn(
                "flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-left transition-colors disabled:opacity-40",
                active ? "bg-bg-3" : "hover:bg-bg-2",
              )}
            >
              <span
                className={cn("flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px]",
                  active ? "border-accent text-accent" : done ? "border-pass text-pass" : "border-line-2 text-ink-3")}
              >
                {done ? "✓" : s}
              </span>
              <span className={cn("text-[12px]", active ? "text-ink-1" : "text-ink-3")}>{STEP_TITLES[s]}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/* ── Step 1 ────────────────────────────────────────────────────────────── */

function StepRequest({
  projects,
  projectPath,
  projectProfile,
  requestText,
  onProject,
  onRequest,
  onFixProfile,
}: {
  projects: { path: string; name: string; profile: string | null }[];
  projectPath: string;
  projectProfile: string | null;
  requestText: string;
  onProject: (v: string) => void;
  onRequest: (v: string) => void;
  onFixProfile: () => void;
}) {
  return (
    <>
      <Card title="Project">
        <div className="flex items-center gap-2">
          <select
            data-testid="wizard-project"
            value={projectPath}
            onChange={(e) => onProject(e.target.value)}
            className="flex-1 rounded-sm border border-line-2 bg-bg-2 px-2 py-1.5 text-[12px] text-ink-1 outline-none focus:border-accent"
          >
            <option value="">Select a project…</option>
            {projects.map((p) => (
              <option key={p.path} value={p.path}>{p.name} — {p.path}</option>
            ))}
          </select>
          {projectPath && projectProfile && <Pill tone="accent">{projectProfile}</Pill>}
        </div>
        {projectPath && !projectProfile && (
          <p className="mt-2 text-[11px] text-warn">
            No profile detected for this project.{" "}
            <button type="button" onClick={onFixProfile} className="underline hover:text-ink-1">Bootstrap one →</button>
          </p>
        )}
      </Card>

      <Card
        title="Request"
        actions={<span className="mono text-[11px] text-ink-3">≈ {formatTokens(estimateTokens(requestText))} tok</span>}
      >
        <textarea
          data-testid="wizard-request"
          value={requestText}
          onChange={(e) => onRequest(e.target.value)}
          rows={5}
          placeholder="Describe the change you want the harness to make…"
          className="w-full resize-y rounded-sm border border-line-2 bg-bg-2 px-2 py-1.5 text-[13px] text-ink-1 outline-none focus:border-accent"
        />
      </Card>
    </>
  );
}

/* ── Step 2 ────────────────────────────────────────────────────────────── */

function StepMode({
  state,
  teams,
  forums,
  projectProfile,
  models,
  recommendation,
  recommendLoading,
  onMode,
  onTeam,
  onUseTeamMode,
  onForum,
  onN,
}: {
  state: WizardState;
  teams: TeamSpec[];
  forums: Forum[];
  projectProfile: string | null;
  models: ModelInfo[];
  recommendation: TeamRecommendResponse | null;
  recommendLoading: boolean;
  onMode: (m: RunMode) => void;
  onTeam: (t: string) => void;
  onUseTeamMode: (team: string) => void;
  onForum: (f: string) => void;
  onN: (n: number) => void;
}) {
  return (
    <>
      <RecommendationBanner
        loading={recommendLoading}
        response={recommendation}
        mode={state.mode}
        onUseTeamMode={onUseTeamMode}
      />

      <Card title="Mode">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {RUN_MODE.map((m) => (
            <button
              key={m}
              type="button"
              data-testid={`mode-${m}`}
              onClick={() => onMode(m)}
              className={cn("rounded-md border px-2 py-2 text-[12px] font-medium transition-colors",
                state.mode === m ? "border-accent bg-bg-3 text-ink-1" : "border-line-1 bg-bg-2 text-ink-2 hover:border-line-2")}
            >
              {m === "best_of" ? "Best-of-N" : m[0]!.toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
      </Card>

      {state.mode === "team" && (
        <Card title="Team">
          <TeamPicker
            teams={teams}
            projectProfile={projectProfile}
            selected={state.team}
            teamSource={state.teamSource}
            recommendations={recommendation?.recommendations ?? []}
            onSelect={onTeam}
          />
        </Card>
      )}

      {state.mode === "best_of" && (
        <Card title="Candidates">
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={N_MIN}
              max={N_MAX}
              value={state.n}
              onChange={(e) => onN(Number(e.target.value))}
              className="flex-1 accent-[var(--accent)]"
            />
            <span className="mono tnum w-8 text-center text-[13px] text-ink-1">{state.n}</span>
          </div>
          <CandidatePreview n={state.n} models={models} />
        </Card>
      )}

      {state.mode === "review" && (
        <Card title="Forum">
          <select
            value={state.forum}
            onChange={(e) => onForum(e.target.value)}
            className="w-full rounded-sm border border-line-2 bg-bg-2 px-2 py-1.5 text-[12px] text-ink-1 outline-none focus:border-accent"
          >
            {forums.length === 0 && <option value={state.forum}>{state.forum}</option>}
            {forums.map((f) => (
              <option key={f.id} value={f.id}>{f.title}</option>
            ))}
          </select>
        </Card>
      )}

      {state.mode === "single" && (
        <p className="text-[12px] text-ink-3">Single mode runs one generator and one judge with Reflexion ×1 on failure.</p>
      )}
    </>
  );
}

function TeamPicker({
  teams,
  projectProfile,
  selected,
  teamSource,
  recommendations,
  onSelect,
}: {
  teams: TeamSpec[];
  projectProfile: string | null;
  selected: string;
  teamSource: TeamSource;
  recommendations: TeamRecommendation[];
  onSelect: (name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const recByTeam = new Map(recommendations.map((r) => [r.team, r]));
  const rank = (t: TeamSpec) => {
    const i = recommendations.findIndex((r) => r.team === t.name);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  const filtered = teams
    .filter(
      (t) => t.name.toLowerCase().includes(query.toLowerCase()) || (t.description ?? "").toLowerCase().includes(query.toLowerCase()),
    )
    // Recommended teams surface first (in recommendation order); the sort is
    // stable, so everything else keeps its catalog order.
    .sort((a, b) => rank(a) - rank(b));
  const compatible = (t: TeamSpec) =>
    !projectProfile || !t.profiles_compatible || t.profiles_compatible.length === 0 || t.profiles_compatible.includes(projectProfile);

  return (
    <>
      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Search teams…"
        className="mb-2 w-full rounded-sm border border-line-2 bg-bg-2 px-2 py-1.5 text-[12px] text-ink-1 outline-none focus:border-accent"
      />
      {teamSource === "recommended" && selected && (
        <p className="mb-2 text-[11px] text-ink-3">Preselected by the recommender — pick any other team to override.</p>
      )}
      <div className="grid max-h-72 grid-cols-1 gap-2 overflow-auto sm:grid-cols-2">
        {filtered.map((t) => {
          const ok = compatible(t);
          const rec = recByTeam.get(t.name);
          return (
            <button
              key={t.name}
              type="button"
              data-testid={`team-${t.name}`}
              onClick={() => onSelect(t.name)}
              className={cn("rounded-md border p-2 text-left transition-colors",
                selected === t.name ? "border-accent bg-bg-3" : "border-line-1 bg-bg-2 hover:border-line-2",
                !ok && "opacity-45")}
              title={ok ? undefined : `Profile ${projectProfile} not in profiles_compatible`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-medium text-ink-1">{t.name}</span>
                <span className="flex items-center gap-1">
                  {rec && <Pill tone="accent">recommended · {rec.confidence}</Pill>}
                  {t.origin && <Pill>{t.origin}</Pill>}
                </span>
              </div>
              <p className="mt-0.5 line-clamp-2 text-[11px] text-ink-3">{t.description}</p>
              <div className="mt-1 flex flex-wrap gap-1">
                {(t.stages ?? []).slice(0, 5).map((s, i) => (
                  <Pill key={i}>{s.kind}</Pill>
                ))}
                {!t.stages && (t.taxonomy_required ?? []).slice(0, 4).map((tx) => (
                  <Pill key={tx} tone="accent">{tx}</Pill>
                ))}
              </div>
            </button>
          );
        })}
      </div>
    </>
  );
}

function CandidatePreview({ n, models }: { n: number; models: ModelInfo[] }) {
  // Derive the rotation from the fetched catalog: one model per distinct
  // vendor (catalog order), cycled across candidates. No hardcoded ids.
  const seen = new Set<string>();
  const rotation: string[] = [];
  for (const m of models) {
    if (!seen.has(m.vendor)) {
      seen.add(m.vendor);
      rotation.push(m.id);
    }
  }
  if (rotation.length === 0) {
    return <p className="mt-3 text-[11px] text-ink-3">candidate models resolve at launch</p>;
  }
  return (
    <div className="mt-3 space-y-1">
      {Array.from({ length: n }).map((_, i) => (
        <div key={i} className="flex items-center justify-between rounded-sm bg-bg-2 px-2 py-1 text-[11px]">
          <span className="text-ink-3">candidate {i + 1}</span>
          <span className="mono text-ink-1">{rotation[i % rotation.length]}</span>
          <span className="mono text-ink-3">seed {String(i + 1).padStart(2, "0")}</span>
        </div>
      ))}
    </div>
  );
}

/* ── Step 3 ────────────────────────────────────────────────────────────── */

function StepOptions({
  state,
  profiles,
  estimate,
  dayRemaining,
  overCap,
  suggestTeamMode,
  suggestedTeam,
  onScope,
  onProfile,
  onTierCap,
  onTierFloor,
  onSwitchToTeamMode,
  onDismissSuggestion,
}: {
  state: WizardState;
  profiles: string[];
  estimate: { minUsd: number; maxUsd: number };
  dayRemaining: number | null;
  overCap: boolean;
  suggestTeamMode: boolean;
  suggestedTeam: string | null;
  onScope: (s: ScopeOverride) => void;
  onProfile: (p: string) => void;
  onTierCap: (t: ClaudeTier | "") => void;
  onTierFloor: (t: ClaudeTier | "") => void;
  onSwitchToTeamMode: () => void;
  onDismissSuggestion: () => void;
}) {
  const tiersDisabled = tierControlsDisabled(state.mode);
  const showModeSuggestion =
    (state.scope === "major" || suggestTeamMode) && state.mode !== "team" && !state.dismissedModeSuggestion;
  return (
    <>
      <Card title="Scope override">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(["auto", "trivial", "standard", "major"] as ScopeOverride[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onScope(s)}
              className={cn("rounded-md border px-2 py-1.5 text-[12px] transition-colors",
                state.scope === s ? "border-accent bg-bg-3 text-ink-1" : "border-line-1 bg-bg-2 text-ink-2 hover:border-line-2")}
            >
              {s}
            </button>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-ink-3">{SCOPE_HINT[state.scope]}</p>
      </Card>

      {showModeSuggestion && (
        <div
          data-testid="team-mode-nudge"
          className="rounded-md border border-[color-mix(in_srgb,var(--warn)_45%,transparent)] bg-bg-2 p-2.5"
        >
          <p className="text-[12px] text-warn">Major scope requires a team pipeline — switch to team mode?</p>
          <div className="mt-2 flex items-center gap-2">
            <Button size="sm" onClick={onSwitchToTeamMode} data-testid="nudge-switch">
              {suggestedTeam ? `Switch to team mode — ${suggestedTeam}` : "Switch to team mode"}
            </Button>
            <Button size="sm" variant="ghost" onClick={onDismissSuggestion} data-testid="nudge-dismiss">
              Dismiss
            </Button>
          </div>
        </div>
      )}

      <Card title="Profile & tier caps">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div>
            <label className="block text-[12px] text-ink-2">Profile</label>
            <select value={state.profile} onChange={(e) => onProfile(e.target.value)} className="mt-1 w-full rounded-sm border border-line-2 bg-bg-2 px-2 py-1.5 text-[12px] text-ink-1 outline-none focus:border-accent">
              <option value="">auto-detect</option>
              {profiles.map((p) => (<option key={p} value={p}>{p}</option>))}
            </select>
          </div>
          <TierSelect label="Tier cap" value={state.tierCap} disabled={tiersDisabled} onChange={onTierCap} />
          <TierSelect label="Tier floor" value={state.tierFloor} disabled={tiersDisabled} onChange={onTierFloor} />
        </div>
        {tiersDisabled && (
          <p className="mt-2 text-[11px] text-warn">Tier caps are ignored in best-of mode (the daemon 422s on them) — candidates rotate tiers by design.</p>
        )}
      </Card>

      <Card title="Estimated cost">
        <div className="flex items-baseline justify-between">
          <span className="mono text-[15px] text-ink-1">{formatUsd(estimate.minUsd)} – {formatUsd(estimate.maxUsd)}</span>
          {dayRemaining != null ? (
            <span className="text-[11px] text-ink-3">day remaining: <span className="mono">{formatUsd(dayRemaining)}</span></span>
          ) : (
            <span className="text-[11px] text-ink-3">no day cap set</span>
          )}
        </div>
        {overCap && (
          <p className="mt-2 text-[11px] text-fail">Estimated max exceeds the remaining day budget — the run may trip the cap and downgrade or block.</p>
        )}
      </Card>
    </>
  );
}

function TierSelect({ label, value, disabled, onChange }: { label: string; value: ClaudeTier | ""; disabled?: boolean; onChange: (v: ClaudeTier | "") => void }) {
  return (
    <div>
      <label className="block text-[12px] text-ink-2">{label}</label>
      <select
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value as ClaudeTier | "")}
        className="mono mt-1 w-full rounded-sm border border-line-2 bg-bg-2 px-2 py-1.5 text-[12px] text-ink-1 outline-none focus:border-accent disabled:opacity-40"
      >
        <option value="">none</option>
        {CLAUDE_TIERS.map((t) => (<option key={t} value={t}>{t}</option>))}
      </select>
    </div>
  );
}

/* ── Step 4 ────────────────────────────────────────────────────────────── */

function StepReview({
  state,
  stageCount,
  estimate,
  overCap,
  recommendation,
}: {
  state: WizardState;
  stageCount: number;
  estimate: { minUsd: number; maxUsd: number };
  overCap: boolean;
  recommendation: TeamRecommendResponse | null;
}) {
  const appliedRec = recommendation?.recommendations.find((r) => r.team === state.team) ?? null;
  const teamSourceLabel =
    state.teamSource === "recommended"
      ? `recommended${appliedRec ? ` (${appliedRec.confidence})` : ""}`
      : "manual";
  const rows: [string, string][] = [
    ["project", state.projectPath],
    ["mode", state.mode === "best_of" ? `best-of ${state.n}` : state.mode],
    ...(state.mode === "team" ? [["team", state.team] as [string, string]] : []),
    ...(state.mode === "team" ? [["team source", teamSourceLabel] as [string, string]] : []),
    ...(state.mode === "review" ? [["forum", state.forum] as [string, string]] : []),
    ["scope", state.scope],
    ["profile", state.profile || "auto-detect"],
    ["tier cap", state.tierCap || "—"],
    ["stages (est)", String(stageCount)],
  ];
  return (
    <Card title="Review & launch">
      <p className="mb-3 rounded-sm bg-bg-2 px-2 py-1.5 text-[13px] text-ink-1">{state.requestText}</p>
      <dl className="grid grid-cols-[120px_1fr] gap-y-1.5 text-[12px]">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-ink-3">{k}</dt>
            <dd className="mono text-ink-1">{v}</dd>
          </div>
        ))}
        <div className="contents">
          <dt className="text-ink-3">est. cost</dt>
          <dd className={cn("mono", overCap ? "text-fail" : "text-ink-1")}>{formatUsd(estimate.minUsd)} – {formatUsd(estimate.maxUsd)}</dd>
        </div>
      </dl>
    </Card>
  );
}
