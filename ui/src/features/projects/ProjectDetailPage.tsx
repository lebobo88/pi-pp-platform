import { useState } from "react";
import { useParams, useNavigate } from "react-router";
import type { DocStatus } from "@shared/api-types";
import { Page } from "@/layout/Page";
import { Card } from "@/components/Card";
import { Tabs } from "@/components/Tabs";
import { Markdown } from "@/components/Markdown";
import { KeyValue } from "@/components/KeyValue";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { StatusChip } from "@/components/StatusChip";
import { CopyButton } from "@/components/CopyButton";
import { Pill, RunStatusChip, ModeChip } from "@/features/common/chips";
import {
  useProject,
  useMasterPlan,
  useAgentsMd,
  useConstitution,
} from "@/api/queries/projects";
import { useProfile, useProfiles } from "@/api/queries/library";
import { useBootstrapProfile, useDetectProfile, useWriteProfile } from "@/api/mutations/misc";
import { ApiClientError } from "@/api/client";
import { DiffView } from "@/components/DiffView";
import { Button } from "@/components/Button";
import { toast } from "@/stores/uiStore";
import { formatRelative, shortId } from "@/lib/format";
import type { RunSummary } from "@shared/api-types";

type TabId = "overview" | "profile" | "master-plan" | "agents-md" | "constitution";

export function ProjectDetailPage() {
  const { projectPath } = useParams();
  const navigate = useNavigate();
  const path = projectPath ? decodeURIComponent(projectPath) : undefined;
  const { data: project, isLoading, error } = useProject(path);
  const [tab, setTab] = useState<TabId>("overview");

  if (isLoading) return <Page title="Project"><EmptyState title="Loading…" compact /></Page>;
  if (error || !project) return <Page title="Project"><EmptyState title="Project not found" description={path} /></Page>;

  return (
    <Page
      title={project.name}
      description={<span className="mono">{project.path}</span>}
      className="space-y-4"
    >
      <Tabs
        active={tab}
        onChange={(t) => setTab(t as TabId)}
        items={[
          { id: "overview", label: "Overview" },
          { id: "profile", label: "Profile" },
          { id: "master-plan", label: "Master plan" },
          { id: "agents-md", label: "AGENTS.md" },
          { id: "constitution", label: "Constitution" },
        ]}
      />

      {tab === "overview" && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
          <div className="space-y-4">
            <Card title="Overview">
              <KeyValue
                rows={[
                  { label: "profile", value: project.active_profile ? <Pill tone="accent">{project.active_profile}</Pill> : "—" },
                  { label: "runs", value: project.run_count, mono: true },
                  { label: "last run", value: formatRelative(project.last_run_at) },
                ]}
              />
            </Card>
            <Card title="Managed documents">
              <div className="space-y-2">
                <DocRow label="CONSTITUTION.md" status={project.constitution} />
                <DocRow label="AGENTS.md" status={project.agents_md} />
                <DocRow label="PROJECT_MASTER.md" status={project.master_plan} />
              </div>
            </Card>
            <ProfileBootstrap projectPath={project.path} current={project.active_profile} />
          </div>
          <Card title="Recent runs" flush>
            <RecentRunsTable runs={project.recent_runs} onOpen={(id) => navigate(`/runs/${id}`)} />
          </Card>
        </div>
      )}

      {tab === "profile" && <ProfileView name={project.active_profile} path={project.path} />}
      {tab === "master-plan" && <MasterPlanPanel path={path!} />}
      {tab === "agents-md" && <AgentsMdPanel path={path!} />}
      {tab === "constitution" && <ConstitutionPanel path={path!} />}
    </Page>
  );
}

/** Detected-profile preview with a confirm-to-write step. */
function DetectPreview({
  path,
  result,
  onDone,
}: {
  path: string;
  result: import("@shared/api-types").DetectProfileResult;
  onDone: () => void;
}) {
  const write = useWriteProfile(path);
  return (
    <div className="mt-3 rounded-md border border-line-1 bg-bg-1 p-3">
      <div className="flex items-center gap-2">
        <span className="text-[12px] text-ink-2">detected</span>
        <Pill tone="accent">{result.detected}</Pill>
        {result.current && <span className="text-[11px] text-ink-3">(was {result.current})</span>}
      </div>
      <ul className="mt-2 list-disc pl-5 text-[11px] text-ink-3">
        {result.reasons.map((r, i) => (<li key={i}>{r}</li>))}
      </ul>
      {result.diff && <div className="mt-2"><DiffView patch={result.diff} /></div>}
      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          variant="primary"
          disabled={write.isPending}
          onClick={() =>
            write.mutate(
              { profile: result.detected },
              {
                onSuccess: () => { toast({ tone: "success", title: "Profile written", message: result.detected }); onDone(); },
                onError: (e) => toast({ tone: "error", title: "Write failed", message: e instanceof Error ? e.message : "" }),
              },
            )
          }
        >
          {write.isPending ? "Writing…" : "Confirm & write profile.yaml"}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>Dismiss</Button>
      </div>
    </div>
  );
}

/** Apply a built-in profile to the project (bootstrap). */
function ProfileBootstrap({ projectPath, current }: { projectPath: string; current: string | null }) {
  const { data: profiles } = useProfiles();
  const bootstrap = useBootstrapProfile();
  const [choice, setChoice] = useState(current ?? "");

  return (
    <Card title="Bootstrap profile">
      <p className="mb-2 text-[11px] text-ink-3">
        Apply a built-in profile to seed <span className="mono">.harness/profile.yaml</span> and the gate policy.
      </p>
      <div className="flex items-center gap-2">
        <select
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
          className="flex-1 rounded-sm border border-line-2 bg-bg-2 px-2 py-1.5 text-[12px] text-ink-1 outline-none focus:border-accent"
        >
          <option value="">Select a profile…</option>
          {(profiles ?? []).map((p) => (
            <option key={p.name} value={p.name}>{p.name}</option>
          ))}
        </select>
        <Button
          size="sm"
          variant="primary"
          disabled={!choice || bootstrap.isPending}
          onClick={() =>
            bootstrap.mutate(
              { project_path: projectPath, profile: choice },
              {
                onSuccess: () => toast({ tone: "success", title: "Profile applied", message: choice }),
                onError: (e) => toast({ tone: "error", title: "Bootstrap failed", message: e instanceof Error ? e.message : "" }),
              },
            )
          }
        >
          {bootstrap.isPending ? "Applying…" : "Apply"}
        </Button>
      </div>
    </Card>
  );
}

function DocRow({ label, status }: { label: string; status: DocStatus }) {
  return (
    <div className="flex items-center justify-between gap-2">
      <span className="mono text-[12px] text-ink-1">{label}</span>
      <div className="flex items-center gap-2">
        {status.present && status.sections != null && (
          <span className="text-[11px] text-ink-3">{status.sections} sections</span>
        )}
        {status.present && status.updated_at && (
          <span className="text-[11px] text-ink-3">{formatRelative(status.updated_at)}</span>
        )}
        <StatusChip tone={status.present ? "pass" : "warn"} label={status.present ? "present" : "missing"} />
      </div>
    </div>
  );
}

function RecentRunsTable({ runs, onOpen }: { runs: RunSummary[]; onOpen: (id: string) => void }) {
  const columns: Column<RunSummary>[] = [
    { key: "id", header: "Run", render: (r) => shortId(r.id, 12), sortValue: (r) => r.id, mono: true },
    { key: "req", header: "Request", render: (r) => <span className="line-clamp-1">{r.request_text}</span>, sortValue: (r) => r.request_text },
    { key: "mode", header: "Mode", render: (r) => <ModeChip mode={r.mode} /> },
    { key: "status", header: "Status", render: (r) => <RunStatusChip status={r.status} /> },
    { key: "when", header: "Started", render: (r) => formatRelative(r.started_at), sortValue: (r) => r.started_at, mono: true, align: "right" },
  ];
  return (
    <DataTable
      columns={columns}
      rows={runs}
      rowKey={(r) => r.id}
      onRowClick={(r) => onOpen(r.id)}
      initialSort={{ key: "when", dir: "desc" }}
      empty={<EmptyState title="No runs" compact />}
    />
  );
}

/** Editable profile view: resolved spec + a yaml editor with detect + save. */
function ProfileView({ name, path }: { name: string | null; path: string }) {
  const { data: profile, isLoading } = useProfile(name ?? undefined);
  const detect = useDetectProfile(path);
  const write = useWriteProfile(path);
  const [draft, setDraft] = useState<string | null>(null);
  const [yamlError, setYamlError] = useState<string | null>(null);
  const [detectResult, setDetectResult] = useState<import("@shared/api-types").DetectProfileResult | null>(null);

  if (!name) {
    return (
      <Card title="No active profile">
        <p className="text-[12px] text-ink-3">This project has no profile. Detect one to seed <span className="mono">.harness/profile.yaml</span>.</p>
        <div className="mt-2">
          <Button size="sm" variant="primary" disabled={detect.isPending} onClick={() => detect.mutate(undefined, { onSuccess: setDetectResult })}>
            {detect.isPending ? "Detecting…" : "Detect profile"}
          </Button>
        </div>
        {detectResult && <DetectPreview path={path} result={detectResult} onDone={() => setDetectResult(null)} />}
      </Card>
    );
  }
  if (isLoading) return <Card title="Profile"><div className="text-[12px] text-ink-3">Loading…</div></Card>;
  if (!profile) return <EmptyState title="Profile unavailable" compact />;

  const yaml = draft ?? toYamlish(profile);
  const dirty = draft != null && draft !== toYamlish(profile);

  const save = () => {
    setYamlError(null);
    write.mutate(
      { yaml },
      {
        onSuccess: () => { toast({ tone: "success", title: "Profile saved" }); setDraft(null); },
        onError: (e) => {
          if (e instanceof ApiClientError && e.fieldErrors?.yaml) setYamlError(e.fieldErrors.yaml);
          else toast({ tone: "error", title: "Save failed", message: e instanceof Error ? e.message : "" });
        },
      },
    );
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card
        title={<span className="flex items-center gap-2">Profile <Pill tone="accent">{profile.name}</Pill></span>}
        actions={
          <div className="flex items-center gap-2">
            <CopyButton value={yaml} label="Copy" />
            <Button size="sm" variant="primary" disabled={!dirty || write.isPending} onClick={save}>{write.isPending ? "Saving…" : "Save"}</Button>
          </div>
        }
        flush
      >
        <textarea
          value={yaml}
          onChange={(e) => setDraft(e.target.value)}
          spellCheck={false}
          className="mono h-[440px] w-full resize-none bg-bg-0 p-3 text-[12px] leading-relaxed text-ink-2 outline-none"
        />
        {yamlError && <p className="border-t border-line-1 px-3 py-1.5 text-[11px] text-fail">{yamlError}</p>}
      </Card>
      <Card title="Resolved spec">
        <KeyValue
          rows={[
            { label: "description", value: profile.description },
            { label: "extends", value: profile.extends?.join(", ") || "—", mono: true },
            { label: "taxonomy", value: profile.required_taxonomy_sections?.join(", ") || "—", mono: true },
            { label: "artifacts", value: profile.required_artifacts?.join(", ") || "—", mono: true },
            { label: "validators (strict)", value: profile.required_validators_strict?.join(", ") || "—", mono: true },
          ]}
        />
        {profile.notes && <p className="mt-3 border-t border-line-1 pt-2 text-[12px] text-ink-3">{profile.notes}</p>}
      </Card>
    </div>
  );
}

function MasterPlanPanel({ path }: { path: string }) {
  const { data, isLoading } = useMasterPlan(path);
  return <DocCard title="PROJECT_MASTER.md" markdown={data?.markdown} loading={isLoading} sha={data?.sha} />;
}
function AgentsMdPanel({ path }: { path: string }) {
  const { data, isLoading } = useAgentsMd(path);
  return <DocCard title="AGENTS.md" markdown={data?.markdown} loading={isLoading} sha={data?.sha} />;
}
function ConstitutionPanel({ path }: { path: string }) {
  const { data, isLoading } = useConstitution(path);
  return <DocCard title="CONSTITUTION.md" markdown={data?.markdown} loading={isLoading} sha={data?.sha} />;
}

function DocCard({ title, markdown, loading, sha }: { title: string; markdown?: string; loading: boolean; sha?: string }) {
  return (
    <Card
      title={<span className="mono">{title}</span>}
      actions={sha && <><span className="mono text-[11px] text-ink-3">{sha}</span>{markdown && <CopyButton value={markdown} label="Copy" />}</>}
    >
      {loading ? (
        <div className="text-[12px] text-ink-3">Loading…</div>
      ) : markdown ? (
        <Markdown source={markdown} />
      ) : (
        <EmptyState title="Not present" description="This document has not been scaffolded for the project." compact />
      )}
    </Card>
  );
}

/** Minimal object→yaml-ish serializer for the read-only profile view. */
function toYamlish(obj: unknown, indent = 0): string {
  const pad = "  ".repeat(indent);
  if (Array.isArray(obj)) {
    if (obj.length === 0) return "[]";
    return "\n" + obj.map((v) => `${pad}- ${typeof v === "object" ? toYamlish(v, indent + 1).trimStart() : String(v)}`).join("\n");
  }
  if (obj && typeof obj === "object") {
    return Object.entries(obj as Record<string, unknown>)
      .map(([k, v]) => {
        if (v == null) return `${pad}${k}: ~`;
        if (typeof v === "object") return `${pad}${k}:${toYamlish(v, indent + 1)}`;
        return `${pad}${k}: ${String(v)}`;
      })
      .join("\n");
  }
  return String(obj);
}
