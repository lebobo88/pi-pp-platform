import type { ModelInfo, ProviderStatus } from "@shared/api-types";
import { Page } from "@/layout/Page";
import { Card } from "@/components/Card";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { StatusChip, StatusDot } from "@/components/StatusChip";
import { KeyValue } from "@/components/KeyValue";
import { Pill, TierChip } from "@/features/common/chips";
import { useProviders, useModels } from "@/api/queries/providers";
import { formatUsd } from "@/lib/format";

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
    </Card>
  );
}
