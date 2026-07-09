# pi-pp-platform — User Guide

A screen-by-screen tour of the web UI, followed by a plain-language explainer of
what actually happens when you launch a run.

> Two ways to explore without API keys: **demo mode** (`pnpm demo`) boots the real
> UI + real server driven by the fake engine, so you can launch a run end to end
> and watch the pipeline animate from real SSE events; **mock mode**
> (`VITE_MOCK=1 pnpm -F @pp/ui dev`) serves fixtures and a scripted animated run in
> the browser with no server. Run control (launch / abort / retry / gate) is live
> against the real server.

## The app shell

A fixed left sidebar lists the eight sections — **Dashboard, Projects, Runs,
Providers & Models, Budgets, Evolution, Library, System**. The sidebar
**collapses** to an icon rail: click the chevron at the bottom, or press
**`[`** anywhere outside a text field (collapsed items show their label as a
tooltip). The top bar has a **searchable project picker** (a popover with an
autofocused filter input and a keyboard-navigable list; it scopes the Runs
list), a daemon health dot, a day-budget mini-meter, and a **New run** button.
All ids, costs, tokens, and durations render in a tabular monospace so columns
line up. Every route except the Dashboard is code-split, so screens load
on demand.

If the daemon is started with `PP_API_TOKEN` set, the first 401 raises a
non-dismissable **API token** prompt: paste the token once and the UI stores it
locally, sends it as a bearer header on every request (and as `?token=` on the
SSE streams — `EventSource` can't set headers), and refetches everything. A
wrong token simply re-prompts with an inline error. You can change or clear the
stored token later from **System → API access**.

## Dashboard

Your at-a-glance operations view:

- **Get started checklist** — shown only while the harness has zero runs: three
  live steps (add a provider key → register a project → launch your first run).
  The checkmarks observe the real queries, and the "New run" step stays disabled
  until a provider is configured and a project is registered.
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
- **Profile** — the project's actual `.harness/profile.yaml` plus the resolved
  profile spec the harness will use at run time. If no profile is set,
  **Detect profile** proposes one (with reasons and a preview diff of the
  resulting `.harness/profile.yaml`); **Confirm** writes it. Editing the raw
  yaml and saving validates server-side — invalid yaml returns inline field
  errors. Project-local `ladder`, `tier_pools`, and `model_tier_policy`
  overrides all live here. Pool entries are provider-qualified and ordered,
  for example `openai/gpt-5.4-mini` before `azure-openai/gpt-5.4-mini`.
- **Master plan / AGENTS.md / Constitution** — the managed markdown documents,
  rendered.

## New run (the launch wizard)

A four-step wizard with a left stepper. You can jump back to any completed step.

1. **Request** — pick the project (its profile chip shows; a missing profile
   links you to bootstrap it) and write the request. A rough token count updates
   as you type.
2. **Mode & team** — entering this step fires the deterministic **team
   recommender** (`POST /teams/recommend` — pure heuristics over the request
   text, triage signals, and the project profile; no model calls). An advisory
   banner shows the top pick with its **confidence** (high/medium/low) and the
   per-rule **reasons**; outside team mode a one-click **"Use team mode with
   <team>"** button switches for you. Then choose a mode:
   - **Single** — one generator, one judge, Reflexion ×1 on failure.
   - **Team** — a specialized multi-stage pipeline. The searchable **team picker**
     dims teams whose `profiles_compatible` list excludes the project's profile.
     Recommended teams sort to the top with a `recommended · <confidence>`
     badge, and the top pick is **preselected** ("Preselected by the
     recommender — pick any other team to override"); a manual pick is never
     clobbered by a re-run of the recommender.
   - **Best-of-N** — a slider for N (2–8) with a per-candidate model/seed preview;
     Borda picks the winner.
   - **Review** — a governance-forum pipeline (pick a forum).
3. **Options** — a **scope override** (auto / trivial / standard / major, with
   hints), **tier cap/floor** selects, an **Advanced model routing** section,
   and a **cost estimate** (a min–max USD range from the stage count × tier
   ladder × prices) shown against your remaining day budget, with a warning if
   the estimate would exceed it.
   - **Advanced model routing:** optional per-run **ladder overrides** (tier →
     model id) and **tier-pool overrides** (tier → ordered model list). The UI
     prefers provider-qualified ids like `openai/gpt-5.4-mini`, preserves the
     order exactly, and treats `openai/gpt-5.4-mini` and
     `azure-openai/gpt-5.4-mini` as distinct choices. These win over the
     project profile, global harness settings, and catalog defaults for that
     run only.
   - **Major-scope nudge:** picking **major** scope (or a recommender verdict
     that the request is major) while not in team mode raises a warning strip —
     "Major scope requires a team pipeline — switch to team mode?" — with a
     one-click switch (carrying the recommended team when there is one) and a
     Dismiss.
   - **Best-of rule:** tier cap/floor are **disabled** in best-of mode — the
     daemon rejects them there (candidates rotate tiers by design), so the wizard
     mirrors that constraint rather than letting you submit a request that 422s.
     Per-run ladder/pool overrides remain available in best-of mode.
4. **Review & launch** — a summary (team runs also show the **team source** —
   `recommended (<confidence>)` vs `manual`); **Launch run** dispatches it and
   takes you to the live run view.

## Runs (the history list)

Run history across all projects, scoped by the top-bar project picker and a
status filter. The list is **cursor-paginated**: the UI requests pages of 25
from the server's `{items, next_cursor}` envelope, and a **Load more** button
below the table fetches the next page until it reads "End of history". Column-header
sorting only activates once every page is loaded (sorting a partial page would
mislead). Click a row to open the run.

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

All **35 providers** from pi's builtin catalog are enabled — any of them can be
keyed and used as a generator or judge. The page has:

- **Add a provider** — a picker over every provider that doesn't yet have a
  card, captioned with its display name and env-key hint (e.g.
  `DEEPSEEK_API_KEY`); pick one and **Set key** to bring it online.
- A **search box** that filters the provider cards by name, display name, or
  env-key hint, and two groups: **Configured** (keyed) above **Available**.
- A card per provider with its status (ready / degraded / unconfigured), a
  **masked** key fragment, and its env-key hint. Key management is
  **write-only**:
  - **Set / Replace key** — a password field; the key is sent once and never
    returned. Only a masked fragment (e.g. `sk-ant-…4f9c`) is shown afterward.
  - **Test** — a live credential/model-resolution probe; the result (model,
    latency) shows inline.
  - **Refresh models** — re-fetches the provider's live model list
    (`POST /providers/:vendor/models/refresh`); the result feeds the
    ladder/judge autocomplete and the priced catalog. A toast reports how many
    model ids came back (or that the static fallback was used).
  - **Remove** — deletes the stored credential (confirm required); the vendor
    becomes unconfigured.

Below the cards, two editors persist to harness settings. Every model-id input
on the page shares one **autocomplete** fed by the priced catalog plus each
configured provider's live model list:

- **Generation ladders** — map each tier (fable/opus/sonnet/haiku) of each
  named ladder to a provider-qualified model id; `fable` is capability-gated
  and never auto-escalated to. Each tier also has an optional **pool** editor:
  pool entries rotate across Reflexion retries and best-of candidates, while
  the ladder's plain model-id field remains the single-model fallback. The same
  model name can appear more than once when each entry names a different
  provider, and the pool's top-to-bottom order is the exact priority order.
- **Judge pool** — an ordered list of judge models (type an id and pick from the
  suggestions; unknown ids are rejected). If all judges share one provider, a
  warning flags that cross-vendor gates (spec/design/security/contract) will
  have no eligible judge.

A priced **model catalog** table lists every model and its per-1M-token cost.

## Budgets

- **Spend caps** — editable day/run caps with warn (80%) and block (100%)
  thresholds; the meters preview the tripwires.
- **Day / Run** — capped meters with token breakdowns.
- **By model / By tier** — cost breakdown tables with sparklines.

## Evolution

Autogenesis proposals (self-evolving rubrics/prompts/checks), filterable by
status. Each card shows a **P1/P2/P3** priority band (from recurrence count), the
evidence, and the affected resource. **Review** opens a dialog whose actions
follow the proposal's lifecycle: **approve / reject** while pending, **commit**
once approved, **rollback** once committed.

- **Commit is reviewer-authored.** The autogenesis analyzer only *detects*
  recurring drift — it authors no patch. The commit dialog has a content editor
  where you write the actual replacement body; the server rejects a commit
  without it (422 `content_required`). Committing writes the body to the
  proposal's **project-scoped override** (rubrics →
  `<project>/.claude/rubrics/`, stage prompts → `<project>/.claude/agents/`,
  missability checks → `<project>/.harness/missability-overrides.json`) — a
  proposal can never write outside the project's override roots.
- **Rollback is real.** Before a commit, the pre-existing target is snapshotted
  under `<project>/.harness/evolution/<proposal_id>/before/`; rollback restores
  the snapshot (or deletes the override if the target didn't exist before).
  Every commit/rollback is recorded in an audit table (target + snapshot paths,
  before/after content hashes).
- **High-risk rule:** any mutation of a regulated-standard rubric (OWASP, WCAG,
  SLSA, NIST) — approve, commit, *or* rollback — requires typing an exact
  confirmation phrase (e.g. `APPROVE OWASP`); a fat-fingered change to a
  security/accessibility/supply-chain rubric is impossible. Only reject skips
  the phrase.

> Commits and rollbacks are **local** — no ecosystem needed. When a proposal was
> echoed by TheEights at propose time (it shows an `eights:` id on the card),
> the commit/rollback is mirrored there fire-and-forget; an unreachable daemon
> never blocks the local write.

## Library

Seven tabs, each with a live count badge on the active tab:

- **Teams** (26) — cards for every built-in team (stage-kind chips, origin
  badge); a detail drawer shows the full stage → gate → judge-tier pipeline.
- **Agents** (75) — the role prompts that team and forum stages dispatch, in a
  searchable master-detail browser **grouped by category**. The detail pane
  shows the prompt body, category/tier/model chips, and **"used by"
  cross-references** — every team that dispatches the agent, linked back to the
  Teams tab. Selection deep-links via `?id=`.
- **Skills** (17 built-in) — a first-class **skill registry**: frontmatter
  markdown files carrying reusable domain knowledge (judge policy, artifact
  conventions, executive frameworks…). Resolution is layered — project
  `.claude/skills/` → user `~/.claude/skills/` → built-in `assets/skills/`,
  first match wins — and both flat `<id>.md` files and `<id>/SKILL.md`
  directories are accepted. Each skill's detail shows its **injection target**
  and `applies_to_*` scoping chips (stage kinds / profiles; empty or `*` =
  applies everywhere). See "Skill injection" below for what this does at run
  time.
- **Rubrics** (27) — the standard-aligned judging rubrics; select one to read
  its body.
- **Profiles** (16) — each profile's resolved spec and its `extends` chain.
- **Forums** (10) — the governance-review forums, as a card grid; a drawer shows
  each forum's pipeline stage by stage (generator agent — linked to the Agents
  tab — gate type, judge tier, rubric) plus its required missability checks.
- **Taxonomy** (16) — the taxonomy sections as a flat table: id, title, default
  artifact kinds, and the master-plan section each maps to.

### Skill injection

Skills whose frontmatter says `injection: generator` are automatically injected
into the **generator prompt** of every stage whose kind / agent / gate type /
profile matches their `applies_to_*` lists, rendered as an
`## Applicable skills` block (one `### Skill: <name>` section each). Team yamls
can also request skills **by name**: a stage's `skills:` list is always injected
into that stage's generator prompt, regardless of the skill's own
injection/scoping (unresolvable ids warn at team load and are skipped at
injection — never fatal).

Injection is budgeted and deterministic: skills are taken in priority order
(then id order), each body is truncated to its `max_chars` (default 6000), and
a total per-prompt budget of `PP_SKILLS_BUDGET_CHARS` characters (default
24000) is enforced — the first skill that no longer fits exhausts the budget
and everything after it is skipped.

## System

Two tabs — **Doctor** and **Janitor** — plus the API access card:

- **Doctor** — the health report: a provider matrix (CLI / API key / logged-in /
  configured / degraded), model-resolution smoke results, CLI versions, and
  browser-engine availability. **Re-run doctor** refreshes it; an optional
  **"include critique smoke test"** checkbox makes the re-run actually call each
  keyed vendor (off by default — the smoke test costs a few tokens per vendor).
- **API access** — the stored UI token, masked to its last 4 characters.
  **Change** opens a paste-a-token dialog; **Clear** drops it (a token-guarded
  daemon will 401 and the token prompt reappears). The token rides as a bearer
  header on every request and as `?token=` on the SSE streams.
- **Janitor** — the housekeeping report. **Dry run** computes the full sweep
  plan *without touching anything* and reports the candidates; **Execute**
  (confirm required) performs the sweep. Both show per-entry **byte and age
  accounting** — a table of every swept path with its kind (worktree / branch /
  lock / run), size, and age — plus the totals (items swept, bytes reclaimed).
  Executed reports are persisted, so the last sweep is always visible.

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
     resolver honors your cap/floor, the profile policy, and per-stage pins).
     Matching **skills** from the registry (plus any the team yaml names for the
     stage) are injected into the generator prompt, budgeted by
     `PP_SKILLS_BUDGET_CHARS` — see [Skill injection](#skill-injection);
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

## The live event stream

Every screen that reflects a run is driven by the daemon's SSE streams. Opening a
run detail replays the run's whole event history from the server ring buffer, then
follows live, so the pipeline is always current even if you open it after the run
started. The events the UI surfaces:

- `run.queued` — the run is waiting behind the concurrency cap
  (`PP_MAX_CONCURRENT_RUNS`, default 2). The UI shows a **"Run queued"** toast; the
  run starts and streams normally once a slot frees.
- `run.started` → the run enters the **running** state (pulsing status).
- `stage.started` / `stage.finalized` / `stage.surfaced` — animate the pipeline
  rail node by node (pending → running → passed / surfaced / failed).
- `attempt.started` / `attempt.completed` / `attempt.output` — attempt cards and
  the streaming log pane.
- `verdict.recorded` / `reflexion.retry` / `borda.updated` — verdict cards, the
  reflexion thread, and the best-of Borda board.
- `budget.tick` — updates the run budget meter live; `budget.tripwire` raises a
  toast at 80% (downgrade) / 100% (block).
- `run.finalized` — the run closes as `complete` or `surfaced` and a toast fires.

## Modes and tooling

- **Demo mode** — `pnpm demo` builds the UI + server and boots `ppd` with the fake
  engine (`PP_LLM=fake`). You get the real UI against the real server with no API
  keys: launch a run from the wizard and watch it animate to `run.finalized`. Great
  for a walkthrough or a screenshot.
- **Mock mode** — `VITE_MOCK=1 pnpm -F @pp/ui dev` runs the SPA against an
  in-browser mock daemon (fixtures + a scripted animated run), no server at all.
- **Integration suite** — `PP_INTEGRATION=1 pnpm -F @pp/ui test:integration` boots
  a real `ppd` and drives the read paths, the full wizard→run→SSE→finalize flow,
  and the abort round-trip against it (build the server first with
  `pnpm -F @pp/server build`).
