/** Canonical query keys. One place so invalidation stays consistent. */
export const qk = {
  health: ["health"] as const,
  doctor: ["doctor"] as const,

  projects: ["projects"] as const,
  project: (path: string) => ["projects", path] as const,
  projectDoc: (path: string, doc: string) => ["projects", path, "doc", doc] as const,

  runs: (filter?: unknown) => ["runs", filter ?? {}] as const,
  run: (runId: string) => ["runs", "detail", runId] as const,
  runReplay: (runId: string) => ["runs", "replay", runId] as const,
  runMissability: (runId: string) => ["runs", "missability", runId] as const,

  providers: ["providers"] as const,
  models: ["models"] as const,

  budgets: ["budgets"] as const,
  budget: (scope: string) => ["budgets", scope] as const,
  budgetCaps: ["budgets", "caps"] as const,
  janitor: ["system", "janitor"] as const,

  teams: ["teams"] as const,
  team: (name: string) => ["teams", name] as const,

  profiles: ["profiles"] as const,
  profile: (name: string) => ["profiles", name] as const,

  rubrics: ["rubrics"] as const,
  rubric: (id: string) => ["rubrics", id] as const,

  evolution: ["evolution"] as const,
};
