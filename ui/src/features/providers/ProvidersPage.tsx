import { useState } from "react";
import type { ModelInfo, ProviderStatus, ProviderTestResult } from "@shared/api-types";
import { Page } from "@/layout/Page";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { StatusChip, StatusDot } from "@/components/StatusChip";
import { KeyValue } from "@/components/KeyValue";
import { Pill, TierChip } from "@/features/common/chips";
import { useProviders, useModels } from "@/api/queries/providers";
import { useSetProviderKey, useTestProvider } from "@/api/mutations/providers";
import { toast } from "@/stores/uiStore";
import { formatUsd, formatDuration } from "@/lib/format";

export function ProvidersPage() {
  const { data: providers, isLoading } = useProviders();
  const { data: models } = useModels();

  const modelColumns: Column<ModelInfo>[] = [
    { key: "id", header: "Model", render: (m) => m.id, sortValue: (m) => m.id, mono: true },
    { key: "vendor", header: "Vendor", render: (m) => <Pill>{m.vendor}</Pill>, sortValue: (m) => m.vendor },
    { key: "tier", header: "Tier", render: (m) => (m.tier ? <TierChip tier={m.tier} /> : <span className="text-ink-3">—</span>), sortValue: (m) => m.tier ?? "" },
    { key: "in", header: "$/1M in", render: (m) => formatUsd(m.input_per_1m), sortValue: (m) => m.input_per_1m, mono: true, align: "right" },
    { key: "out", header: "$/1M out", render: (m) => formatUsd(m.output_per_1m), sortValue: (m) => m.output_per_1m, mono: true, align: "right" },
  ];

  return (
    <Page title="Providers & Models" description="Vendor credentials, health, and the priced model catalog." className="space-y-4">
      {isLoading ? (
        <EmptyState title="Loading providers…" compact />
      ) : (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {(providers ?? []).map((p) => (
            <ProviderCard key={p.vendor} provider={p} />
          ))}
        </div>
      )}

      <Card title="Model catalog" flush>
        <DataTable
          columns={modelColumns}
          rows={models ?? []}
          rowKey={(m) => m.id}
          initialSort={{ key: "in", dir: "desc" }}
          empty={<EmptyState title="No models" compact />}
        />
      </Card>
    </Page>
  );
}

function ProviderCard({ provider }: { provider: ProviderStatus }) {
  const tone = provider.degraded ? "warn" : provider.configured ? "pass" : "dim";
  const [keyOpen, setKeyOpen] = useState(false);
  const test = useTestProvider(provider.vendor);
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);

  return (
    <Card
      title={<span className="flex items-center gap-2 text-ink-1"><StatusDot tone={tone} pulse={provider.configured && !provider.degraded} /> {provider.vendor}</span>}
      actions={<StatusChip tone={tone} label={provider.degraded ? "degraded" : provider.configured ? "ready" : "unconfigured"} />}
    >
      <KeyValue
        labelWidth={92}
        rows={[
          { label: "cli", value: provider.cli_version ?? (provider.cli_installed ? "installed" : "missing"), mono: true },
          { label: "api key", value: provider.has_api_key ? (provider.masked_key ?? "set") : "—", mono: true },
          { label: "logged in", value: provider.logged_in ? "yes" : "no" },
        ]}
      />

      <div className="mt-3 flex items-center gap-2 border-t border-line-1 pt-2">
        <Button size="sm" onClick={() => setKeyOpen(true)}>{provider.has_api_key ? "Replace key" : "Set key"}</Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={test.isPending}
          onClick={() =>
            test.mutate(undefined, {
              onSuccess: (r) => setTestResult(r),
              onError: (e) => toast({ tone: "error", title: "Test failed", message: e instanceof Error ? e.message : "" }),
            })
          }
        >
          {test.isPending ? "Testing…" : "Test"}
        </Button>
        {testResult && (
          <span className="flex items-center gap-1.5 text-[11px]">
            <StatusDot tone={testResult.ok ? "pass" : "fail"} />
            <span className="mono text-ink-3">{testResult.model}{testResult.wall_ms != null ? ` · ${formatDuration(testResult.wall_ms)}` : ""}</span>
          </span>
        )}
      </div>

      <SetKeyModal vendor={provider.vendor} open={keyOpen} onClose={() => setKeyOpen(false)} />
    </Card>
  );
}

/** Write-only key entry. The value is sent once and never read back. */
function SetKeyModal({ vendor, open, onClose }: { vendor: string; open: boolean; onClose: () => void }) {
  const [value, setValue] = useState("");
  const setKey = useSetProviderKey(vendor);
  const valid = value.trim().length >= 8;

  const submit = () => {
    setKey.mutate(value.trim(), {
      onSuccess: (p) => {
        toast({ tone: "success", title: `${vendor} key saved`, message: p.masked_key ?? "" });
        setValue("");
        onClose();
      },
      onError: (e) => toast({ tone: "error", title: "Could not save key", message: e instanceof Error ? e.message : "" }),
    });
  };

  return (
    <Modal
      open={open}
      onClose={() => { setValue(""); onClose(); }}
      title={`Set ${vendor} API key`}
      footer={
        <>
          <Button variant="ghost" onClick={() => { setValue(""); onClose(); }}>Cancel</Button>
          <Button variant="primary" disabled={!valid || setKey.isPending} onClick={submit} data-testid="save-key">
            {setKey.isPending ? "Saving…" : "Save key"}
          </Button>
        </>
      }
    >
      <label className="block text-[12px] text-ink-2">API key</label>
      <input
        type="password"
        autoComplete="off"
        data-testid="key-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="paste key — write-only, never displayed"
        className="mono mt-1 w-full rounded-sm border border-line-2 bg-bg-2 px-2 py-1.5 text-[12px] text-ink-1 outline-none focus:border-accent"
      />
      <p className="mt-2 text-[11px] text-ink-3">
        The key is write-only: it is sent to the daemon once and is never returned to the UI. Only a
        masked fragment (e.g. <span className="mono">sk-ant-…4f9c</span>) is shown afterward.
      </p>
    </Modal>
  );
}
