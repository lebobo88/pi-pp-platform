import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  apiPaths,
  type ModelInfo,
  type ProviderStatus,
  type ProviderTestResult,
  type ProviderModels,
  type ProviderModelsRefreshResponse,
  type InstallableProvider,
  type HarnessSettings,
  type OAuthLoginState,
} from "@shared/api-types";
import { Page } from "@/layout/Page";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { StatusChip, StatusDot } from "@/components/StatusChip";
import { KeyValue } from "@/components/KeyValue";
import { Pill, TierChip } from "@/features/common/chips";
import { useProviders, useModels, useAvailableProviders, useProviderModels, providerModelsKey, useOAuthProviders, useProviderLoginState } from "@/api/queries/providers";
import { useSettings } from "@/api/queries/system";
import { useSetProviderKey, useTestProvider, useDeleteProviderKey, useStartProviderLogin, useProviderLoginInput, useAbortProviderLogin } from "@/api/mutations/providers";
import { useSaveSettings } from "@/api/mutations/misc";
import { api } from "@/api/client";
import { qk } from "@/api/queryKeys";
import { toast } from "@/stores/uiStore";
import { formatUsd, formatDuration } from "@/lib/format";

/** POST /providers/:vendor/models/refresh — re-fetch a provider's live model list. */
function useRefreshProviderModels(vendor: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<ProviderModelsRefreshResponse>(apiPaths.providerModelsRefresh(vendor)),
    onSuccess: (r) => {
      // Seed the ladder/judge autocomplete cache and re-derive the priced catalog.
      qc.setQueryData(providerModelsKey(vendor), { provider: r.provider, models: r.models } satisfies ProviderModels);
      void qc.invalidateQueries({ queryKey: qk.models });
    },
  });
}

export function ProvidersPage() {
  const { data: providers, isLoading } = useProviders();
  const { data: models } = useModels();
  const { data: available } = useAvailableProviders();
  const { data: oauth } = useOAuthProviders();
  const oauthSet = useMemo(() => new Set((oauth?.providers ?? []).map((p) => p.id)), [oauth]);
  const [query, setQuery] = useState("");

  // env_key_hint / display_name captions come from the installable-provider set.
  const hintFor = useMemo(
    () => new Map<string, InstallableProvider>((available ?? []).map((a) => [a.id, a])),
    [available],
  );
  const q = query.trim().toLowerCase();
  const filtered = (providers ?? []).filter((p) => {
    if (!q) return true;
    const hint = hintFor.get(p.vendor);
    return (
      p.vendor.toLowerCase().includes(q) ||
      (hint?.display_name.toLowerCase().includes(q) ?? false) ||
      (hint?.env_key_hint?.toLowerCase().includes(q) ?? false)
    );
  });
  const configuredList = filtered.filter((p) => p.configured);
  const availableList = filtered.filter((p) => !p.configured);

  const modelColumns: Column<ModelInfo>[] = [
    { key: "id", header: "Model", render: (m) => m.id, sortValue: (m) => m.id, mono: true },
    { key: "vendor", header: "Provider", render: (m) => <Pill>{m.vendor}</Pill>, sortValue: (m) => m.vendor },
    { key: "tier", header: "Tier", render: (m) => (m.tier ? <TierChip tier={m.tier} /> : <span className="text-ink-3">—</span>), sortValue: (m) => m.tier ?? "" },
    { key: "in", header: "$/1M in", render: (m) => formatUsd(m.input_per_1m), sortValue: (m) => m.input_per_1m, mono: true, align: "right" },
    { key: "out", header: "$/1M out", render: (m) => formatUsd(m.output_per_1m), sortValue: (m) => m.output_per_1m, mono: true, align: "right" },
  ];

  return (
    <Page title="Providers & Models" description="Configure API keys for any provider, check health, and browse the priced model catalog." className="space-y-4">
      <AddProviderPicker configured={new Set((providers ?? []).map((p) => p.vendor))} />

      {isLoading ? (
        <EmptyState title="Loading providers…" compact />
      ) : (
        <>
          <input
            data-testid="provider-search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search providers… (name or env key)"
            className="w-full max-w-sm rounded-sm border border-line-2 bg-bg-2 px-2 py-1.5 text-[12px] text-ink-1 outline-none focus:border-accent"
          />
          {filtered.length === 0 ? (
            <EmptyState title="No providers match" description="Try a different search." compact />
          ) : (
            <>
              <ProviderGroup label="Configured" providers={configuredList} hintFor={hintFor} oauthSet={oauthSet} />
              <ProviderGroup label="Available" providers={availableList} hintFor={hintFor} oauthSet={oauthSet} />
            </>
          )}
        </>
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

/* ── Provider grid, grouped Configured above Available ─────────────────── */

function ProviderGroup({
  label,
  providers,
  hintFor,
  oauthSet,
}: {
  label: string;
  providers: ProviderStatus[];
  hintFor: Map<string, InstallableProvider>;
  oauthSet: Set<string>;
}) {
  if (providers.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-[11px] uppercase tracking-wide text-ink-3" data-testid={`provider-group-${label.toLowerCase()}`}>
        {label} <span className="mono tnum">({providers.length})</span>
      </h2>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
        {providers.map((p) => (
          <ProviderCard
            key={p.vendor}
            provider={p}
            envKeyHint={hintFor.get(p.vendor)?.env_key_hint ?? null}
            canOAuthLogin={oauthSet.has(p.vendor)}
          />
        ))}
      </div>
    </section>
  );
}

/* ── Add provider ──────────────────────────────────────────────────────── */

function AddProviderPicker({ configured }: { configured: Set<string> }) {
  const { data: available } = useAvailableProviders();
  const [selectedId, setSelectedId] = useState("");
  const [open, setOpen] = useState(false);

  // Offer providers that don't already have a card (not in the enabled set).
  const options = (available ?? []).filter((p) => !configured.has(p.id));
  const selected = options.find((o) => o.id === selectedId) ?? null;
  if (!options.length) return null;

  return (
    <Card title="Add a provider" className="max-w-xl">
      <p className="mb-2 text-[11px] text-ink-3">
        pi supports 30+ providers. Pick one and set its API key — it becomes available as a generator or judge.
      </p>
      <div className="flex items-center gap-2">
        <select
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="mono flex-1 rounded-sm border border-line-2 bg-bg-2 px-2 py-1 text-[12px] text-ink-1 outline-none focus:border-accent"
        >
          <option value="">select a provider…</option>
          {options.map((o) => (
            <option key={o.id} value={o.id}>
              {o.display_name}{o.in_catalog ? "" : " (pi)"}{o.env_key_hint ? ` · ${o.env_key_hint}` : ""}
            </option>
          ))}
        </select>
        <Button size="sm" variant="primary" disabled={!selected} onClick={() => setOpen(true)}>
          Set key
        </Button>
      </div>
      {selected && (
        <SetKeyModal
          vendor={selected.id}
          open={open}
          onClose={() => { setOpen(false); setSelectedId(""); }}
        />
      )}
    </Card>
  );
}

/* ── Tier ladder + judge pool ──────────────────────────────────────────── */

/** Datalist id shared by every ladder/judge model-id input on the page. */
const MODEL_DATALIST_ID = "pp-model-ids";

/** Options for one provider's live model list (GET /providers/:vendor/models). */
function ProviderModelOptions({ vendor, exclude }: { vendor: string; exclude: Set<string> }) {
  const { data } = useProviderModels(vendor);
  return (
    <>
      {(data?.models ?? [])
        .filter((id) => !exclude.has(id))
        .map((id) => (
          <option key={id} value={id}>
            {vendor}
          </option>
        ))}
    </>
  );
}

function SettingsPanel({ providers, models }: { providers: ProviderStatus[]; models: ModelInfo[] }) {
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<HarnessSettings | null>(null);
  const [judgeDraft, setJudgeDraft] = useState("");
  useEffect(() => {
    if (settings) setDraft(settings);
  }, [settings]);

  const configuredVendorList = useMemo(
    () => providers.filter((p) => p.configured).map((p) => p.vendor),
    [providers],
  );
  const configuredVendors = useMemo(
    () => new Set(configuredVendorList),
    [configuredVendorList],
  );
  const catalogIds = useMemo(() => new Set(models.map((m) => m.id)), [models]);

  /** Provider for a model id: a provider-qualified id ("openai/gpt-5.5") pins
   * the vendor outright when that vendor is configured; else priced catalog,
   * then each provider's live list. */
  const vendorFor = (id: string): string | null => {
    const slash = id.indexOf("/");
    if (slash > 0) {
      const prefix = id.slice(0, slash);
      if (configuredVendorList.includes(prefix)) return prefix;
    }
    const m = models.find((x) => x.id === id);
    if (m) return m.vendor;
    for (const v of configuredVendorList) {
      const pm = qc.getQueryData<ProviderModels>(providerModelsKey(v));
      if (pm?.models.includes(id)) return v;
    }
    return null;
  };

  if (!draft) return null;

  const judgeProviders = new Set(draft.judge_pool.map((j) => j.provider));
  const crossVendorOk = judgeProviders.size >= 2;

  const addJudge = () => {
    const id = judgeDraft.trim();
    if (!id) return;
    if (draft.judge_pool.some((j) => j.model === id)) {
      setJudgeDraft("");
      return;
    }
    const provider = vendorFor(id);
    if (!provider) {
      toast({ tone: "error", title: "Unknown model id", message: "pick a model from the suggestions (or refresh the provider's models)" });
      return;
    }
    setDraft({ ...draft, judge_pool: [...draft.judge_pool, { provider, model: id }] });
    setJudgeDraft("");
  };

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const commit = () =>
    save.mutate(draft, {
      onSuccess: () => toast({ tone: "success", title: "Settings saved" }),
      onError: (e) => toast({ tone: "error", title: "Save failed", message: e instanceof Error ? e.message : "" }),
    });
  const SaveBtn = <Button size="sm" variant="primary" disabled={!dirty || save.isPending} onClick={commit}>Save</Button>;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* Shared autocomplete: configured vendors' priced models + each configured provider's live model list. */}
      <datalist id={MODEL_DATALIST_ID}>
        {models.filter((m) => configuredVendors.has(m.vendor)).map((m) => (
          <option key={`${m.vendor}/${m.id}`} value={m.id}>
            {m.vendor}
            {m.tier ? ` · ${m.tier}` : ""}
          </option>
        ))}
        {configuredVendorList.map((v) => (
          <ProviderModelOptions key={v} vendor={v} exclude={catalogIds} />
        ))}
      </datalist>

      <Card title="Generation ladders" actions={SaveBtn}>
        <p className="mb-2 text-[11px] text-ink-3">Map each tier of a generation ladder to a model id. Suggestions come from the priced catalog plus each configured provider's live model list (Refresh models on a provider card re-fetches it).</p>
        <div className="space-y-3">
          {Object.entries(draft.ladders).map(([ladderName, tiers]) => (
            <div key={ladderName} className="space-y-2">
              <div className="mono text-[11px] uppercase tracking-wide text-ink-3">{ladderName}</div>
              {Object.entries(tiers).map(([tier, modelId]) => (
                <div key={tier} className="flex items-center gap-2">
                  <span className="mono w-16 text-[12px] text-ink-2">{tier}</span>
                  <input
                    list={MODEL_DATALIST_ID}
                    value={modelId}
                    spellCheck={false}
                    autoComplete="off"
                    data-testid={`ladder-${ladderName}-${tier}`}
                    onChange={(e) =>
                      setDraft({ ...draft, ladders: { ...draft.ladders, [ladderName]: { ...tiers, [tier]: e.target.value } } })
                    }
                    onBlur={(e) => {
                      const id = e.target.value.trim();
                      if (!id) return;
                      const provider = vendorFor(id);
                      if (!provider || !configuredVendors.has(provider)) {
                        toast({ tone: "error", title: "Unknown model id", message: "pick a model from the suggestions (or refresh the provider's models)" });
                      }
                    }}
                    className="mono flex-1 rounded-sm border border-line-2 bg-bg-2 px-2 py-1 text-[12px] text-ink-1 outline-none focus:border-accent"
                  />
                  {tier === "fable" && <Pill tone="judge" title="capability-gated, never auto-escalated">gated</Pill>}
                </div>
              ))}
            </div>
          ))}
        </div>
      </Card>

      <Card title="Judge pool" actions={SaveBtn}>
        <p className="mb-2 text-[11px] text-ink-3">Ordered judge selections. Cross-provider coverage requires ≥2 distinct providers.</p>
        <ul className="space-y-1">
          {draft.judge_pool.map((j, i) => (
            <li key={`${j.provider}:${j.model}`} className="flex items-center gap-2 rounded-sm bg-bg-2 px-2 py-1">
              <span className="mono w-4 text-[11px] text-ink-3">{i + 1}</span>
              <span className="mono flex-1 text-[12px] text-ink-1">{j.model}</span>
              <Pill>{j.provider}</Pill>
              <button type="button" className="text-ink-3 hover:text-ink-1" disabled={i === 0}
                onClick={() => {
                  const next = [...draft.judge_pool];
                  [next[i - 1], next[i]] = [next[i]!, next[i - 1]!];
                  setDraft({ ...draft, judge_pool: next });
                }}>↑</button>
              <button type="button" className="text-fail/70 hover:text-fail"
                onClick={() => setDraft({ ...draft, judge_pool: draft.judge_pool.filter((_, idx) => idx !== i) })}>✕</button>
            </li>
          ))}
        </ul>
        <div className="mt-2 flex items-center gap-2">
          <input
            list={MODEL_DATALIST_ID}
            value={judgeDraft}
            spellCheck={false}
            autoComplete="off"
            data-testid="judge-model-input"
            onChange={(e) => setJudgeDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") addJudge();
            }}
            placeholder="add judge model id…"
            className="mono flex-1 rounded-sm border border-line-2 bg-bg-2 px-2 py-1 text-[12px] text-ink-1 outline-none focus:border-accent"
          />
          <Button size="sm" disabled={!judgeDraft.trim()} onClick={addJudge} data-testid="judge-model-add">
            Add
          </Button>
        </div>
        {!crossVendorOk && (
          <p className="mt-2 text-[11px] text-warn">All judges share a single provider — cross-vendor gates (spec/design/security/contract) will have no eligible judge.</p>
        )}
      </Card>
    </div>
  );
}

function ProviderCard({
  provider,
  envKeyHint = null,
  canOAuthLogin = false,
}: {
  provider: ProviderStatus;
  envKeyHint?: string | null;
  canOAuthLogin?: boolean;
}) {
  // A subscription/CLI login that hasn't produced a usable key yet reads as a
  // distinct "logged in" state — ready-ish, but not the full "ready" of a
  // resolvable credential.
  const tone = provider.degraded
    ? "warn"
    : provider.configured
      ? "pass"
      : provider.logged_in
        ? "judge"
        : "dim";
  const statusLabel = provider.degraded
    ? "degraded"
    : provider.configured
      ? "ready"
      : provider.logged_in
        ? "logged in"
        : "unconfigured";
  const [keyOpen, setKeyOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const test = useTestProvider(provider.vendor);
  const refresh = useRefreshProviderModels(provider.vendor);
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);

  return (
    <Card
      title={<span className="flex items-center gap-2 text-ink-1"><StatusDot tone={tone} pulse={provider.configured && !provider.degraded} /> {provider.vendor}</span>}
      actions={<StatusChip tone={tone} label={statusLabel} />}
    >
      <KeyValue
        labelWidth={92}
        rows={[
          { label: "api key", value: provider.has_api_key ? (provider.masked_key ?? "set") : "—", mono: true },
          { label: "configured", value: provider.configured ? "yes" : "no" },
          ...(provider.logged_in ? [{ label: "cli login", value: "detected" }] : []),
          ...(envKeyHint ? [{ label: "env key", value: envKeyHint, mono: true }] : []),
        ]}
      />

      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-line-1 pt-2">
        {canOAuthLogin && !provider.configured && (
          <Button size="sm" variant="primary" data-testid={`login-${provider.vendor}`} onClick={() => setLoginOpen(true)}>
            Log in with subscription
          </Button>
        )}
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
        <Button
          size="sm"
          variant="ghost"
          disabled={refresh.isPending}
          data-testid={`refresh-models-${provider.vendor}`}
          onClick={() =>
            refresh.mutate(undefined, {
              onSuccess: (r) =>
                toast({
                  tone: "success",
                  title: `${provider.vendor} models refreshed`,
                  message: `${r.models.length} model id${r.models.length === 1 ? "" : "s"}${r.refreshed ? "" : " (static fallback)"}`,
                }),
              onError: (e) => toast({ tone: "error", title: "Refresh failed", message: e instanceof Error ? e.message : "" }),
            })
          }
        >
          {refresh.isPending ? "Refreshing…" : "Refresh models"}
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
      {canOAuthLogin && <SubscriptionLoginModal vendor={provider.vendor} open={loginOpen} onClose={() => setLoginOpen(false)} />}
    </Card>
  );
}

/**
 * Subscription (OAuth) login flow. Starts on open, polls state, renders the
 * browser URL / device code, and prompts for a paste-a-code step when the flow
 * pauses. Aborts the flow if closed before completion.
 */
function SubscriptionLoginModal({ vendor, open, onClose }: { vendor: string; open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const start = useStartProviderLogin(vendor);
  const abort = useAbortProviderLogin();
  const [loginId, setLoginId] = useState<string | null>(null);
  const [initial, setInitial] = useState<OAuthLoginState | null>(null);
  const [codeValue, setCodeValue] = useState("");

  // Poll while open and not yet terminal.
  const polled = useProviderLoginState(loginId, open && !!loginId);
  const state: OAuthLoginState | undefined = polled.data ?? initial ?? undefined;
  const input = useProviderLoginInput(loginId ?? "");

  // Kick off the flow when the modal opens.
  useEffect(() => {
    if (!open || loginId || start.isPending) return;
    start.mutate(undefined, {
      onSuccess: (s) => { setInitial(s); setLoginId(s.login_id); },
      onError: (e) => toast({ tone: "error", title: "Login could not start", message: e instanceof Error ? e.message : "" }),
    });
  }, [open, loginId, start]);

  // On completion, refresh provider status + close.
  useEffect(() => {
    if (state?.status === "done") {
      toast({ tone: "success", title: `${vendor} subscription connected` });
      void qc.invalidateQueries({ queryKey: qk.providers });
      close(false);
    } else if (state?.status === "error") {
      toast({ tone: "error", title: `${vendor} login failed`, message: state.error ?? "" });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.status]);

  const close = (userAborted: boolean) => {
    if (userAborted && loginId && state && state.status !== "done" && state.status !== "error") {
      abort.mutate(loginId);
    }
    setLoginId(null);
    setInitial(null);
    setCodeValue("");
    onClose();
  };

  const submitCode = () => {
    if (!codeValue.trim()) return;
    input.mutate(codeValue.trim(), {
      onSuccess: () => setCodeValue(""),
      onError: (e) => toast({ tone: "error", title: "Code rejected", message: e instanceof Error ? e.message : "" }),
    });
  };

  return (
    <Modal
      open={open}
      onClose={() => close(true)}
      title={`Log in to ${vendor}`}
      footer={<Button variant="ghost" onClick={() => close(true)}>{state?.status === "done" ? "Close" : "Cancel"}</Button>}
    >
      {!state || state.status === "starting" ? (
        <p className="text-[12px] text-ink-3">Starting subscription login…</p>
      ) : (
        <div className="space-y-3 text-[12px] text-ink-2">
          {state.auth && (
            <div>
              <p className="text-ink-2">Open this URL in your browser to authorize:</p>
              <a href={state.auth.url} target="_blank" rel="noreferrer" className="mono break-all text-accent hover:underline">{state.auth.url}</a>
              {state.auth.instructions && <p className="mt-1 text-ink-3">{state.auth.instructions}</p>}
            </div>
          )}
          {state.device_code && (
            <div className="rounded-sm bg-bg-2 p-2">
              <p>Go to <a href={state.device_code.verification_uri} target="_blank" rel="noreferrer" className="mono text-accent hover:underline">{state.device_code.verification_uri}</a> and enter the code:</p>
              <p className="mono mt-1 select-all text-[18px] tracking-widest text-ink-1">{state.device_code.user_code}</p>
            </div>
          )}
          {state.status === "awaiting_input" && state.prompt && (
            <div>
              <label className="block text-ink-2">{state.prompt.message}</label>
              <div className="mt-1 flex items-center gap-2">
                <input
                  autoFocus
                  value={codeValue}
                  onChange={(e) => setCodeValue(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") submitCode(); }}
                  placeholder={state.prompt.placeholder ?? "paste the code"}
                  className="mono flex-1 rounded-sm border border-line-2 bg-bg-2 px-2 py-1 text-[12px] text-ink-1 outline-none focus:border-accent"
                />
                <Button size="sm" variant="primary" disabled={!codeValue.trim() || input.isPending} onClick={submitCode}>Submit</Button>
              </div>
            </div>
          )}
          {(state.status === "awaiting_browser" || state.status === "awaiting_device_code") && (
            <p className="flex items-center gap-1.5 text-ink-3"><StatusDot tone="run" pulse /> Waiting for you to authorize…</p>
          )}
          {state.status === "error" && <p className="text-fail">{state.error ?? "Login failed."}</p>}
        </div>
      )}
    </Modal>
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
