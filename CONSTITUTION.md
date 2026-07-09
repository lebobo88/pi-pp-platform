# Constitution — pi-pp-platform

> "One head that cannot die." — The Constitution is the immortal head of
> this project. The harness will read it, hash it, and attest against it.
> No agent will ever rewrite it. Amendments are HITL-only via
> `/pp:constitution amend`.

**Adopted**: 2026-07-09
**Amendment policy**: HITL-only via `/pp:constitution amend`

---

## Article I — Identity

pi-pp-platform is a web control plane for the pair-programmer AI coding
harness running on the pi runtime. It provides multi-provider code
generation, cross-vendor judging, best-of-N candidate selection, budget
enforcement, and a full run-lifecycle UI. It serves engineering teams that
want to harness LLMs for software development with guardrails — budgets,
gates, and governance — not just raw generation. It is explicitly NOT a
SaaS platform, NOT a general-purpose AI playground, and NOT a replacement
for human code review or architectural judgment.

---

## Article II — Invariants

Hard guarantees no run may violate. Each invariant is a single,
machine-checkable claim.

- Every endpoint and payload change updates `shared/api-types.ts` AND
  `apiPaths` in the same commit.
- `pnpm -r build && pnpm -r typecheck && pnpm -r test` must be green
  before any change is considered done.
- Reflexion ×1 retry per surfaced stage; never more without explicit
  operator override.
- Cross-vendor judging is enforced for elevated gates — judge vendor
  must differ from generator vendor.
- Provider keys are write-only; no API response or SSE frame may echo a
  raw key.
- Budget tripwires (warn/block) are enforced at the per-scope level
  (run, day, model, tier) and cannot be silently bypassed.
- SQLite schema changes are additive only (`CREATE TABLE IF NOT EXISTS`,
  `ALTER TABLE … ADD COLUMN`); never drop or rename columns in a
  migration.
- Asset resolution order is project → user → builtin for teams, skills,
  agents, and rubrics. A project/user skill copy without pp frontmatter
  never shadows a curated built-in of the same id.
- All user-facing UI strings must be localizable (English default; i18n
  pipeline ready).
- No PII may be logged at any severity. Secrets are scrubbed before
  reaching the event bus.

---

## Article III — Forbidden Operations

Operations the harness must refuse OR strongly warn about.

- Auto-merge to main without all gates passing (spec, design, security,
  contract, code_style, docs_polish, lint_class).
- Dropping or truncating a database table without a documented migration
  runbook.
- Removing tests without a documented replacement or explicit
  justification in the commit.
- Shelling out to a vendor CLI when the pi runtime has a native API
  path for that vendor.
- Modifying a test file during a TDD post-code stage (tampering with
  the red/green property).
- Exceeding the Reflexion ×1 budget without an explicit operator
  override (logged and surfaced).
- Serving artifact content outside the project root boundary
  (path-traversal guard).

---

## Article IV — Required Attestations

Stages or taxonomy sections whose finalization MUST be attested against
this constitution.

- Section 4.4 (security): every security-stage run requires a passing
  attestation against the current `constitution_sha`. Threat models
  must reference Article III forbidden operations.
- Section 4.13 (release): every release-stage run requires a passing
  attestation against the current `constitution_sha`.
- Section 4.16 (retirement): every retirement-stage run requires a
  passing attestation.

---

## Article V — Amendment Procedure

Constitutional amendments are not made casually:

1. Author the change as a diff in a separate branch.
2. Run `/pp:constitution amend` and confirm via HITL.
3. The harness records a new `constitution_sha` and binds future runs to
   it. Existing runs replay against their original SHA.

> _(End of constitution. pp records this file's SHA on every run.)_
