import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as http from "node:http";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Routes, Route } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { createQueryClient } from "@/api/queryClient";
import { api } from "@/api/client";
import {
  apiPaths,
  type ProviderStatus,
  type ModelInfo,
  type TeamSpec,
  type RubricInfo,
  type ProfileSpec,
  type Forum,
  type TaxonomySection,
  type ProjectDetail,
  type DoctorReport,
  type BudgetCap,
  type RunSummary,
} from "@shared/api-types";
import { startServer, installFetchBase, type LiveServer } from "./harness";
import { DashboardPage } from "@/features/dashboard/DashboardPage";
import { ProjectsPage } from "@/features/projects/ProjectsPage";
import { ProjectDetailPage } from "@/features/projects/ProjectDetailPage";
import { TeamsPage } from "@/features/library/TeamsPage";
import { RubricsPage } from "@/features/library/RubricsPage";
import { ProfilesPage } from "@/features/library/ProfilesPage";
import { SystemPage } from "@/features/system/SystemPage";

const RUN = !!process.env.PP_INTEGRATION;
const PP_TEST_PROJECT = "C:/AiAppDeployments/pp-test";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => boolean, timeout = 12_000, interval = 80): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (check()) return;
    await act(async () => {
      await sleep(interval);
    });
  }
  if (!check()) throw new Error("waitFor timed out");
}

/** Render a page at a route against the live server; returns the container. */
async function renderAt(path: string, routes: ReactElement): Promise<{ container: HTMLDivElement; root: Root }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const qc = createQueryClient();
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(MemoryRouter, { initialEntries: [path] }, routes),
      ),
    );
  });
  return { container, root };
}

describe.skipIf(!RUN)("live ppd integration (M5f)", () => {
  let server: LiveServer;
  let uninstallFetch: () => void;

  beforeAll(async () => {
    server = await startServer();
    uninstallFetch = installFetchBase(server.base);
    // Register the pp-test project so detail/list have real data.
    await api.post(apiPaths.projects, { path: PP_TEST_PROJECT }).catch(() => {
      /* already registered from a previous run — fine */
    });
  }, 40_000);

  afterAll(async () => {
    uninstallFetch?.();
    await server?.stop();
  });

  /* ── real-fetch contract assertions (no mock) ────────────────────────── */

  it("read endpoints return real data with the expected counts", async () => {
    const teams = await api.get<TeamSpec[]>(apiPaths.teams);
    const rubrics = await api.get<RubricInfo[]>(apiPaths.rubrics);
    const profiles = await api.get<ProfileSpec[]>(apiPaths.profiles);
    const forums = await api.get<Forum[]>(apiPaths.forums);
    const taxonomy = await api.get<TaxonomySection[]>(apiPaths.taxonomy);
    const models = await api.get<ModelInfo[]>(apiPaths.models);

    expect(teams.length).toBe(26);
    expect(rubrics.length).toBe(27);
    expect(profiles.length).toBe(16);
    expect(forums.length).toBe(10);
    expect(taxonomy.length).toBe(16);
    expect(models.length).toBeGreaterThan(0);

    // Shapes. The teams LIST is a summary WITHOUT stages (only the detail
    // endpoint carries them) — a UI bug this smoke caught and fixed.
    expect(teams[0]).toHaveProperty("name");
    expect(teams[0]!.stages).toBeUndefined();
    // Detail is wrapped { team, origin } and carries stages under .team.
    const detail = await api.get<{ team: TeamSpec; origin: string }>(apiPaths.team(teams[0]!.name));
    expect(Array.isArray(detail.team.stages)).toBe(true);
    expect(forums[0]).toHaveProperty("title");
    expect(taxonomy[0]).toHaveProperty("default_artifact_kinds");
    expect(models[0]).toHaveProperty("input_per_1m");
  });

  it("providers are non-configured with the masked-key rule", async () => {
    const providers = await api.get<ProviderStatus[]>(apiPaths.providers);
    expect(providers.map((p) => p.vendor).sort()).toEqual(["anthropic", "google", "openai"]);
    for (const p of providers) {
      expect(p.configured).toBe(false);
      expect(p.cli_installed).toBe(false);
      expect(p.masked_key).toBeNull();
      expect(Object.keys(p)).not.toContain("api_key");
    }
  });

  it("budgets/caps and runs are readable (empty on a fresh db)", async () => {
    const caps = await api.get<BudgetCap[]>(apiPaths.budgetCaps);
    const runs = await api.get<RunSummary[]>(apiPaths.runs);
    expect(Array.isArray(caps)).toBe(true);
    expect(Array.isArray(runs)).toBe(true);
  });

  it("doctor GET returns a full report shape", async () => {
    const d = await api.get<DoctorReport>(apiPaths.doctor);
    expect(d).toHaveProperty("db_reachable", true);
    expect(d).toHaveProperty("vendors_configured");
    expect(d).toHaveProperty("cli_versions");
    expect(d).toHaveProperty("cross_vendor_ready");
  });

  it("registers pp-test and reads its detail (ProjectDetail shape)", async () => {
    const detail = await api.get<ProjectDetail>(apiPaths.project(PP_TEST_PROJECT));
    expect(detail.path).toBe(PP_TEST_PROJECT);
    expect(detail).toHaveProperty("active_profile");
    expect(detail).toHaveProperty("constitution");
    expect(detail).toHaveProperty("master_plan");
    expect(Array.isArray(detail.recent_runs)).toBe(true);
  });

  it("long encoded project paths no longer 414 (server maxParamLength raised in M5g)", async () => {
    // Regression guard for the M5f finding: the UI encodes long Windows paths
    // into the URL; the server raised Fastify maxParamLength, so an unregistered
    // long path now returns a clean 404 (not a 414 max-param-length error).
    const longPath = "C:/AiAppDeployments/some/very/deeply/nested/example/project/that/exceeds/the/default/fastify/max/param/length/limit/for/sure";
    await expect(api.get(apiPaths.project(longPath))).rejects.toMatchObject({ status: 404 });
  });

  /* ── jsdom page renders against the live server ──────────────────────── */

  it("ProjectsPage renders the registered project", async () => {
    const { container, root } = await renderAt(
      "/projects",
      createElement(Routes, null, createElement(Route, { path: "/projects", element: createElement(ProjectsPage) })),
    );
    await waitFor(() => (container.textContent ?? "").includes("pp-test"));
    expect(container.textContent).toContain("pp-test");
    act(() => root.unmount());
    container.remove();
  });

  it("ProjectDetailPage renders pp-test detail", async () => {
    const { container, root } = await renderAt(
      `/projects/${encodeURIComponent(PP_TEST_PROJECT)}`,
      createElement(Routes, null, createElement(Route, { path: "/projects/:projectPath", element: createElement(ProjectDetailPage) })),
    );
    await waitFor(() => (container.textContent ?? "").includes("pp-test"));
    expect(container.textContent).toContain("Managed documents");
    act(() => root.unmount());
    container.remove();
  });

  it("Library TeamsPage renders real team names", async () => {
    const { container, root } = await renderAt(
      "/library/teams",
      createElement(Routes, null, createElement(Route, { path: "/library/teams", element: createElement(TeamsPage) })),
    );
    await waitFor(() => (container.textContent ?? "").includes("feature-team"));
    expect(container.textContent).toContain("feature-team");
    act(() => root.unmount());
    container.remove();
  });

  it("Library RubricsPage + ProfilesPage render real data", async () => {
    const r = await renderAt(
      "/library/rubrics",
      createElement(Routes, null, createElement(Route, { path: "/library/rubrics", element: createElement(RubricsPage) })),
    );
    await waitFor(() => (r.container.textContent ?? "").length > 100);
    expect(r.container.textContent).toContain("Rubrics");
    act(() => r.root.unmount());
    r.container.remove();

    const p = await renderAt(
      "/library/profiles",
      createElement(Routes, null, createElement(Route, { path: "/library/profiles", element: createElement(ProfilesPage) })),
    );
    await waitFor(() => (p.container.textContent ?? "").includes("web-ui"));
    expect(p.container.textContent).toContain("web-ui");
    act(() => p.root.unmount());
    p.container.remove();
  });

  it("Dashboard renders against the live server", async () => {
    const { container, root } = await renderAt(
      "/",
      createElement(Routes, null, createElement(Route, { path: "/", element: createElement(DashboardPage) })),
    );
    await waitFor(() => (container.textContent ?? "").includes("Providers"));
    expect(container.textContent).toContain("Dashboard");
    act(() => root.unmount());
    container.remove();
  });

  it("SystemPage doctor renders the live provider matrix", async () => {
    const { container, root } = await renderAt(
      "/system",
      createElement(Routes, null, createElement(Route, { path: "/system", element: createElement(SystemPage) })),
    );
    await waitFor(() => (container.textContent ?? "").includes("anthropic"));
    expect(container.textContent).toContain("Provider matrix");
    act(() => root.unmount());
    container.remove();
  });

  /* ── SSE round-trip ──────────────────────────────────────────────────── */

  it("POST /doctor emits a doctor.result frame on the global SSE stream", async () => {
    const got = await new Promise<boolean>((resolve) => {
      const req = http.request(`${server.base}${apiPaths.events}`, (res) => {
        let buf = "";
        const to = setTimeout(() => resolve(false), 28_000);
        res.on("data", (c) => {
          buf += c.toString();
          if (buf.includes("doctor.result")) {
            clearTimeout(to);
            res.destroy();
            resolve(true);
          }
        });
      });
      req.end();
      // Trigger the async doctor after the stream is open.
      setTimeout(() => {
        http.request(`${server.base}${apiPaths.doctor}`, { method: "POST" }, (r) => r.resume()).end();
      }, 1000);
    });
    expect(got).toBe(true);
  }, 32_000);
});
