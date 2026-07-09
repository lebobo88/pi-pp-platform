import type { ProjectDetail, DocContent, ProjectProfileDocument } from "@shared/api-types";
import { mockProjects, mockRunSummaries } from "./catalog";

/** Project detail keyed by path — enriches the base Project with doc status. */
export const mockProjectDetails: Record<string, ProjectDetail> = {
  "C:/AiAppDeployments/acme-checkout": {
    ...mockProjects[0]!,
    active_profile: "web-ui",
    constitution: { present: true, sha: "cst_88ac41", updated_at: "2026-06-20T10:00:00.000Z", sections: null },
    agents_md: { present: true, sha: "agm_2231", updated_at: "2026-07-01T14:14:00.000Z", sections: 6 },
    master_plan: { present: true, sha: "mp_5590", updated_at: "2026-07-01T14:14:05.000Z", sections: 20 },
    recent_runs: mockRunSummaries.filter((r) => r.project_path === "C:/AiAppDeployments/acme-checkout").slice(0, 5),
  },
  "C:/AiAppDeployments/orbit-api": {
    ...mockProjects[1]!,
    active_profile: "api-platform",
    constitution: { present: true, sha: "cst_7712", updated_at: "2026-06-11T09:00:00.000Z", sections: null },
    agents_md: { present: true, sha: "agm_9931", updated_at: "2026-06-29T09:58:00.000Z", sections: 6 },
    master_plan: { present: true, sha: "mp_1180", updated_at: "2026-06-29T09:58:12.000Z", sections: 20 },
    recent_runs: mockRunSummaries.filter((r) => r.project_path === "C:/AiAppDeployments/orbit-api").slice(0, 5),
  },
  "C:/AiAppDeployments/pi-pp-platform": {
    ...mockProjects[2]!,
    active_profile: "internal-tool",
    constitution: { present: false, sha: null, updated_at: null, sections: null },
    agents_md: { present: true, sha: "agm_0007", updated_at: "2026-06-30T22:15:00.000Z", sections: 6 },
    master_plan: { present: true, sha: "mp_0007", updated_at: "2026-06-30T22:15:00.000Z", sections: 20 },
    recent_runs: mockRunSummaries.filter((r) => r.project_path === "C:/AiAppDeployments/pi-pp-platform").slice(0, 5),
  },
};

export const mockMasterPlan: DocContent = {
  path: "PROJECT_MASTER.md",
  sha: "mp_5590",
  updated_at: "2026-07-01T14:14:05.000Z",
  markdown: `# PROJECT_MASTER.md — acme-checkout

## 6. Functional requirements

- Coupon-code entry on the checkout page (server-validated).
- Discount applied to order total; clamps at zero.
- Inline error for invalid / expired codes.

## 11. Architecture and technical strategy

Discount resolution is a single \`couponRepo.findActive\` lookup inside
\`computeTotals\`. See **ADR-0007** (design stage of run \`run_9fK2aLpQ7vX3\`).

## 12. Interfaces and contracts

\`POST /api/checkout/apply-coupon\` — see \`contracts/openapi.yaml\`. Returns
\`422\` with \`{ error, details }\` on an invalid code.

## 15. Test and verification strategy

- Unit: \`order.test.ts\` covers percent + fixed coupons and the zero clamp.
- Missability: **changelog-present** currently *failing* — the run surfaced.

> _Patched by run \`run_9fK2aLpQ7vX3\` (feature-team), 2026-07-01._
`,
};

export const mockAgentsMd: DocContent = {
  path: "AGENTS.md",
  sha: "agm_2231",
  updated_at: "2026-07-01T14:14:00.000Z",
  markdown: `# AGENTS.md — acme-checkout

The cross-tool behavioral contract every AI agent reads at session start.

## Conventions

- TypeScript strict; no \`any\` in \`src/checkout/**\`.
- All money math goes through \`round()\`; never float-compare totals.

## Build commands

\`\`\`
pnpm -F @acme/checkout test
pnpm -F @acme/checkout build
\`\`\`

## Architecture (managed — section 11)

Discount logic lives in \`src/checkout/order.ts\`. Do not inline coupon lookups
in the controller.
`,
};

export const mockConstitution: DocContent = {
  path: "CONSTITUTION.md",
  sha: "cst_88ac41",
  updated_at: "2026-06-20T10:00:00.000Z",
  markdown: `# CONSTITUTION.md — acme-checkout (Immortal Head)

1. **No unreviewed money-path changes.** Any change to \`computeTotals\` requires
   a cross-vendor verdict.
2. **Server-side validation is non-negotiable.** Never trust a client-supplied
   discount amount.
3. **Attested amendments only.** This document changes solely via
   \`/pp:constitution amend\` with an attestation id.
`,
};

export const mockProjectProfiles: Record<string, ProjectProfileDocument> = {
  "C:/AiAppDeployments/acme-checkout": {
    path: "C:/AiAppDeployments/acme-checkout/.harness/profile.yaml",
    yaml: [
      "name: web-ui",
      "description: User-facing checkout app with a coupon flow override.",
      "ladder:",
      "  sonnet: openai/gpt-5.4",
      "tier_pools:",
      "  sonnet:",
      "    - openai/gpt-5.4-mini",
      "    - azure-openai/gpt-5.4-mini",
      "    - anthropic/claude-sonnet-4-6",
      "",
    ].join("\n"),
    resolved: {
      name: "web-ui",
      description: "User-facing checkout app with a coupon flow override.",
      required_taxonomy_sections: ["4.4", "4.13"],
      required_artifacts: ["screen_state_matrix", "a11y_plan"],
      required_validators_strict: ["browser_validation"],
      ladder: { sonnet: "openai/gpt-5.4" },
      tier_pools: { sonnet: ["openai/gpt-5.4-mini", "azure-openai/gpt-5.4-mini", "anthropic/claude-sonnet-4-6"] },
      model_tier_policy: { default_cap: "opus", scope_adjust: { trivial: -1, standard: 0, major: 1 } },
    },
  },
  "C:/AiAppDeployments/orbit-api": {
    path: "C:/AiAppDeployments/orbit-api/.harness/profile.yaml",
    yaml: [
      "name: api-platform",
      "description: Contracts-first API service.",
      "",
    ].join("\n"),
    resolved: {
      name: "api-platform",
      description: "Contracts-first API service.",
      required_taxonomy_sections: ["4.7", "4.9", "4.10"],
      required_artifacts: ["openapi", "event_catalog"],
      required_validators_strict: ["contracts_lint"],
    },
  },
  "C:/AiAppDeployments/pi-pp-platform": {
    path: "C:/AiAppDeployments/pi-pp-platform/.harness/profile.yaml",
    yaml: [
      "name: internal-tool",
      "description: Internal tooling with a custom haiku rotation.",
      "tier_pools:",
      "  haiku:",
      "    - anthropic/claude-haiku-4-5-20251001",
      "    - google/gemini-2.5-flash",
      "",
    ].join("\n"),
    resolved: {
      name: "internal-tool",
      description: "Internal tooling with a custom haiku rotation.",
      required_taxonomy_sections: ["4.3", "4.8", "4.13"],
      required_artifacts: ["feature_spec", "code"],
      tier_pools: { haiku: ["anthropic/claude-haiku-4-5-20251001", "google/gemini-2.5-flash"] },
    },
  },
};
