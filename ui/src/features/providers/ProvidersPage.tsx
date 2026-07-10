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
  type ClaudeTier,
} from "@shared/api-types";
import { Page } from "@/layout/Page";
import { Card } from "@/components/Card";
import { Button } from "@/components/Button";
import { Modal } from "@/components/Modal";
import { DataTable, type Column } from "@/components/DataTable";
import { EmptyState } from "@/components/EmptyState";
import { StatusChip, StatusDot } from "@/components/StatusChip";
import type { StatusTone } from "@/lib/status";
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
import {
  buildProviderModelChoices,
  normalizeLadderOverrides,
  normalizeTierPoolOverrides,
  providerModelLabel,
  resolveProviderModelChoice,
  type ModelRoutingCatalog,
  type ResolvedProviderModelChoice,
} from "@/lib/modelRouting";

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
  const providerLabels = useMemo(
    () => new Map<string, string>((available ?? []).map((a) => [a.id, a.display_name])),
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

      <SettingsPanel providers={providers ?? []} models={models ?? []} providerLabels={providerLabels} />

      <Card title="Model catalog" flush>
        <DataTable
          columns={modelColumns}
          rows={models ?? []}
          rowKey={(m) => `${m.vendor}/${m.id}`}
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
function ProviderModelOptions({
  vendor,
  providerLabel,
  exclude,
}: {
  vendor: string;
  providerLabel: string;
  exclude: Set<string>;
}) {
  const { data } = useProviderModels(vendor);
  return (
    <>
      {(data?.models ?? [])
        .filter((id) => !exclude.has(`${vendor}/${id}`))
        .map((id) => (
          <option key={`${vendor}/${id}`} value={`${vendor}/${id}`}>
            {providerLabel} / {id}
          </option>
        ))}
    </>
  );
}

function SettingsPanel({
  providers,
  models,
  providerLabels,
}: {
  providers: ProviderStatus[];
  models: ModelInfo[];
  providerLabels: Map<string, string>;
}) {
  const { data: settings } = useSettings();
  const save = useSaveSettings();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<HarnessSettings | null>(null);
  const [judgeDraft, setJudgeDraft] = useState("");
  const [ladderInputDrafts, setLadderInputDrafts] = useState<Record<string, string>>({});
  const [poolEditDrafts, setPoolEditDrafts] = useState<Record<string, string>>({});
  const [poolDrafts, setPoolDrafts] = useState<Record<string, string>>({});
  useEffect(() => {
    if (settings) {
      setDraft(settings);
      setJudgeDraft("");
      setLadderInputDrafts({});
      setPoolEditDrafts({});
      setPoolDrafts({});
    }
  }, [settings]);

  const configuredVendorList = useMemo(
    () => providers.filter((p) => p.configured).map((p) => p.vendor),
    [providers],
  );
  const catalogIds = useMemo(
    () => new Set(models.map((m) => `${m.vendor}/${m.id}`)),
    [models],
  );

  if (!draft) return null;

  const routingCatalog = (): ModelRoutingCatalog => ({
    configuredProviders: configuredVendorList,
    catalogModels: models,
    liveModelsByProvider: new Map(
      configuredVendorList.map((vendor) => [
        vendor,
        qc.getQueryData<ProviderModels>(providerModelsKey(vendor))?.models ?? [],
      ]),
    ),
    providerLabels,
  });

  const describeModelChoiceError = (result: ResolvedProviderModelChoice): string => {
    if (result.ok) return "";
    switch (result.reason) {
      case "ambiguous":
        return `choose a provider-specific model id (${(result.providers ?? []).map((p) => providerLabels.get(p) ?? p).join(", ")})`;
      case "provider_unconfigured":
        return `${providerLabels.get(result.provider ?? "") ?? result.provider} is not configured`;
      case "unknown":
        return "pick a known model from the suggestions (or refresh that provider's models)";
      default:
        return "pick a provider-specific model from the suggestions";
    }
  };

  const resolveModelInput = (value: string, title = "Unknown model id") => {
    const resolved = resolveProviderModelChoice(value, routingCatalog());
    if (!resolved.ok) {
      toast({ tone: "error", title, message: describeModelChoiceError(resolved) });
      return null;
    }
    return resolved;
  };

  const normalizeSettingsDraft = (source: HarnessSettings): HarnessSettings | null => {
    const normalizedLadders: HarnessSettings["ladders"] = {};
    for (const [ladderName, tiers] of Object.entries(source.ladders)) {
      const tierEntries = Object.entries(tiers).filter(([tier]) => tier !== "tier_pools");
      const ladderOverrides: Partial<Record<ClaudeTier, string>> = {};
      for (const [tier, modelId] of tierEntries) {
        if (typeof modelId !== "string" || !modelId.trim()) {
          toast({ tone: "error", title: "Missing ladder model", message: `${ladderName}.${tier} needs a provider-specific model id.` });
          return null;
        }
        ladderOverrides[tier as ClaudeTier] = modelId;
      }
      const normalizedLadder = normalizeLadderOverrides(ladderOverrides, routingCatalog());
      if (!normalizedLadder.ok) {
        toast({
          tone: "error",
          title: "Invalid ladder model",
          message: `${ladderName}.${normalizedLadder.tier}: ${describeModelChoiceError(normalizedLadder.error)}`,
        });
        return null;
      }
      const normalizedPools = normalizeTierPoolOverrides(getTierPools(tiers) as Partial<Record<ClaudeTier, string[]>>, routingCatalog());
      if (!normalizedPools.ok) {
        toast({
          tone: "error",
          title: normalizedPools.error === "duplicate" ? "Duplicate pool model" : "Invalid pool model",
          message:
            normalizedPools.error === "duplicate"
              ? `${ladderName}.${normalizedPools.tier} contains the same provider/model more than once.`
              : `${ladderName}.${normalizedPools.tier} #${normalizedPools.index + 1}: ${describeModelChoiceError(normalizedPools.error)}`,
        });
        return null;
      }
      normalizedLadders[ladderName] = {
        ...normalizedLadder.value,
        ...(Object.keys(normalizedPools.value).length > 0 ? { tier_pools: normalizedPools.value } : {}),
      };
    }
    return { ...source, ladders: normalizedLadders };
  };

  const judgeProviders = new Set(draft.judge_pool.map((j) => j.provider));
  const crossVendorOk = judgeProviders.size >= 2;
  type LadderDraft = HarnessSettings["ladders"][string];

  const getTierPools = (tiers: LadderDraft) =>
    tiers.tier_pools && typeof tiers.tier_pools === "object" ? tiers.tier_pools : {};

  const setLadder = (ladderName: string, next: LadderDraft) =>
    setDraft({ ...draft, ladders: { ...draft.ladders, [ladderName]: next } });

  const setTierModel = (ladderName: string, tier: string, modelId: string) => {
    const tiers = draft.ladders[ladderName]!;
    setLadder(ladderName, { ...tiers, [tier]: modelId });
  };

  const setTierPools = (ladderName: string, pools: Record<string, string[]>) => {
    const tiers = draft.ladders[ladderName]!;
    const entries = Object.entries(pools).filter(([, ids]) => ids.length > 0);
    const next: LadderDraft = { ...tiers };
    if (entries.length === 0) {
      delete next.tier_pools;
    } else {
      next.tier_pools = Object.fromEntries(entries);
    }
    setLadder(ladderName, next);
  };

  const ladderDraftKey = (ladderName: string, tier: string) => `${ladderName}:${tier}`;
  const poolDraftKey = (ladderName: string, tier: string) => `${ladderName}:${tier}`;
  const poolEditDraftKey = (ladderName: string, tier: string, index: number) => `${ladderName}:${tier}:${index}`;
  const setLadderInputDraft = (ladderName: string, tier: string, value: string) =>
    setLadderInputDrafts((prev) => ({ ...prev, [ladderDraftKey(ladderName, tier)]: value }));
  const setPoolDraft = (ladderName: string, tier: string, value: string) =>
    setPoolDrafts((prev) => ({ ...prev, [poolDraftKey(ladderName, tier)]: value }));
  const setPoolEditDraft = (ladderName: string, tier: string, index: number, value: string) =>
    setPoolEditDrafts((prev) => ({ ...prev, [poolEditDraftKey(ladderName, tier, index)]: value }));
  const clearLadderInputDraft = (ladderName: string, tier: string) =>
    setLadderInputDrafts((prev) => {
      const next = { ...prev };
      delete next[ladderDraftKey(ladderName, tier)];
      return next;
    });
  const clearPoolEditDraft = (ladderName: string, tier: string, index: number) =>
    setPoolEditDrafts((prev) => {
      const next = { ...prev };
      delete next[poolEditDraftKey(ladderName, tier, index)];
      return next;
    });
  const clearPoolEditDraftsForTier = (ladderName: string, tier: string) =>
    setPoolEditDrafts((prev) =>
      Object.fromEntries(
        Object.entries(prev).filter(([key]) => !key.startsWith(`${ladderName}:${tier}:`)),
      ),
    );
  const commitTierModelInput = (ladderName: string, tier: string, value: string) => {
    const raw = value.trim();
    if (!raw) {
      clearLadderInputDraft(ladderName, tier);
      return;
    }
    const resolved = resolveModelInput(raw);
    if (!resolved) return;
    setTierModel(ladderName, tier, resolved.canonical);
    clearLadderInputDraft(ladderName, tier);
  };
  const commitPoolModelInput = (ladderName: string, tier: string, index: number, value: string) => {
    const raw = value.trim();
    if (!raw) {
      clearPoolEditDraft(ladderName, tier, index);
      return;
    }
    const resolved = resolveModelInput(raw);
    if (!resolved) return;
    const siblings = (getTierPools(draft.ladders[ladderName]!)[tier] ?? []).filter((_, idx) => idx !== index);
    if (siblings.includes(resolved.canonical)) {
      toast({ tone: "error", title: "Duplicate pool model", message: "Each pool entry must be unique per provider/model." });
      return;
    }
    updatePoolModel(ladderName, tier, index, resolved.canonical);
    clearPoolEditDraft(ladderName, tier, index);
  };

  const addPoolModel = (ladderName: string, tier: string) => {
    const key = poolDraftKey(ladderName, tier);
    const id = poolDrafts[key]?.trim() ?? "";
    if (!id) return;
    const resolved = resolveModelInput(id);
    if (!resolved) return;
    const tiers = draft.ladders[ladderName]!;
    const pools = { ...getTierPools(tiers) };
    const next = [...(pools[tier] ?? [])];
    if (next.includes(resolved.canonical)) {
      toast({ tone: "warn", title: "Duplicate pool model", message: "That exact provider/model is already in the pool." });
      return;
    }
    next.push(resolved.canonical);
    pools[tier] = next;
    setTierPools(ladderName, pools);
    setPoolDraft(ladderName, tier, "");
  };

  const updatePoolModel = (ladderName: string, tier: string, index: number, modelId: string) => {
    const tiers = draft.ladders[ladderName]!;
    const pools = { ...getTierPools(tiers) };
    const next = [...(pools[tier] ?? [])];
    next[index] = modelId;
    pools[tier] = next;
    setTierPools(ladderName, pools);
  };

  const movePoolModel = (ladderName: string, tier: string, index: number, delta: -1 | 1) => {
    const tiers = draft.ladders[ladderName]!;
    const pools = { ...getTierPools(tiers) };
    const next = [...(pools[tier] ?? [])];
    const target = index + delta;
    if (target < 0 || target >= next.length) return;
    [next[index], next[target]] = [next[target]!, next[index]!];
    pools[tier] = next;
    setTierPools(ladderName, pools);
    clearPoolEditDraftsForTier(ladderName, tier);
  };

  const removePoolModel = (ladderName: string, tier: string, index: number) => {
    const tiers = draft.ladders[ladderName]!;
    const pools = { ...getTierPools(tiers) };
    const next = (pools[tier] ?? []).filter((_, idx) => idx !== index);
    if (next.length === 0) delete pools[tier];
    else pools[tier] = next;
    setTierPools(ladderName, pools);
    clearPoolEditDraftsForTier(ladderName, tier);
  };

  const addJudge = () => {
    const id = judgeDraft.trim();
    if (!id) return;
    const resolved = resolveModelInput(id, "Unknown judge model");
    if (!resolved) return;
    if (draft.judge_pool.some((j) => j.provider === resolved.provider && j.model === resolved.modelId)) {
      setJudgeDraft("");
      return;
    }
    setDraft({ ...draft, judge_pool: [...draft.judge_pool, { provider: resolved.provider, model: resolved.modelId }] });
    setJudgeDraft("");
  };

  const dirty = JSON.stringify(draft) !== JSON.stringify(settings);
  const hasPendingInputDrafts = Object.keys(ladderInputDrafts).length > 0 || Object.keys(poolEditDrafts).length > 0;
  const applyInputDrafts = (source: HarnessSettings): HarnessSettings | null => {
    const next = structuredClone(source) as HarnessSettings;
    for (const [key, value] of Object.entries(ladderInputDrafts)) {
      if (!value.trim()) continue;
      const [ladderName, tier] = key.split(":");
      if (!ladderName || !tier || !next.ladders[ladderName]) continue;
      const resolved = resolveModelInput(value, "Invalid ladder model");
      if (!resolved) return null;
      next.ladders[ladderName] = { ...next.ladders[ladderName]!, [tier]: resolved.canonical };
    }
    for (const [key, value] of Object.entries(poolEditDrafts)) {
      if (!value.trim()) continue;
      const [ladderName, tier, indexRaw] = key.split(":");
      const index = Number(indexRaw);
      if (!ladderName || !tier || !Number.isInteger(index) || !next.ladders[ladderName]) continue;
      const resolved = resolveModelInput(value, "Invalid pool model");
      if (!resolved) return null;
      const tiers = next.ladders[ladderName]!;
      const pools = { ...getTierPools(tiers) };
      const current = [...(pools[tier] ?? [])];
      if (index < 0 || index >= current.length) continue;
      const siblings = current.filter((_, idx) => idx !== index);
      if (siblings.includes(resolved.canonical)) {
        toast({ tone: "error", title: "Duplicate pool model", message: "Each pool entry must be unique per provider/model." });
        return null;
      }
      current[index] = resolved.canonical;
      pools[tier] = current;
      next.ladders[ladderName] = {
        ...tiers,
        tier_pools: pools,
      };
    }
    return next;
  };
  const commit = () => {
    const drafted = applyInputDrafts(draft);
    if (!drafted) return;
    const normalized = normalizeSettingsDraft(drafted);
    if (!normalized) return;
    setDraft(normalized);
    setLadderInputDrafts({});
    setPoolEditDrafts({});
    save.mutate(normalized, {
      onSuccess: () => toast({ tone: "success", title: "Settings saved" }),
      onError: (e) => toast({ tone: "error", title: "Save failed", message: e instanceof Error ? e.message : "" }),
    });
  };
  const SaveBtn = <Button size="sm" variant="primary" disabled={(!dirty && !hasPendingInputDrafts) || save.isPending} onClick={commit}>Save</Button>;
  const suggestionChoices = buildProviderModelChoices({
    configuredProviders: configuredVendorList,
    catalogModels: models,
    providerLabels,
  });

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* Shared autocomplete: configured vendors' priced models + each configured provider's live model list. */}
      <datalist id={MODEL_DATALIST_ID}>
        {suggestionChoices.map((choice) => (
          <option key={choice.canonical} value={choice.canonical}>
            {choice.label}
          </option>
        ))}
        {configuredVendorList.map((v) => (
          <ProviderModelOptions
            key={v}
            vendor={v}
            providerLabel={providerLabels.get(v) ?? v}
            exclude={catalogIds}
          />
        ))}
      </datalist>

      <Card title="Generation ladders" actions={SaveBtn}>
        <p className="mb-2 text-[11px] text-ink-3">Map each tier of a generation ladder to a provider-qualified model id. Suggestions come from the priced catalog plus each configured provider's live model list (Refresh models on a provider card re-fetches it).</p>
        <p className="mb-2 text-[11px] text-ink-3">Per-tier pools rotate across Reflexion retries and best-of candidates. The plain ladder mapping remains the single-model fallback when a tier has no pool, and pool priority is preserved top-to-bottom exactly as written.</p>
        <div className="space-y-3">
          {Object.entries(draft.ladders).map(([ladderName, tiers]) => (
            <div key={ladderName} className="space-y-2">
              <div className="mono text-[11px] uppercase tracking-wide text-ink-3">{ladderName}</div>
              {Object.entries(tiers)
                .filter(([tier]) => tier !== "tier_pools")
                .map(([tier, modelId]) => (
                <div key={tier} className="rounded-sm bg-bg-1 p-2">
                  <div className="flex items-center gap-2">
                    <span className="mono w-16 text-[12px] text-ink-2">{tier}</span>
                    <input
                      list={MODEL_DATALIST_ID}
                      value={ladderInputDrafts[ladderDraftKey(ladderName, tier)] ?? (typeof modelId === "string" ? modelId : "")}
                      spellCheck={false}
                      autoComplete="off"
                      data-testid={`ladder-${ladderName}-${tier}`}
                      onChange={(e) => setLadderInputDraft(ladderName, tier, e.target.value)}
                      onBlur={(e) => commitTierModelInput(ladderName, tier, e.target.value)}
                      className="mono flex-1 rounded-sm border border-line-2 bg-bg-2 px-2 py-1 text-[12px] text-ink-1 outline-none focus:border-accent"
                    />
                    {tier === "fable" && <Pill tone="judge" title="capability-gated, never auto-escalated">gated</Pill>}
                  </div>

                  <div className="mt-2 pl-[4.5rem]">
                    <div className="mb-1 text-[11px] text-ink-3">Pool rotation for <span className="mono">{tier}</span></div>
                    {(getTierPools(tiers)[tier] ?? []).length > 0 ? (
                      <ul className="space-y-1">
                        {(getTierPools(tiers)[tier] ?? []).map((poolModel, index, arr) => (
                          <li key={`${tier}-${index}`} className="flex items-center gap-2 rounded-sm bg-bg-2 px-2 py-1">
                            <span className="mono w-4 text-[11px] text-ink-3">{index + 1}</span>
                            <input
                              list={MODEL_DATALIST_ID}
                              value={poolEditDrafts[poolEditDraftKey(ladderName, tier, index)] ?? poolModel}
                              spellCheck={false}
                              autoComplete="off"
                              data-testid={`tier-pool-${ladderName}-${tier}-${index}`}
                              onChange={(e) => setPoolEditDraft(ladderName, tier, index, e.target.value)}
                              onBlur={(e) => commitPoolModelInput(ladderName, tier, index, e.target.value)}
                              className="mono flex-1 rounded-sm border border-line-2 bg-bg-0 px-2 py-1 text-[12px] text-ink-1 outline-none focus:border-accent"
                            />
                            <button type="button" className="text-ink-3 hover:text-ink-1" disabled={index === 0} onClick={() => movePoolModel(ladderName, tier, index, -1)}>↑</button>
                            <button type="button" className="text-ink-3 hover:text-ink-1" disabled={index === arr.length - 1} onClick={() => movePoolModel(ladderName, tier, index, 1)}>↓</button>
                            <button type="button" className="text-fail/70 hover:text-fail" onClick={() => removePoolModel(ladderName, tier, index)}>✕</button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-[11px] text-ink-3">No pool configured — retries fall back to the single ladder model.</p>
                    )}
                    <div className="mt-2 flex items-center gap-2">
                      <input
                        list={MODEL_DATALIST_ID}
                        value={poolDrafts[poolDraftKey(ladderName, tier)] ?? ""}
                        spellCheck={false}
                        autoComplete="off"
                        data-testid={`tier-pool-add-${ladderName}-${tier}`}
                        onChange={(e) => setPoolDraft(ladderName, tier, e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") addPoolModel(ladderName, tier);
                        }}
                        placeholder={`add ${tier} pool model id…`}
                        className="mono flex-1 rounded-sm border border-line-2 bg-bg-2 px-2 py-1 text-[12px] text-ink-1 outline-none focus:border-accent"
                      />
                      <Button
                        size="sm"
                        disabled={!(poolDrafts[poolDraftKey(ladderName, tier)] ?? "").trim()}
                        onClick={() => addPoolModel(ladderName, tier)}
                        data-testid={`tier-pool-add-btn-${ladderName}-${tier}`}
                      >
                        Add
                      </Button>
                    </div>
                  </div>
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
              <span className="mono flex-1 text-[12px] text-ink-1">{providerModelLabel(j.provider, j.model, providerLabels)}</span>
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

/** Problem-state health chips (WS2). ok / unknown fall through to the
 * credential-driven label below. */
const HEALTH_CHIP: Partial<Record<NonNullable<ProviderStatus["health"]>, { tone: StatusTone; label: string }>> = {
  rate_limited: { tone: "warn", label: "rate-limited" },
  quota_exhausted: { tone: "fail", label: "credits exhausted" },
  error: { tone: "warn", label: "provider error" },
};

/** Live mm:ss countdown to a rate-limit cooldown expiry; renders nothing once elapsed. */
function CooldownCountdown({ until }: { until: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ms = new Date(until).getTime() - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const s = Math.ceil(ms / 1000);
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return (
    <span className="mono text-[11px] text-warn" data-testid="provider-cooldown">
      cooldown {mm}:{String(ss).padStart(2, "0")}
    </span>
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
  const qc = useQueryClient();
  // A live health problem (rate-limit / credits / error) wins the chip; otherwise
  // a subscription/CLI login that hasn't produced a usable key reads as a
  // distinct "logged in" state — ready-ish, but not the full "ready" of a
  // resolvable credential.
  const healthChip = provider.health ? HEALTH_CHIP[provider.health] : undefined;
  const tone: StatusTone = provider.degraded
    ? "warn"
    : healthChip
      ? healthChip.tone
      : provider.configured
        ? "pass"
        : provider.logged_in
          ? "judge"
          : "dim";
  const statusLabel = provider.degraded
    ? "degraded"
    : healthChip
      ? healthChip.label
      : provider.configured
        ? "ready"
        : provider.logged_in
          ? "logged in"
          : "unconfigured";
  // Last-error tooltip on the chip when the registry recorded one.
  const chipTitle = provider.last_error
    ? `${provider.last_error}${provider.last_error_at ? ` (${new Date(provider.last_error_at).toLocaleString()})` : ""}`
    : undefined;
  const [keyOpen, setKeyOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [loginOpen, setLoginOpen] = useState(false);
  const test = useTestProvider(provider.vendor);
  const refresh = useRefreshProviderModels(provider.vendor);
  const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);

  return (
    <Card
      title={<span className="flex items-center gap-2 text-ink-1"><StatusDot tone={tone} pulse={provider.configured && !provider.degraded && !healthChip} /> {provider.vendor}</span>}
      actions={
        <span className="flex items-center gap-2">
          {provider.cooldown_until && <CooldownCountdown until={provider.cooldown_until} />}
          <StatusChip tone={tone} label={statusLabel} title={chipTitle} />
        </span>
      }
    >
      <KeyValue
        labelWidth={92}
        rows={[
          { label: "api key", value: provider.has_api_key ? (provider.masked_key ?? "set") : "—", mono: true },
          { label: "configured", value: provider.configured ? "yes" : "no" },
          ...(provider.balance
            ? [{ label: "balance", value: `${provider.balance.amount.toFixed(2)} ${provider.balance.currency}`, mono: true }]
            : []),
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
              onSuccess: (r) => {
                setTestResult(r);
                // A healthy probe cleared any server-side cooldown + refreshed the
                // balance — re-fetch provider status so the chip/countdown/balance
                // reflect the cleared state immediately (belt-and-suspenders with
                // the provider.status SSE frame the route also publishes).
                if (r.ok) void qc.invalidateQueries({ queryKey: qk.providers });
              },
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
