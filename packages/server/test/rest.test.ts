import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { apiPaths, type JudgeStatsResponse } from "@shared/api-types";

// Isolate the DB + platform auth dir + keep the ecosystem off BEFORE buildApp.
const home = mkdtempSync(join(tmpdir(), "pp-srv-home-"));
process.env.PP_PLATFORM_DIR = join(home, "platform");
delete process.env.PP_ECOSYSTEM;
delete process.env.PP_API_TOKEN;
const dbPath = join(home, "state.db");
mkdirSync(process.env.PP_PLATFORM_DIR, { recursive: true });
writeFileSync(
  join(process.env.PP_PLATFORM_DIR, "catalog.json"),
  JSON.stringify({
    generation_ladders: {
      claude: {
        provider: "anthropic",
        order: ["haiku", "sonnet", "opus"],
        off_ladder: ["fable"],
        tiers: {
          haiku: "claude-haiku-4-5-20251001",
          sonnet: "claude-sonnet-4-6",
          opus: "claude-opus-4-7",
          fable: "claude-fable-5",
        },
        tier_pools: {
          sonnet: ["openai/gpt-5.5", "claude-sonnet-4-6"],
        },
      },
    },
  }),
  "utf8",
);
// Isolate the user scope too: the developer machine may have ~/.claude/skills
// (AgentSmith) installed, which would shadow the builtin skills under test.
// Must happen before buildApp is imported (teams.ts binds USER_TEAMS_DIR at
// import; skills.ts reads homedir() per call).
process.env.USERPROFILE = home;
process.env.HOME = home;

let app: FastifyInstance;

beforeAll(async () => {
  const { buildApp } = await import("../src/app.js");
  app = await buildApp({ dbPath });
});

afterAll(async () => {
  await app?.close();
});

async function get(url: string) {
  return app.inject({ method: "GET", url });
}

describe("health + library reads", () => {
  it("GET /healthz", async () => {
    const r = await get("/healthz");
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true });
  });

  it("GET /api/v1/rubrics + /rubrics/:id", async () => {
    const list = await get("/api/v1/rubrics");
    expect(list.statusCode).toBe(200);
    const rubrics = list.json() as Array<{ id: string }>;
    expect(rubrics.length).toBeGreaterThan(0);
    const one = await get(`/api/v1/rubrics/${encodeURIComponent(rubrics[0]!.id)}`);
    expect(one.statusCode).toBe(200);
    expect(typeof (one.json() as { markdown?: string }).markdown).toBe("string");
  });

  it("GET /api/v1/judges/stats returns { items } and matches apiPaths.judgeStats", async () => {
    // apiPaths is the wire contract — the route the server registers must be
    // exactly the one clients build from.
    expect(apiPaths.judgeStats).toBe("/api/v1/judges/stats");
    const r = await get(apiPaths.judgeStats);
    expect(r.statusCode).toBe(200);
    const body = r.json() as JudgeStatsResponse;
    expect(Array.isArray(body.items)).toBe(true);
    // Every row (empty DB may yield none) has the full JudgeStatRow shape.
    for (const row of body.items) {
      expect(typeof row.judge_producer).toBe("string");
      expect(typeof row.judge_model_id).toBe("string");
      expect(typeof row.n_verdicts).toBe("number");
      expect(typeof row.pass_rate).toBe("number");
      expect(typeof row.revise_rate).toBe("number");
      expect(typeof row.fail_rate).toBe("number");
      expect(typeof row.cross_vendor_share).toBe("number");
      expect(
        row.avg_min_dimension_score === null || typeof row.avg_min_dimension_score === "number",
      ).toBe(true);
    }
  });

  it("GET /api/v1/profiles (16), /forums (10), /taxonomy (16), /teams, /models", async () => {
    expect((await get("/api/v1/profiles")).json()).toHaveLength(16);
    expect((await get("/api/v1/forums")).json()).toHaveLength(10);
    expect((await get("/api/v1/taxonomy")).json()).toHaveLength(16);
    expect(Array.isArray((await get("/api/v1/teams")).json())).toBe(true);
    expect(Array.isArray((await get("/api/v1/models")).json())).toBe(true);
  });

  it("GET /api/v1/settings returns defaults; PUT persists", async () => {
    const def = (await get("/api/v1/settings")).json() as {
      ladders: Record<string, Record<string, string> & { tier_pools?: Record<string, string[]> }>;
      judge_pool: Array<{ provider: string; model: string }>;
    };
    // Default catalog ships the "claude" ladder with fable off-ladder.
    expect(def.ladders.claude!.fable).toBe("claude-fable-5");
    expect(def.ladders.claude!.tier_pools?.sonnet).toEqual(["openai/gpt-5.5", "claude-sonnet-4-6"]);
    expect(Array.isArray(def.judge_pool)).toBe(true);
    expect(def.judge_pool[0]).toMatchObject({ provider: "openai" });

    const next = {
      ladders: {
        claude: {
          fable: "claude-fable-5",
          opus: "claude-opus-4-7",
          sonnet: "claude-sonnet-4-6",
          haiku: "claude-haiku-4-5-20251001",
          tier_pools: { sonnet: ["openai/gpt-5.5", "azure-openai/gpt-5.5"] },
        },
      },
      judge_pool: [{ provider: "openai", model: "gpt-5.4" }],
    };
    const put = await app.inject({ method: "PUT", url: "/api/v1/settings", payload: next });
    expect(put.statusCode).toBe(200);
    expect((await get("/api/v1/settings")).json()).toEqual(next);

    const bad = await app.inject({ method: "PUT", url: "/api/v1/settings", payload: { judge_pool: [] } });
    expect(bad.statusCode).toBe(422);
  });

  it("GET /api/v1/projects/:path/profile returns raw yaml plus the resolved project profile", async () => {
    const project = mkdtempSync(join(tmpdir(), "pp-srv-project-"));
    mkdirSync(join(project, ".harness"), { recursive: true });
    writeFileSync(
      join(project, ".harness", "profile.yaml"),
      [
        "name: checkout-custom",
        "description: Custom project profile",
        "extends:",
        "  - web-ui",
        "ladder:",
        "  sonnet: openai/gpt-5.5",
        "tier_pools:",
        "  sonnet:",
        "    - openai/gpt-5.5",
        "    - azure-openai/gpt-5.5",
        "",
      ].join("\n"),
      "utf8",
    );

    const r = await get(`/api/v1/projects/${encodeURIComponent(project)}/profile`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({
      path: join(project, ".harness", "profile.yaml"),
      yaml: expect.stringContaining("name: checkout-custom"),
      resolved: {
        name: "checkout-custom",
        ladder: { sonnet: "openai/gpt-5.5" },
        tier_pools: { sonnet: ["openai/gpt-5.5", "azure-openai/gpt-5.5"] },
      },
    });
  });

  it("GET /api/v1/skills + /skills/:id (404 on unknown)", async () => {
    const list = await get("/api/v1/skills");
    expect(list.statusCode).toBe(200);
    const skills = list.json() as Array<{ id: string; injection: string; origin: string; priority: number }>;
    expect(skills.length).toBeGreaterThanOrEqual(17);
    const ac = skills.find((s) => s.id === "artifact-conventions")!;
    expect(ac).toMatchObject({ origin: "builtin", injection: "generator", priority: 50 });

    const one = await get("/api/v1/skills/judge-policy");
    expect(one.statusCode).toBe(200);
    const detail = one.json() as { body?: string; version?: number; max_chars?: number };
    expect(typeof detail.body).toBe("string");
    expect(detail.version).toBe(1);
    expect(detail.max_chars).toBe(6000);

    expect((await get("/api/v1/skills/nope-not-a-skill")).statusCode).toBe(404);
    // Path-traversal ids must 404, not escape the skill dirs.
    expect((await get(`/api/v1/skills/${encodeURIComponent("../teams/feature-team")}`)).statusCode).toBe(404);
  });

  it("GET /api/v1/doctor is reachable", async () => {
    const r = await get("/api/v1/doctor");
    expect(r.statusCode).toBe(200);
    expect((r.json() as { db_reachable?: boolean }).db_reachable).toBe(true);
  });
});

describe("budgets + caps", () => {
  it("GET /budgets and caps roundtrip; PUT validates", async () => {
    expect(Array.isArray((await get("/api/v1/budgets")).json())).toBe(true);
    expect((await get("/api/v1/budgets/caps")).json()).toEqual([]);

    const ok = await app.inject({
      method: "PUT",
      url: "/api/v1/budgets/caps",
      payload: { caps: [{ scope: "day", limit_usd: 8, warn_pct: 0.8, block_pct: 1.0 }] },
    });
    expect(ok.statusCode).toBe(200);
    expect((await get("/api/v1/budgets/caps")).json()).toHaveLength(1);

    const bad = await app.inject({
      method: "PUT",
      url: "/api/v1/budgets/caps",
      payload: { caps: [{ scope: "day", limit_usd: -1, warn_pct: 2 }] },
    });
    expect(bad.statusCode).toBe(422);
    expect((bad.json() as { error: string }).error).toBe("validation failed");
  });
});

describe("projects CRUD", () => {
  const projectDir = mkdtempSync(join(tmpdir(), "pp-srv-proj-"));

  it("lists empty, registers, 422s a bad dir, gets detail, deletes", async () => {
    expect((await get("/api/v1/projects")).json()).toEqual([]);

    const created = await app.inject({ method: "POST", url: "/api/v1/projects", payload: { path: projectDir, name: "Demo" } });
    expect(created.statusCode).toBe(201);
    expect((created.json() as { name: string }).name).toBe("Demo");

    const bad = await app.inject({ method: "POST", url: "/api/v1/projects", payload: { path: join(projectDir, "nope") } });
    expect(bad.statusCode).toBe(422);

    const detail = await get(`/api/v1/projects/${encodeURIComponent(projectDir)}`);
    expect(detail.statusCode).toBe(200);
    const d = detail.json() as { name: string; constitution: unknown; recent_runs: unknown[] };
    expect(d.name).toBe("Demo");
    expect(d.constitution).toBeTruthy();
    expect(Array.isArray(d.recent_runs)).toBe(true);

    const del = await app.inject({ method: "DELETE", url: `/api/v1/projects/${encodeURIComponent(projectDir)}` });
    expect((del.json() as { removed: boolean }).removed).toBe(true);
  });

  it("GET detail works for a deep URL-encoded path (maxParamLength — no 414)", async () => {
    // A deeply nested dir whose encodeURIComponent form exceeds Fastify's
    // ~100-char default maxParamLength.
    const deep = mkdtempSync(join(tmpdir(), "pp-srv-deep-"));
    const nested = join(deep, "a", "b", "c", "d", "e", "really", "deeply", "nested", "project", "root");
    mkdirSync(nested, { recursive: true });
    await app.inject({ method: "POST", url: "/api/v1/projects", payload: { path: nested, name: "Deep" } });
    const detail = await get(`/api/v1/projects/${encodeURIComponent(nested)}`);
    expect(detail.statusCode).toBe(200);
    expect((detail.json() as { name: string }).name).toBe("Deep");
  });

  it("PUT profile with invalid yaml → 422", async () => {
    const r = await app.inject({
      method: "PUT",
      url: `/api/v1/projects/${encodeURIComponent(projectDir)}/profile`,
      payload: { yaml: "just a string, no mapping" },
    });
    expect(r.statusCode).toBe(422);
    expect((r.json() as { error: string }).error).toBe("validation failed");
  });
});

describe("provider keys — write-only + masked", () => {
  const RAW = "sk-ant-secrettestkey1234";

  it("PUT stores a key and returns a masked status; GET never leaks the raw key", async () => {
    const put = await app.inject({ method: "PUT", url: "/api/v1/providers/anthropic/key", payload: { api_key: RAW } });
    expect(put.statusCode).toBe(200);
    const body = put.json() as { has_api_key: boolean; masked_key: string | null };
    expect(body.has_api_key).toBe(true);
    expect(body.masked_key).toBeTruthy();
    expect(put.payload).not.toContain(RAW); // response never echoes the raw key

    const list = await get("/api/v1/providers");
    const providers = list.json() as Array<{ vendor: string; has_api_key: boolean; masked_key: string | null }>;
    const ant = providers.find((p) => p.vendor === "anthropic")!;
    expect(ant.has_api_key).toBe(true);
    expect(ant.masked_key).not.toBe(RAW);
    expect(list.payload).not.toContain(RAW);

    const del = await app.inject({ method: "DELETE", url: "/api/v1/providers/anthropic/key" });
    expect((del.json() as { has_api_key: boolean }).has_api_key).toBe(false);
  });

  it("PUT with a too-short key → 422", async () => {
    const r = await app.inject({ method: "PUT", url: "/api/v1/providers/anthropic/key", payload: { api_key: "x" } });
    expect(r.statusCode).toBe(422);
  });

  it("GET /providers/available lists catalog + curated pi providers", async () => {
    const avail = (await get("/api/v1/providers/available")).json() as Array<{
      id: string; in_catalog: boolean; env_key_hint: string | null; configured: boolean;
    }>;
    const ids = avail.map((p) => p.id);
    // the 3 catalog providers are present and in_catalog
    for (const id of ["openai", "google", "anthropic"]) {
      expect(avail.find((p) => p.id === id)?.in_catalog).toBe(true);
    }
    // every pi provider (e.g. mistral) is now a generated catalog entry, enabled by default
    const mistral = avail.find((p) => p.id === "mistral");
    expect(mistral).toBeTruthy();
    expect(mistral!.in_catalog).toBe(true);
    expect(mistral!.env_key_hint).toBe("MISTRAL_API_KEY");
    expect(ids.length).toBeGreaterThan(3);
  });

  it("a key can be configured for a NON-original provider (mistral)", async () => {
    const RAW = "sk-mistral-secrettestkey987654";
    const put = await app.inject({ method: "PUT", url: "/api/v1/providers/mistral/key", payload: { api_key: RAW } });
    expect(put.statusCode).toBe(200);
    const body = put.json() as { has_api_key: boolean; masked_key: string | null };
    expect(body.has_api_key).toBe(true);
    expect(put.payload).not.toContain(RAW);
    await app.inject({ method: "DELETE", url: "/api/v1/providers/mistral/key" });
  });

  it("GET /providers/:vendor/models returns catalog models", async () => {
    const r = (await get("/api/v1/providers/anthropic/models")).json() as { provider: string; models: string[] };
    expect(r.provider).toBe("anthropic");
    expect(r.models).toContain("claude-opus-4-7");
  });
});

describe("run reads + run-control validation", () => {
  it("GET /runs empty, unknown run 404", async () => {
    expect((await get("/api/v1/runs")).json()).toEqual({ items: [], next_cursor: null });
    expect((await get("/api/v1/runs/run_missing")).statusCode).toBe(404);
  });

  it("POST /runs with a missing project dir → 404; abort of an inactive run → 404", async () => {
    const start = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      payload: { project_path: join(tmpdir(), "pp-no-such-dir-zzz"), request_text: "y", mode: "single" },
    });
    expect(start.statusCode).toBe(404);
    expect((start.json() as { error: string }).error).toBe("project_not_found");

    const abort = await app.inject({ method: "POST", url: "/api/v1/runs/run_x/abort" });
    expect(abort.statusCode).toBe(404);
  });

  it("POST /runs with best_of + tier flags → 422", async () => {
    const r = await app.inject({
      method: "POST",
      url: "/api/v1/runs",
      payload: { project_path: tmpdir(), request_text: "x", mode: "best_of", n: 3, tier_cap: "opus" },
    });
    expect(r.statusCode).toBe(422);
  });

  it("GET /runs/:id includes provider/judge_provider when set; omits keys entirely when null or empty (REQ-S-1..S-3)", async () => {
    // Seed the DB directly (bypasses runtime run-start).
    const { db } = await import("@pp/core");
    const conn = db();
    const now = new Date().toISOString();
    conn.prepare(
      "INSERT INTO runs (id, project_path, request_text, mode, status, started_at) VALUES (?,?,?,?,?,?)",
    ).run("run_prov_test", tmpdir(), "prov test", "single", "complete", now);
    conn.prepare(
      "INSERT INTO stages (id, run_id, kind, gate_type, status, started_at) VALUES (?,?,?,?,?,?)",
    ).run("stg_prov", "run_prov_test", "code", "code", "passed", now);
    // Two attempts: one with provider populated, one with NULL (historical), one with '' (defensive empty).
    const attInsert = conn.prepare(
      "INSERT INTO attempts (id, stage_id, producer, model_id, retry_index, status, provider, created_at) VALUES (?,?,?,?,?,?,?,?)",
    );
    attInsert.run("att_p_ok", "stg_prov", "claude", "gpt-5.4", 0, "ok", "github-copilot", now);
    attInsert.run("att_p_null", "stg_prov", "claude", "gpt-5.4", 0, "ok", null, now);
    attInsert.run("att_p_empty", "stg_prov", "claude", "gpt-5.4", 0, "ok", "", now);
    const vInsert = conn.prepare(
      "INSERT INTO verdicts (id, attempt_id, judge_producer, judge_model_id, rubric_id, outcome, critique_md, score_json, cross_vendor, eights_memory_id, judge_provider, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
    );
    vInsert.run("vd_p_ok", "att_p_ok", "openai", "gpt-4o", null, "pass", "", null, 1, null, "anthropic-messages", now);
    vInsert.run("vd_p_null", "att_p_null", "openai", "gpt-4o", null, "pass", "", null, 1, null, null, now);
    vInsert.run("vd_p_empty", "att_p_empty", "openai", "gpt-4o", null, "pass", "", null, 1, null, "", now);

    const r = await get("/api/v1/runs/run_prov_test");
    expect(r.statusCode).toBe(200);
    const body = r.json() as {
      attempts: Array<Record<string, unknown>>;
      verdicts: Array<Record<string, unknown>>;
    };

    const byId = new Map(body.attempts.map((a) => [a["id"] as string, a]));
    // Populated row: key present with expected value.
    expect(byId.get("att_p_ok")!.provider).toBe("github-copilot");
    // NULL row: key OMITTED (not present, not `null`).
    expect("provider" in byId.get("att_p_null")!).toBe(false);
    // Empty-string row: also OMITTED.
    expect("provider" in byId.get("att_p_empty")!).toBe(false);

    const vById = new Map(body.verdicts.map((v) => [v["id"] as string, v]));
    expect(vById.get("vd_p_ok")!.judge_provider).toBe("anthropic-messages");
    expect("judge_provider" in vById.get("vd_p_null")!).toBe(false);
    expect("judge_provider" in vById.get("vd_p_empty")!).toBe(false);

    // REQ-S-5 secret-leak scan: no attempt/verdict field should surface
    // credential material (api_key, api-key, apikey, or a bare *_token /
    // *_secret name). `prompt_hash` and similar hashes are fine — the check
    // is specifically about credentials, not hashed identifiers.
    const badKeyRe = /(?:^|_)(?:api[_-]?key|api_?token|access_?token|refresh_?token|secret_?value|bearer_?token)(?:$|_)/i;
    for (const row of [...body.attempts, ...body.verdicts]) {
      for (const k of Object.keys(row)) {
        expect(badKeyRe.test(k)).toBe(false);
      }
    }
  });
});
