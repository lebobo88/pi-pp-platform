import { useState } from "react";
import { useNavigate } from "react-router";
import type { RunMode, ClaudeTier, StartRunRequest } from "@shared/api-types";
import { RUN_MODE, CLAUDE_TIERS } from "@shared/api-types";
import { Page } from "@/layout/Page";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { EmptyState } from "@/components/EmptyState";
import { Pill } from "@/features/common/chips";
import { cn } from "@/lib/cn";
import { useProjects } from "@/api/queries/projects";
import { useProfiles, useTeams } from "@/api/queries/library";
import { useStartRun } from "@/api/mutations/runs";
import { useUiStore, toast } from "@/stores/uiStore";
import { ApiClientError } from "@/api/client";

/** Section-8 governance forums (static — no list endpoint yet). */
const FORUMS = [
  "architecture-review",
  "security-review",
  "data-governance",
  "api-design-review",
  "release-readiness",
  "cost-review",
];

const MODE_LABEL: Record<RunMode, string> = {
  single: "Single",
  best_of: "Best-of-N",
  team: "Team",
  review: "Review",
};

const MODE_HINT: Record<RunMode, string> = {
  single: "One generator, one judge, Reflexion ×1 on failure.",
  best_of: "N parallel candidates; Borda picks a winner.",
  team: "A specialized multi-stage team pipeline.",
  review: "A governance forum review pipeline.",
};

export function NewRunPage() {
  const navigate = useNavigate();
  const activeProject = useUiStore((s) => s.activeProjectPath);
  const { data: projects } = useProjects();
  const { data: profiles } = useProfiles();
  const { data: teams } = useTeams();
  const startRun = useStartRun();

  const [projectPath, setProjectPath] = useState(activeProject ?? "");
  const [requestText, setRequestText] = useState("");
  const [mode, setMode] = useState<RunMode>("single");
  const [profile, setProfile] = useState("");
  const [team, setTeam] = useState("");
  const [forum, setForum] = useState(FORUMS[0]!);
  const [n, setN] = useState(3);
  const [tierCap, setTierCap] = useState<ClaudeTier | "">("");
  const [tierFloor, setTierFloor] = useState<ClaudeTier | "">("");

  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const canSubmit =
    projectPath.trim().length > 0 &&
    requestText.trim().length >= 8 &&
    (mode !== "best_of" || (n >= 2 && n <= 7)) &&
    (mode !== "team" || team.length > 0);

  const submit = () => {
    setFieldErrors({});
    const req: StartRunRequest = {
      project_path: projectPath.trim(),
      request_text: requestText.trim(),
      mode,
      profile: profile || null,
      team: mode === "team" ? team || null : null,
      forum: mode === "review" ? forum || null : null,
      n: mode === "best_of" ? n : null,
      tier_cap: tierCap || null,
      tier_floor: tierFloor || null,
    };
    startRun.mutate(req, {
      onSuccess: (res) => {
        toast({ tone: "success", title: "Run started", message: res.run_id });
        navigate(`/runs/${res.run_id}`);
      },
      onError: (err) => {
        if (err instanceof ApiClientError && err.fieldErrors) {
          setFieldErrors(err.fieldErrors);
        }
        toast({ tone: "error", title: "Could not start run", message: err instanceof Error ? err.message : "Unknown error" });
      },
    });
  };

  return (
    <Page title="New run" description="Compose a request and dispatch it through the lifecycle.">
      <div className="mx-auto max-w-2xl space-y-4">
        {/* Project */}
        <Card title="Project">
          <select
            data-testid="wizard-project"
            value={projectPath}
            onChange={(e) => setProjectPath(e.target.value)}
            className="w-full rounded-sm border border-line-2 bg-bg-2 px-2 py-1.5 text-[12px] text-ink-1 outline-none focus:border-accent"
          >
            <option value="">Select a project…</option>
            {(projects ?? []).map((p) => (
              <option key={p.path} value={p.path}>{p.name} — {p.path}</option>
            ))}
          </select>
          <FieldError msg={fieldErrors.project_path} />
        </Card>

        {/* Request */}
        <Card title="Request">
          <textarea
            data-testid="wizard-request"
            value={requestText}
            onChange={(e) => setRequestText(e.target.value)}
            rows={4}
            placeholder="Describe the change you want the harness to make…"
            className="w-full resize-y rounded-sm border border-line-2 bg-bg-2 px-2 py-1.5 text-[13px] text-ink-1 outline-none focus:border-accent"
          />
          <FieldError msg={fieldErrors.request_text} />
        </Card>

        {/* Mode */}
        <Card title="Mode">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {RUN_MODE.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                className={cn(
                  "rounded-md border px-2 py-2 text-left transition-colors",
                  mode === m ? "border-accent bg-bg-3" : "border-line-1 bg-bg-2 hover:border-line-2",
                )}
              >
                <span className="block text-[12px] font-medium text-ink-1">{MODE_LABEL[m]}</span>
              </button>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-ink-3">{MODE_HINT[mode]}</p>

          {mode === "best_of" && (
            <div className="mt-3">
              <label className="text-[12px] text-ink-2">Candidates (N)</label>
              <input
                type="number"
                min={2}
                max={7}
                value={n}
                onChange={(e) => setN(Number(e.target.value))}
                className="mono ml-2 w-16 rounded-sm border border-line-2 bg-bg-2 px-2 py-1 text-[12px] text-ink-1 outline-none focus:border-accent"
              />
            </div>
          )}
          {mode === "team" && (
            <div className="mt-3">
              <label className="block text-[12px] text-ink-2">Team</label>
              <select
                value={team}
                onChange={(e) => setTeam(e.target.value)}
                className="mt-1 w-full rounded-sm border border-line-2 bg-bg-2 px-2 py-1.5 text-[12px] text-ink-1 outline-none focus:border-accent"
              >
                <option value="">Select a team…</option>
                {(teams ?? []).map((t) => (
                  <option key={t.name} value={t.name}>{t.name}</option>
                ))}
              </select>
            </div>
          )}
          {mode === "review" && (
            <div className="mt-3">
              <label className="block text-[12px] text-ink-2">Forum</label>
              <select
                value={forum}
                onChange={(e) => setForum(e.target.value)}
                className="mt-1 w-full rounded-sm border border-line-2 bg-bg-2 px-2 py-1.5 text-[12px] text-ink-1 outline-none focus:border-accent"
              >
                {FORUMS.map((f) => (
                  <option key={f} value={f}>{f}</option>
                ))}
              </select>
            </div>
          )}
        </Card>

        {/* Advanced */}
        <Card title="Profile & tier caps">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <label className="block text-[12px] text-ink-2">Profile</label>
              <select
                value={profile}
                onChange={(e) => setProfile(e.target.value)}
                className="mt-1 w-full rounded-sm border border-line-2 bg-bg-2 px-2 py-1.5 text-[12px] text-ink-1 outline-none focus:border-accent"
              >
                <option value="">auto-detect</option>
                {(profiles ?? []).map((p) => (
                  <option key={p.name} value={p.name}>{p.name}</option>
                ))}
              </select>
            </div>
            <TierSelect label="Tier cap" value={tierCap} onChange={setTierCap} />
            <TierSelect label="Tier floor" value={tierFloor} onChange={setTierFloor} />
          </div>
          <p className="mt-2 text-[11px] text-ink-3">
            Tier <Pill>fable</Pill> is capability-gated and never auto-escalated to; select it explicitly only for deep-reasoning work.
          </p>
        </Card>

        <div className="flex items-center justify-between">
          <Button variant="ghost" onClick={() => navigate("/runs")}>Cancel</Button>
          <Button
            data-testid="wizard-submit"
            variant="primary"
            disabled={!canSubmit || startRun.isPending}
            onClick={submit}
          >
            {startRun.isPending ? "Starting…" : "Start run"}
          </Button>
        </div>

        {!projects?.length && (
          <EmptyState compact title="No projects yet" description="Register a project first from the Projects screen." />
        )}
      </div>
    </Page>
  );
}

function TierSelect({
  label,
  value,
  onChange,
}: {
  label: string;
  value: ClaudeTier | "";
  onChange: (v: ClaudeTier | "") => void;
}) {
  return (
    <div>
      <label className="block text-[12px] text-ink-2">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as ClaudeTier | "")}
        className="mono mt-1 w-full rounded-sm border border-line-2 bg-bg-2 px-2 py-1.5 text-[12px] text-ink-1 outline-none focus:border-accent"
      >
        <option value="">none</option>
        {CLAUDE_TIERS.map((t) => (
          <option key={t} value={t}>{t}</option>
        ))}
      </select>
    </div>
  );
}

function FieldError({ msg }: { msg?: string }) {
  if (!msg) return null;
  return <p className="mt-1 text-[11px] text-fail">{msg}</p>;
}
