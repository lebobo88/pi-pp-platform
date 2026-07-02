/**
 * Phase 8 — Master-plan patch (+ AGENTS.md sync when relevant).
 *
 * Ensures PROJECT_MASTER.md exists, then patches the master-plan sections the
 * run touched. Taxonomy sections map to master-plan sections; here we keep a
 * pragmatic mapping and always record the run in the executive summary so the
 * plan reflects that a run landed. When architecture/interface/standards/
 * security sections are touched, AGENTS.md is synced too.
 */

import { ensureMasterPlan, applyMasterPlanPatch, ensureAgentsAndClaudeMd } from "@pp/core";
import { emit, type RunContext } from "../types.js";

/** taxonomy section id → PROJECT_MASTER.md section header. */
const TAXONOMY_TO_MASTER: Record<string, string> = {
  "4.1": "2. Business and portfolio context",
  "4.2": "3. Stakeholders and users",
  "4.3": "6. Functional requirements",
  "4.4": "9. UX/UI/content design",
  "4.5": "10. Domain and data model",
  "4.6": "11. Architecture and technical strategy",
  "4.7": "12. Interfaces and contracts",
  "4.8": "13. Engineering standards and delivery model",
  "4.9": "14. Security, privacy, and compliance",
  "4.10": "15. Test and verification strategy",
  "4.11": "19. Launch, migration, and rollback plan",
  "4.12": "16. Operations and support model",
  "4.13": "Appendices",
  "4.14": "17. Team operating model and governance",
  "4.15": "11. Architecture and technical strategy",
  "4.16": "20. Deprecation and retirement plan",
};

/** Master-plan sections that mirror into AGENTS.md when touched. */
const AGENTS_MD_SECTIONS = new Set([
  "11. Architecture and technical strategy",
  "12. Interfaces and contracts",
  "13. Engineering standards and delivery model",
  "14. Security, privacy, and compliance",
]);

export function runMasterPlanPhase(ctx: RunContext): void {
  ensureMasterPlan(ctx.projectPath);

  const touchedMaster = new Set<string>();
  touchedMaster.add("1. Executive summary");

  for (const section of ctx.sections) {
    const target = TAXONOMY_TO_MASTER[section.id];
    if (target) touchedMaster.add(target);
  }

  const patched: string[] = [];
  for (const section of touchedMaster) {
    const body =
      section === "1. Executive summary"
        ? `Run ${ctx.run_id}: ${ctx.requestText}\n`
        : `Updated by run ${ctx.run_id} (${ctx.requestText}).\n`;
    const res = applyMasterPlanPatch({
      run_id: ctx.run_id,
      project_path: ctx.projectPath,
      section,
      kind: "append",
      content_md: body,
    });
    if (res.status === "applied" || res.status === "noop_already_applied") {
      patched.push(res.resolved_section);
    }
  }

  // AGENTS.md sync when architecture/interface/standards/security touched. The
  // full apply_agents_md_patch propagation lands with the agents-md-author role
  // in M4; here we guarantee the file exists so the contract stays intact.
  const agentsRelevant = [...touchedMaster].some((s) => AGENTS_MD_SECTIONS.has(s));
  if (agentsRelevant) ensureAgentsAndClaudeMd(ctx.projectPath);

  emit(ctx, "run.context", { phase: "master-plan", patched, agents_md_synced: agentsRelevant });
}
