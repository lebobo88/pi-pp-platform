import { describe, it, expect, beforeAll } from "vitest";
import { installMockApi } from "./mockApi";
import { api } from "@/api/client";
import { apiPaths, type ProviderStatus, type MissabilityCheckRow, type JanitorReport, type ReplayBundle, type DetectProfileResult, type Forum, type TaxonomySection } from "@shared/api-types";
import { MOCK_RUN_ID } from "./fixtures/runTree";

/**
 * Locks the M5e reconciliation: the mock must match the real server's shapes
 * for the 7 deltas + the new endpoints, so it stays a faithful stand-in.
 */
describe("mock ↔ server contract (M5e)", () => {
  beforeAll(() => installMockApi());

  it("delta 1 — ProviderStatus drops CLI-era fields", async () => {
    const providers = await api.get<ProviderStatus[]>(apiPaths.providers);
    for (const p of providers) {
      expect(p.cli_installed).toBe(false);
      expect(p.cli_version).toBeNull();
      expect(p.logged_in).toBe(false);
      expect(p.degraded).toBe(false);
    }
  });

  it("delta 2 — Replay bundle is nested (stages→attempts→verdicts)", async () => {
    const r = await api.get<ReplayBundle>(apiPaths.runReplay(MOCK_RUN_ID));
    expect(r.reproduction_notes).toBeTruthy();
    expect(Array.isArray(r.stages)).toBe(true);
    expect(r.stages[0]!.attempts[0]).toHaveProperty("verdicts");
  });

  it("delta 3 — Janitor GET is empty; POST executes", async () => {
    const empty = await api.get<JanitorReport>(apiPaths.janitor);
    expect(empty.ran_at).toBeNull();
    expect(empty.entries).toHaveLength(0);
    const run = await api.post<JanitorReport>(apiPaths.janitor, { dry_run: false });
    expect(run.entries.map((e) => e.kind)).toEqual(expect.arrayContaining(["worktree", "lock", "branch"]));
  });

  it("delta 4 — Evolution commit/rollback return 501", async () => {
    await expect(api.post(apiPaths.evolutionReview("evo_4390"), { decision: "commit" })).rejects.toMatchObject({ status: 501 });
    const approve = await api.post<{ id: string; decision: string; status: string; updated: boolean }>(
      apiPaths.evolutionReview("evo_4402"),
      { decision: "approve" },
    );
    expect(approve).toMatchObject({ decision: "approve", status: "approved", updated: true });
  });

  it("delta 5 — project register (POST) then detail; delete", async () => {
    const created = await api.post<{ path: string; name: string }>(apiPaths.projects, { path: "C:/tmp/new-proj" });
    expect(created.path).toBe("C:/tmp/new-proj");
    const del = await api.del<{ removed: boolean }>(apiPaths.project("C:/tmp/new-proj"));
    expect(del.removed).toBe(true);
  });

  it("delta 6 — missability status is 'n/a', never 'skipped'", async () => {
    const checks = await api.get<MissabilityCheckRow[]>(apiPaths.runMissability(MOCK_RUN_ID));
    expect(checks.some((c) => c.status === "n/a")).toBe(true);
    expect(checks.some((c) => c.status === "skipped")).toBe(false);
  });

  it("delta 7 — new endpoints: profiles/detect, forums, taxonomy, borda", async () => {
    const detect = await api.post<DetectProfileResult>(apiPaths.profilesDetect, { project_path: "C:/AiAppDeployments/acme-checkout" });
    expect(detect).toHaveProperty("recommendation");
    expect(detect).toHaveProperty("confidence");
    expect(Array.isArray(detect.signals)).toBe(true);

    const forums = await api.get<Forum[]>(apiPaths.forums);
    expect(forums.length).toBeGreaterThan(0);
    expect(forums[0]).toHaveProperty("title");

    const taxonomy = await api.get<TaxonomySection[]>(apiPaths.taxonomy);
    expect(taxonomy[0]).toHaveProperty("default_artifact_kinds");

    const borda = await api.get<Array<{ stage_id: string }>>(apiPaths.runBorda(MOCK_RUN_ID));
    expect(Array.isArray(borda)).toBe(true);
  });

  it("profile write validates yaml (422) and accepts {name}", async () => {
    await expect(
      api.put(apiPaths.projectProfile("C:/AiAppDeployments/acme-checkout"), { yaml: "INVALID" }),
    ).rejects.toMatchObject({ status: 422 });
    const ok = await api.put<{ name?: string }>(apiPaths.projectProfile("C:/AiAppDeployments/acme-checkout"), { name: "web-ui" });
    expect(ok).toMatchObject({ name: "web-ui" });
  });

  it("doctor POST is an async ack (202-shaped)", async () => {
    const ack = await api.post<{ ok: boolean; started: boolean }>(apiPaths.doctor);
    expect(ack).toMatchObject({ ok: true, started: true });
  });

  it("dynamic providers — /available lists catalog + curated pi providers; /:vendor/models", async () => {
    const avail = await api.get<Array<{ id: string; in_catalog: boolean; env_key_hint: string | null }>>(
      apiPaths.providersAvailable,
    );
    expect(avail.find((p) => p.id === "anthropic")?.in_catalog).toBe(true);
    const mistral = avail.find((p) => p.id === "mistral");
    expect(mistral?.in_catalog).toBe(false);
    expect(mistral?.env_key_hint).toBe("MISTRAL_API_KEY");

    const models = await api.get<{ provider: string; models: string[] }>(apiPaths.providerModels("anthropic"));
    expect(models.provider).toBe("anthropic");
    expect(models.models).toContain("claude-opus-4-7");
  });

  it("settings — generation ladders + judge-pool objects round-trip", async () => {
    const s = await api.get<{ ladders: Record<string, Record<string, string>>; judge_pool: Array<{ provider: string; model: string }> }>(apiPaths.settings);
    expect(s.ladders.claude!.fable).toBe("claude-fable-5");
    expect(s.judge_pool[0]).toHaveProperty("provider");
    expect(s.judge_pool[0]).toHaveProperty("model");
  });
});
