import { describe, it, expect, beforeAll } from "vitest";
import { installMockApi } from "./mockApi";
import { api } from "@/api/client";
import { apiPaths, type ProviderStatus, type MissabilityCheckRow, type JanitorReport, type ReplayBundle, type DetectProfileResult, type Forum, type TaxonomySection, type AgentSummary, type AgentDetail, type SkillSummary, type SkillDetail, type TeamRecommendResponse, type RunListResponse, type EvolutionReviewResponse, type ProviderModelsRefreshResponse } from "@shared/api-types";
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

  it("delta 4 — evolution lifecycle: commit requires content (422), then commits and rolls back", async () => {
    // Commit without reviewer-authored content → 422 content_required.
    await expect(api.post(apiPaths.evolutionReview("evo_4390"), { decision: "commit" })).rejects.toMatchObject({
      status: 422,
      message: "content_required",
    });

    // Commit WITH content writes the project override and returns target_path.
    const commit = await api.post<EvolutionReviewResponse>(apiPaths.evolutionReview("evo_4390"), {
      decision: "commit",
      content: "# security-review-team override\n\nInsert a data_flow stage between threat_model and controls.\n",
    });
    expect(commit).toMatchObject({ id: "evo_4390", decision: "commit", status: "committed", updated: true });
    expect(commit.target_path).toBeTruthy();

    // Rollback restores the snapshot (or deletes a commit-created target).
    const rollback = await api.post<EvolutionReviewResponse>(apiPaths.evolutionReview("evo_4390"), { decision: "rollback" });
    expect(rollback).toMatchObject({ decision: "rollback", status: "rolled_back", updated: true });
    expect(rollback.target_path).toBeTruthy();

    // approve mutates a pending proposal; repeating it is a wrong-status 409.
    const approve = await api.post<EvolutionReviewResponse>(apiPaths.evolutionReview("evo_4402"), { decision: "approve" });
    expect(approve).toMatchObject({ decision: "approve", status: "approved", updated: true });
    await expect(api.post(apiPaths.evolutionReview("evo_4402"), { decision: "approve" })).rejects.toMatchObject({ status: 409 });

    await expect(api.post(apiPaths.evolutionReview("nope"), { decision: "approve" })).rejects.toMatchObject({ status: 404 });
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

  it("runs — GET returns the {items, next_cursor} envelope; cursor pages round-trip without dup/gap", async () => {
    const all = await api.get<RunListResponse>(`${apiPaths.runs}?limit=500`);
    expect(Array.isArray(all.items)).toBe(true);
    expect(all.items.length).toBeGreaterThan(7); // enough rows to page
    expect(all.next_cursor).toBeNull();

    // Newest-first keyset order.
    const starts = all.items.map((r) => r.started_at);
    expect([...starts].sort().reverse()).toEqual(starts);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 50; guard++) {
      const page: RunListResponse = await api.get<RunListResponse>(
        `${apiPaths.runs}?limit=7${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      seen.push(...page.items.map((r) => r.id));
      if (!page.next_cursor) break;
      expect(page.items).toHaveLength(7); // a page with a next_cursor is full
      cursor = page.next_cursor;
    }
    expect(seen).toEqual(all.items.map((r) => r.id));
    expect(new Set(seen).size).toBe(seen.length);

    // Filters still apply inside the envelope.
    const filtered = await api.get<RunListResponse>(
      `${apiPaths.runs}?project_path=${encodeURIComponent("C:/AiAppDeployments/orbit-api")}&limit=500`,
    );
    expect(filtered.items.length).toBeGreaterThan(0);
    expect(filtered.items.every((r) => r.project_path === "C:/AiAppDeployments/orbit-api")).toBe(true);
  });

  it("agents — list is summaries (no body); detail adds the prompt body; 404s", async () => {
    const agents = await api.get<AgentSummary[]>(apiPaths.agents);
    expect(agents.length).toBeGreaterThan(0);
    expect(agents[0]).not.toHaveProperty("body");
    const detail = await api.get<AgentDetail>(apiPaths.agent(agents[0]!.id));
    expect(detail.id).toBe(agents[0]!.id);
    expect(detail.body.length).toBeGreaterThan(0);
    await expect(api.get(apiPaths.agent("nope"))).rejects.toMatchObject({ status: 404 });
  });

  it("skills — list is summaries; detail adds body + injection budget; 404s", async () => {
    const skills = await api.get<SkillSummary[]>(apiPaths.skills);
    expect(skills.length).toBeGreaterThan(0);
    expect(skills[0]).not.toHaveProperty("body");
    const detail = await api.get<SkillDetail>(apiPaths.skill(skills[0]!.id));
    expect(detail.body.length).toBeGreaterThan(0);
    expect(detail.max_chars).toBe(6000);
    await expect(api.get(apiPaths.skill("nope"))).rejects.toMatchObject({ status: 404 });
  });

  it("teams/recommend — top-5 ranked recommendations; 422 without request_text", async () => {
    const res = await api.post<TeamRecommendResponse>(apiPaths.teamsRecommend, {
      request_text: "Fix the crash when submitting the checkout form (regression)",
    });
    expect(res.recommendations.length).toBeGreaterThan(0);
    expect(res.recommendations.length).toBeLessThanOrEqual(5);
    expect(res.recommendations[0]!.team).toBe("bug-fix-team");
    expect(["trivial", "standard", "major"]).toContain(res.scope);
    await expect(api.post(apiPaths.teamsRecommend, {})).rejects.toMatchObject({ status: 422 });
  });

  it("profile write validates yaml (422) and accepts {name}", async () => {
    await expect(
      api.put(apiPaths.projectProfile("C:/AiAppDeployments/acme-checkout"), { yaml: "INVALID" }),
    ).rejects.toMatchObject({ status: 422 });
    const ok = await api.put<{ name?: string }>(apiPaths.projectProfile("C:/AiAppDeployments/acme-checkout"), { name: "web-ui" });
    expect(ok).toMatchObject({ name: "web-ui" });
  });

  it("doctor POST is an async ack (202-shaped); accepts {smoke}", async () => {
    const ack = await api.post<{ ok: boolean; started: boolean }>(apiPaths.doctor);
    expect(ack).toMatchObject({ ok: true, started: true });
    const smokeAck = await api.post<{ ok: boolean; started: boolean }>(apiPaths.doctor, { smoke: true });
    expect(smokeAck).toMatchObject({ ok: true, started: true });
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

    // POST models/refresh returns the refreshed (or static-fallback) list; unknown vendors 404.
    const refreshed = await api.post<ProviderModelsRefreshResponse>(apiPaths.providerModelsRefresh("anthropic"));
    expect(refreshed.provider).toBe("anthropic");
    expect(refreshed.refreshed).toBe(true);
    expect(refreshed.models).toContain("claude-opus-4-7");
    const fallback = await api.post<ProviderModelsRefreshResponse>(apiPaths.providerModelsRefresh("mistral"));
    expect(fallback.refreshed).toBe(false);
    expect(fallback.models.length).toBeGreaterThan(0);
    await expect(api.post(apiPaths.providerModelsRefresh("nope"))).rejects.toMatchObject({ status: 404, message: "unknown provider" });
  });

  it("settings — generation ladders + judge-pool objects round-trip", async () => {
    const s = await api.get<{ ladders: Record<string, Record<string, string>>; judge_pool: Array<{ provider: string; model: string }> }>(apiPaths.settings);
    expect(s.ladders.claude!.fable).toBe("claude-fable-5");
    expect(s.judge_pool[0]).toHaveProperty("provider");
    expect(s.judge_pool[0]).toHaveProperty("model");
  });
});
