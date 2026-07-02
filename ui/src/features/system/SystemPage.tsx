import type { DoctorReport } from "@shared/api-types";
import { Page } from "@/layout/Page";
import { Card } from "@/components/Card";
import { Tabs } from "@/components/Tabs";
import { KeyValue } from "@/components/KeyValue";
import { EmptyState } from "@/components/EmptyState";
import { StatusChip, StatusDot } from "@/components/StatusChip";
import { Pill } from "@/features/common/chips";
import { useState } from "react";
import { useDoctor, useJanitor } from "@/api/queries/system";
import { useRunDoctor, useRunJanitor } from "@/api/mutations/misc";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { toast } from "@/stores/uiStore";
import { formatBytes, formatRelative, formatDuration } from "@/lib/format";

export function SystemPage() {
  const [tab, setTab] = useState<"doctor" | "janitor">("doctor");
  return (
    <Page title="System" description="Daemon health, vendor readiness, and housekeeping." className="space-y-4">
      <Tabs
        active={tab}
        onChange={(t) => setTab(t as "doctor" | "janitor")}
        items={[
          { id: "doctor", label: "Doctor" },
          { id: "janitor", label: "Janitor" },
        ]}
      />
      {tab === "doctor" ? <DoctorPanel /> : <JanitorPanel />}
    </Page>
  );
}

function Check({ ok }: { ok: boolean }) {
  return <StatusDot tone={ok ? "pass" : "fail"} title={ok ? "yes" : "no"} />;
}

function DoctorPanel() {
  const { data, isLoading } = useDoctor();
  const rerun = useRunDoctor();
  if (isLoading) return <EmptyState title="Running doctor…" compact />;
  if (!data) {
    return (
      <div className="space-y-3">
        <EmptyState title="Doctor unavailable" description="The daemon did not respond." />
        <div className="flex justify-center">
          <Button variant="primary" disabled={rerun.isPending} onClick={() => rerun.mutate()}>
            {rerun.isPending ? "Running…" : "Run doctor"}
          </Button>
        </div>
      </div>
    );
  }

  const vendors = Object.keys(data.vendors_configured) as Array<keyof DoctorReport["vendors_configured"]>;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusChip tone={data.db_reachable ? "pass" : "fail"} label={data.db_reachable ? "DB reachable" : "DB down"} />
        <StatusChip tone={data.cross_vendor_ready ? "pass" : "warn"} label={data.cross_vendor_ready ? "cross-vendor ready" : "single-vendor"} />
        {data.gemini_disabled && <StatusChip tone="dim" label="gemini disabled" />}
        <span className="mono text-[11px] text-ink-3">{data.db_path}</span>
        <span className="flex-1" />
        <Button
          size="sm"
          disabled={rerun.isPending}
          onClick={() =>
            rerun.mutate(undefined, {
              onSuccess: () => toast({ tone: "info", title: "Doctor started", message: "result refreshes via the live stream" }),
              onError: (e) => toast({ tone: "error", title: "Doctor failed", message: e instanceof Error ? e.message : "" }),
            })
          }
        >
          {rerun.isPending ? "Starting…" : "Re-run doctor"}
        </Button>
      </div>

      <Card title="Provider matrix" flush>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-line-1 bg-bg-2 text-left text-ink-3">
              <th className="px-3 py-1.5 font-medium">vendor</th>
              <th className="px-3 py-1.5 text-center font-medium">CLI</th>
              <th className="px-3 py-1.5 text-center font-medium">API key</th>
              <th className="px-3 py-1.5 text-center font-medium">logged in</th>
              <th className="px-3 py-1.5 text-center font-medium">configured</th>
              <th className="px-3 py-1.5 text-center font-medium">degraded</th>
            </tr>
          </thead>
          <tbody>
            {vendors.map((v) => {
              const cred = data.vendor_credentials[v];
              return (
                <tr key={v} className="border-b border-line-1/60">
                  <td className="mono px-3 py-1.5 text-ink-1">{v}</td>
                  <td className="px-3 py-1.5 text-center"><Check ok={cred.cli} /></td>
                  <td className="px-3 py-1.5 text-center"><Check ok={cred.api_key} /></td>
                  <td className="px-3 py-1.5 text-center"><Check ok={cred.logged_in} /></td>
                  <td className="px-3 py-1.5 text-center"><Check ok={data.vendors_configured[v]} /></td>
                  <td className="px-3 py-1.5 text-center">
                    {data.vendor_degraded[v] ? <StatusDot tone="fail" title="degraded" /> : <span className="text-ink-3">—</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Card title="Model resolvability (critique smoke)">
          <div className="space-y-2">
            {Object.entries(data.critique_smoke).map(([engine, r]) => (
              <div key={engine} className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-2">
                  <span className="mono text-[12px] text-ink-1">{engine}</span>
                  <Pill>{r.model}</Pill>
                </span>
                <div className="flex items-center gap-2">
                  {r.wall_ms != null && <span className="mono tnum text-[11px] text-ink-3">{formatDuration(r.wall_ms)}</span>}
                  <StatusChip
                    tone={r.status === "ok" ? "pass" : r.status === "fail" ? "fail" : "dim"}
                    label={r.status}
                  />
                </div>
              </div>
            ))}
          </div>
        </Card>

        <Card title="CLI versions">
          <KeyValue
            rows={Object.entries(data.cli_versions).map(([cli, v]) => ({
              label: cli,
              value: v ?? <span className="text-fail">not found</span>,
              mono: true,
            }))}
          />
        </Card>
      </div>

      <Card title="Browser engines">
        <div className="flex flex-wrap items-center gap-3 text-[12px]">
          <span className="flex items-center gap-2">
            <StatusDot tone={data.browser_engines.playwright.status === "ok" ? "pass" : "warn"} />
            <span className="text-ink-2">playwright: <span className="mono">{data.browser_engines.playwright.status}</span></span>
          </span>
          <span className="flex items-center gap-2">
            <StatusDot tone="dim" />
            <span className="text-ink-2">chrome-mcp: <span className="mono">{data.browser_engines.chrome_mcp.status}</span></span>
          </span>
        </div>
      </Card>
    </div>
  );
}

function JanitorPanel() {
  const { data, isLoading } = useJanitor();
  const run = useRunJanitor();
  const [confirmExec, setConfirmExec] = useState(false);
  if (isLoading) return <EmptyState title="Loading janitor report…" compact />;
  if (!data) return <EmptyState title="No janitor report" compact />;

  const dryRun = () =>
    run.mutate(true, {
      onSuccess: (r) => toast({ tone: "info", title: "Janitor dry-run", message: `${r.entries.length} candidates found` }),
      onError: (e) => toast({ tone: "error", title: "Dry-run failed", message: e instanceof Error ? e.message : "" }),
    });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <Card
          title="Last sweep"
          className="flex-1"
          actions={
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" disabled={run.isPending} onClick={dryRun}>Dry run</Button>
              <Button size="sm" variant="danger" disabled={run.isPending} onClick={() => setConfirmExec(true)}>Execute</Button>
            </div>
          }
        >
          <KeyValue
            rows={[
              { label: "ran", value: formatRelative(data.ran_at) },
              { label: "items swept", value: data.swept, mono: true },
              { label: "reclaimed", value: formatBytes(data.reclaimed_bytes), mono: true },
            ]}
          />
        </Card>
      </div>

      <Modal
        open={confirmExec}
        onClose={() => setConfirmExec(false)}
        title="Execute janitor sweep?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmExec(false)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={run.isPending}
              onClick={() =>
                run.mutate(false, {
                  onSuccess: (r) => { toast({ tone: "warn", title: "Janitor executed", message: `swept ${r.swept} items` }); setConfirmExec(false); },
                  onError: (e) => toast({ tone: "error", title: "Execute failed", message: e instanceof Error ? e.message : "" }),
                })
              }
            >
              {run.isPending ? "Sweeping…" : "Delete swept files"}
            </Button>
          </>
        }
      >
        This permanently deletes abandoned worktrees, stale logs, and temp caches older than the retention window. This cannot be undone.
      </Modal>

      <Card title="Swept entries" flush>
        <table className="w-full text-[12px]">
          <thead>
            <tr className="border-b border-line-1 bg-bg-2 text-left text-ink-3">
              <th className="px-3 py-1.5 font-medium">path</th>
              <th className="px-3 py-1.5 font-medium">kind</th>
              <th className="px-3 py-1.5 text-right font-medium">size</th>
              <th className="px-3 py-1.5 text-right font-medium">age</th>
            </tr>
          </thead>
          <tbody>
            {data.entries.map((e, i) => (
              <tr key={i} className="border-b border-line-1/60">
                <td className="mono px-3 py-1.5 text-ink-1">{e.path}</td>
                <td className="px-3 py-1.5"><Pill>{e.kind}</Pill></td>
                <td className="mono tnum px-3 py-1.5 text-right text-ink-2">{formatBytes(e.bytes)}</td>
                <td className="mono tnum px-3 py-1.5 text-right text-ink-3">{e.age_days}d</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
