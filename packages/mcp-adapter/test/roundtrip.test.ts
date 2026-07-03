import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { startAdapter, callTool, type Adapter } from "./mcp-client.js";
import { toolCoverage } from "../src/index.js";

let adapter: Adapter;

beforeAll(async () => {
  adapter = await startAdapter();
});

afterAll(async () => {
  await adapter?.close();
});

describe("pp_harness adapter — stdio round-trip", () => {
  it("registers the full tool surface over listTools", async () => {
    const tools = await adapter.client.listTools();
    const names = tools.tools.map((t) => t.name);
    // Sanity: the compat surface is large.
    expect(names.length).toBeGreaterThanOrEqual(60);
    for (const n of ["start_run", "list_runs", "get_rubric", "team_list", "triage_request"]) {
      expect(names).toContain(n);
    }
    // Every registered tool advertises an object inputSchema.
    for (const t of tools.tools) {
      expect((t.inputSchema as { type?: string }).type).toBe("object");
    }
  });

  it("triage_request round-trips (typo → trivial)", async () => {
    const tri = await callTool(adapter.client, "triage_request", { request_text: "fix typo in README" });
    expect(tri.scope).toBe("trivial");
  });

  it("list_runs returns an array (empty on a fresh PP_HOME)", async () => {
    const runs = await callTool<unknown[]>(adapter.client, "list_runs", {});
    expect(Array.isArray(runs)).toBe(true);
  });

  it("get_rubric returns markdown for a real rubric id", async () => {
    const rubrics = await callTool<Array<{ id: string }>>(adapter.client, "list_rubrics", {});
    expect(rubrics.length).toBeGreaterThan(0);
    const first = rubrics[0]!;
    const rubric = await callTool<{ markdown?: string } | null>(adapter.client, "get_rubric", { id: first.id });
    expect(rubric).toBeTruthy();
    expect(typeof rubric!.markdown).toBe("string");
  });

  it("team_list resolves builtin teams", async () => {
    const teams = await callTool<Array<{ name: string }>>(adapter.client, "team_list", { project_path: adapter.ppHome });
    expect(Array.isArray(teams)).toBe(true);
    expect(teams.length).toBeGreaterThan(0);
  });

  it("list_skills/get_skill round-trip the builtin skill registry", async () => {
    const skills = await callTool<Array<{ id: string; injection: string }>>(adapter.client, "list_skills", { project_path: adapter.ppHome });
    expect(Array.isArray(skills)).toBe(true);
    expect(skills.length).toBeGreaterThanOrEqual(17);
    const first = skills.find((s) => s.id === "judge-policy")!;
    expect(first).toBeTruthy();
    const skill = await callTool<{ body?: string; max_chars?: number } | null>(adapter.client, "get_skill", { id: first.id, project_path: adapter.ppHome });
    expect(skill).toBeTruthy();
    expect(typeof skill!.body).toBe("string");
    expect(skill!.max_chars).toBe(6000);
  });

  it("a stubbed tool returns the structured not_available_in_adapter error", async () => {
    const res = await callTool<{ error?: string; hint?: string }>(adapter.client, "start_best_of_stage", {
      run_id: "run_x",
      kind: "code",
      gate_type: "code_style",
      n: 2,
    });
    expect(res.error).toBe("not_available_in_adapter");
    expect(typeof res.hint).toBe("string");
  });

  it("coverage table matches the registered stub set", async () => {
    const cov = toolCoverage();
    // The stub set is the ecosystem + best-of-worktree + browser tools.
    expect(cov.stub).toContain("start_best_of_stage");
    expect(cov.stub).toContain("hydra_envelope_query");
    expect(cov.stub).toContain("visual_regression_capture");
    // Read/record tools are full.
    expect(cov.full).toContain("list_runs");
    expect(cov.full).toContain("artifact_validate");
    expect(cov.full).toContain("gate_eligible_judges");
    expect(cov.full.length + cov.stub.length).toBeGreaterThanOrEqual(60);
  });
});
