import { useEffect, useState } from "react";
import type { ModelInfo, ProviderStatus, ProviderTestResult, HarnessSettings } from "@shared/api-types";
import { CLAUDE_TIERS } from "@shared/api-types";
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
import { useSettings } from "@/api/queries/system";
import { useSetProviderKey, useTestProvider, useDeleteProviderKey } from "@/api/mutations/providers";
import { useSaveSettings } from "@/api/mutations/misc";
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

      <SettingsPanel providers={providers ?? []} models={models ?? []} />

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

/* ── Tier ladder + judge pool ──────────────────────────────────────────── */

function SettingsPanel({ providers, models }: { providers: ProviderStatus[]; models: ModelInfo[] }) {
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  const [draft, setDraft] = useState<HarnessSettings | null>(null);
  useEffect(() => {
    if (settings) setDraft(settings);
  }, [settings]);

  if (!draft) return null;

  const configuredVendors = new Set(providers.filter((p) => p.configured).map((p) => p.vendor));
  const availableModels = models.filter((m) => configuredVendors.has(m.vendor));
  const vendorOf = (id: string) => models.find((m) => m.id === id)?.vendor ?? "?";

  const judgeVendors = new Set(draft.judge_pool.map(vendorOf));
  const crossVendorOk = judgeVendors.size >= 2;

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const commit = () =>
    save.mutate(draft, {
      onSuccess: () => toast({ tone: "success", title: "Settings saved" }),
      onError: (e) => toast({ tone: "error", title: "Save failed", message: e instanceof Error ? e.message : "" }),
    });

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Card
        title="Tier ladder"
        actions={<Button size="sm" variant="primary" disabled={!dirty || save.isPending} onClick={commit}>Save</Button>}
      >
        <p className="mb-2 text-[11px] text-ink-3">Map each Claude tier to a model. Only models from configured providers are listed.</p>
        <div className="space-y-2">
          {CLAUDE_TIERS.map((tier) => (
            <div key={tier} className="flex items-center gap-2">
              <span className="mono w-16 text-[12px] text-ink-2">{tier}</span>
              <select
                value={draft.tier_models[tier] ?? ""}
                onChange={(e) => setDraft({ ...draft, tier_models: { ...draft.tier_models, [tier]: e.target.value } })}
                className="mono flex-1 rounded-sm border border-line-2 bg-bg-2 px-2 py-1 text-[12px] text-ink-1 outline-none focus:border-accent"
              >
                {(availableModels.length ? availableModels : models).map((m) => (
                  <option key={m.id} value={m.id}>{m.id}</option>
                ))}
              </select>
              {tier === "fable" && <Pill tone="judge" title="capability-gated, never auto-escalated">gated</Pill>}
            </div>
          ))}
        </div>
      </Card>

      <Card
        title="Judge pool"
        actions={<Button size="sm" variant="primary" disabled={!dirty || save.isPending} onClick={commit}>Save</Button>}
      >
        <p className="mb-2 text-[11px] text-ink-3">Ordered judge models. Cross-vendor coverage requires ≥2 vendors.</p>
        <ul className="space-y-1">
          {draft.judge_pool.map((id, i) => (
            <li key={id} className="flex items-center gap-2 rounded-sm bg-bg-2 px-2 py-1">
              <span className="mono w-4 text-[11px] text-ink-3">{i + 1}</span>
              <span className="mono flex-1 text-[12px] text-ink-1">{id}</span>
              <Pill>{vendorOf(id)}</Pill>
              <button type="button" className="text-ink-3 hover:text-ink-1" disabled={i === 0}
                onClick={() => {
                  const next = [...draft.judge_pool];
                  [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
                  setDraft({ ...draft, judge_pool: next });
                }}>↑</button>
              <button type="button" className="text-fail/70 hover:text-fail"
                onClick={() => setDraft({ ...draft, judge_pool: draft.judge_pool.filter((x) => x !== id) })}>✕</button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex items-center gap-2">
          <select
            defaultValue=""
            onChange={(e) => {
              if (e.target.value && !draft.judge_pool.includes(e.target.value)) {
                setDraft({ ...draft, judge_pool: [...draft.judge_pool, e.target.value] });
              }
              e.target.value = "";
            }}
            className="mono flex-1 rounded-sm border border-line-2 bg-bg-2 px-2 py-1 text-[12px] text-ink-1 outline-none focus:border-accent"
          >
            <option value="">add judge model…</option>
            {models.filter((m) => !draft.judge_pool.includes(m.id)).map((m) => (
              <option key={m.id} value={m.id}>{m.id}</option>
            ))}
          </select>
        </div>
        {!crossVendorOk && (
          <p className="mt-2 text-[11px] text-warn">All judges share a single vendor — cross-vendor gates (spec/design/security/contract) will have no eligible judge.</p>
        )}
      </Card>
    </div>
  );
}

function ProviderCard({ provider }: { provider: ProviderStatus }) {
  const tone = provider.degraded ? "warn" : provider.configured ? "pass" : "dim";
  const [keyOpen, setKeyOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
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
          { label: "api key", value: provider.has_api_key ? (provider.masked_key ?? "set") : "—", mono: true },
          { label: "configured", value: provider.configured ? "yes" : "no" },
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
        {provider.has_api_key && (
          <Button size="sm" variant="danger" onClick={() => setDeleteOpen(true)}>Remove</Button>
        )}
        {testResult && (
          <span className="flex items-center gap-1.5 text-[11px]">
            <StatusDot tone={testResult.ok ? "pass" : "fail"} />
            <span className="mono text-ink-3">{testResult.model}{testResult.wall_ms != null ? ` · ${formatDuration(testResult.wall_ms)}` : ""}</span>
          </span>
        )}
      </div>

      <SetKeyModal vendor={provider.vendor} open={keyOpen} onClose={() => setKeyOpen(false)} />
      <DeleteKeyModal vendor={provider.vendor} open={deleteOpen} onClose={() => setDeleteOpen(false)} />
    </Card>
  );
}

function DeleteKeyModal({ vendor, open, onClose }: { vendor: string; open: boolean; onClose: () => void }) {
  const del = useDeleteProviderKey(vendor);
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`Remove ${vendor} key?`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="danger"
            disabled={del.isPending}
            onClick={() =>
              del.mutate(undefined, {
                onSuccess: () => { toast({ tone: "warn", title: `${vendor} key removed` }); onClose(); },
                onError: (e) => toast({ tone: "error", title: "Remove failed", message: e instanceof Error ? e.message : "" }),
              })
            }
          >
            {del.isPending ? "Removing…" : "Remove key"}
          </Button>
        </>
      }
    >
      This deletes the stored credential. The vendor becomes <span className="mono">unconfigured</span> until a new key is set.
    </Modal>
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
