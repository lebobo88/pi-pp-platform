# pi-pp-platform — User Guide

A screen-by-screen tour of the web UI, followed by a plain-language explainer of
what actually happens when you launch a run.

> The UI is fully usable today in **mock mode** (`VITE_MOCK=1 pnpm -F @pp/ui dev`),
> which serves fixtures and replays a scripted, animated run so you can explore
> every screen without a server or API keys. Against the real server, launch/abort/
> retry/gate are `TODO(M5d)`; everything read-only plus provider key management is
> live now.

## The app shell

A fixed left sidebar lists the eight sections — **Dashboard, Projects, Runs,
Providers & Models, Budgets, Evolution, Library, System**. The top bar has a
project picker (scopes the Runs list), a daemon health dot, a day-budget
mini-meter, and a **New run** button. All ids, costs, tokens, and durations
render in a tabular monospace so columns line up.

## Dashboard

Your at-a-glance operations view:

- **Surfaced-runs banner** — a persistent warning strip when any run finished in
  the `surfaced` state (needs human review); each chip links to the run.
- **Active runs strip** — running/pending runs with a live pulsing status dot and
  elapsed timer.
- **Today's budget** — the day meter with 80% (downgrade) and 100% (block)
  tripwire ticks.
- **Providers** — a chip per vendor (ready / degraded / unconfigured).
- **Health** — a doctor summary (DB reachable, cross-vendor readiness).
- **Recent runs** — a sortable table; click a row to open the run.

## Projects

**Projects** lists every project path the harness has seen (name, path, detected
profile, run count, last run). **Register project** opens a dialog that validates
the path shape (a real registration lands with the server).

Opening a project gives you tabbed detail:

- **Overview** — profile chip, managed-document status (CONSTITUTION.md,
  AGENTS.md, PROJECT_MASTER.md), recent runs, and a **Bootstrap profile** control.
- **Profile** — the resolved profile spec plus an editable `profile.yaml`. If no
  profile is set, **Detect profile** proposes one (with reasons and a preview
  diff of the resulting `.harness/profile.yaml`); **Confirm** writes it. Editing
  the yaml and saving validates server-side — invalid yaml returns inline field
  errors.
- **Master plan / AGENTS.md / Constitution** — the managed markdown documents,
  rendered.

## New run (the launch wizard)

A four-step wizard with a left stepper. You can jump back to any completed step.

1. **Request** — pick the project (its profile chip shows; a missing profile
   links you to bootstrap it) and write the request. A rough token count updates
   as you type.
2. **Mode & team** — choose a mode:
   - **Single** — one generator, one judge, Reflexion ×1 on failure.
   - **Team** — a specialized multi-stage pipeline. The searchable **team picker**
     dims teams whose `profiles_compatible` list excludes the project's profile.
   - **Best-of-N** — a slider for N (2–8) with a per-candidate model/seed preview;
     Borda picks the winner.
   - **Review** — a governance-forum pipeline (pick a forum).
3. **Options** — a **scope override** (auto / trivial / standard / major, with
   hints), **tier cap/floor** selects, and a **cost estimate** (a min–max USD
   range from the stage count × tier ladder × prices) shown against your
   remaining day budget, with a warning if the estimate would exceed it.
   - **Best-of rule:** tier cap/floor are **disabled** in best-of mode — the
     daemon rejects them there (candidates rotate tiers by design), so the wizard
     mirrors that constraint rather than letting you submit a request that 422s.
4. **Review & launch** — a summary; **Launch run** dispatches it and takes you to
   the live run view.

## The live run view

The heart of the app. The header shows the run id, mode, a pulsing live status,
elapsed time, and a **run budget meter** with 80%/100% ticks. Running runs get an
**Abort** button (with a confirm dialog). Tabs:

- **Pipeline** — a left rail of stage nodes (states: pending, running, passed,
  surfaced, failed, skipped) that you click to select; it auto-follows the
  running stage. The selected stage's detail shows:
  - **Attempt cards** — producer, model + tier chip, seed, tokens, cost, wall time.
  - **Verdict cards** — the outcome banner, judge model, a **cross-vendor** badge,
    the critique (rendered markdown), a rubric score table, and a drawer with the
    full rubric body.
  - **Reflexion thread** — when a stage retried, the critique → retry attempt is
    shown as a vertical thread.
  - **Output** — a virtualized, ANSI-colored log pane with a sticky "follow" pill
    that streams live.
  - Per-stage **Retry** (Reflexion ×1) and **Re-gate** (re-judge only) actions.
- **Candidates** — for best-of stages: a candidate grid, a judges × candidates
  **Borda table** (winner marked ★), and a unified diff viewer for the selected
  candidate.
- **Artifacts** — every produced artifact with a markdown/diff preview.
- **Taxonomy** — which taxonomy sections the run covered.
- **Missability** — the Section-6 check results (a failing check is why a run
  surfaces).
- **Budget** — the run's spend broken down by model and by tier.
- **Replay** — the reproducible-replay bundle (prompt hashes, CLI/model versions,
  artifact hashes) as JSON.

## Providers & Models

A card per vendor shows CLI/credential/login status and a **masked** key
fragment. Key management is **write-only**:

- **Set / Replace key** — a password field; the key is sent once and never
  returned. Only a masked fragment (e.g. `sk-ant-…4f9c`) is shown afterward.
- **Test** — a live credential/model-resolution probe; the result (model, latency)
  shows inline.
- **Remove** — deletes the stored credential (confirm required); the vendor
  becomes unconfigured.

Below the cards, two editors persist to harness settings:

- **Tier ladder** — map each Claude tier (fable/opus/sonnet/haiku) to a model.
  Only models from configured providers are offered; `fable` is capability-gated
  and never auto-escalated to.
- **Judge pool** — an ordered list of judge models. If all judges share one
  vendor, a warning flags that cross-vendor gates (spec/design/security/contract)
  will have no eligible judge.

A priced **model catalog** table lists every model and its per-1M-token cost.

## Budgets

- **Spend caps** — editable day/run caps with warn (80%) and block (100%)
  thresholds; the meters preview the tripwires.
- **Day / Run** — capped meters with token breakdowns.
- **By model / By tier** — cost breakdown tables with sparklines.

## Evolution

Autogenesis proposals (self-evolving rubrics/teams/profiles), filterable by
status. Each card shows a **P1/P2/P3** priority band (from recurrence count), the
evidence, and the affected resource. **Review** opens a dialog to
approve / reject / commit / rollback. **High-risk rule:** approving a proposal
that mutates a regulated-standard rubric (OWASP, WCAG, SLSA, NIST) requires typing
an exact confirmation phrase (e.g. `APPROVE OWASP`) — a fat-fingered approval of a
security/accessibility/supply-chain rubric is impossible.

> `TODO(M7)`: proposals are surfaced from the harness; the LLM-driven autogenesis
> analyzer that generates them is wired in M7.

## Library

- **Teams** — cards for every built-in team (stage-kind chips, origin badge);
  a detail drawer shows the full stage → gate → judge-tier pipeline.
- **Rubrics** — the standard-aligned judging rubrics; select one to read its body.
- **Profiles** — each profile's resolved spec and its `extends` chain.

## System

- **Doctor** — the health report: a provider matrix (CLI / API key / logged-in /
  configured / degraded), model-resolution smoke results, CLI versions, and
  browser-engine availability. **Re-run doctor** refreshes it.
- **Janitor** — the housekeeping report (swept items, reclaimed bytes). **Dry run**
  previews; **Execute** (confirm required) deletes abandoned worktrees, stale
  logs, and temp caches.

---

## How a run actually works

When you launch a run, `RunPilot` drives a **9-phase lifecycle**. In user terms:

1. **Triage** — classifies the request as *trivial*, *standard*, or *major*. This
   scales how strict the gates are (major forces team mode / best-of races on
   high-surface stages). Your scope override in the wizard biases this.
2. **Profile** — resolves the project profile (from `.harness/profile.yaml`, or
   auto-detected). The profile decides required taxonomy sections, rubrics,
   validators, and missability checks.
3. **Taxonomy mapping** — maps the request to the relevant sections of the
   16-section taxonomy, which determines the artifacts the run must produce.
4. **Stage loop** — the core. For each stage the harness:
   - **generates** an artifact with a chosen producer + Claude **tier** (the tier
     resolver honors your cap/floor, the profile policy, and per-stage pins);
   - **judges** it against the stage's rubric. Gate strictness drives whether the
     judge must be **cross-vendor** — spec / design / security / contract gates
     (and every gate under the `enterprise` profile, or any prompt mentioning
     concurrency/security/data-integrity) require a judge from a *different*
     vendor than the generator; code-style / docs / lint gates allow a
     same-vendor different-model judge.
   - On a failing verdict, **Reflexion ×1** feeds the critique back to the
     generator for exactly one retry. For *major* stages, the harness instead runs
     a **best-of-N** candidate race and picks a winner by **Borda count** rather
     than reflexion-ing a single attempt to death.
5. **Missability checks** — a library of Section-6 checks (e.g. "changelog
   present", "tests cover new behavior", "no secrets in diff"). A failing check
   **surfaces** the run for human review instead of silently completing it.
6. **Master-plan patch** — the run's contributions are patched into the project's
   `PROJECT_MASTER.md` (and `AGENTS.md` when architecture/interface/standards/
   security sections changed), keeping the living project plan in sync.
7. **Finalize** — writes the run summary, archives best-of losers, and closes the
   run as `complete` (all gates passed, no missability failures) or `surfaced`.

Two invariants worth knowing as a user:

- **Reflexion ×1** — a surfaced stage is retried *at most once* automatically. You
  can trigger one more manual retry from the run view (**Retry**), which honors
  the same invariant.
- **Cross-vendor judging** needs at least two configured providers. With one
  provider, security-class gates can't get an independent judge and the run
  surfaces rather than self-certifying — see
  [INSTALL.md](INSTALL.md#provider-keys) for what degrades with fewer keys.
