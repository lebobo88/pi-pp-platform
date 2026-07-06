# Feature Spec — Run Observatory judge-finding fixes

**Spec ID:** `ui-observability-followup-observatory-fixes-2025-11-25`
**Status:** Draft (ready for implementation)
**Author:** spec-author (autonomous)
**Related run:** `run_tI0TOe3LzMxM` (Run Observatory judge review)
**Scope:** `ui/src/features/observability/AttemptMetaGrid.tsx`, `ui/src/features/observability/RunObservatoryPage.tsx` — **and no other files.**

---

## 1. Background & motivation

The Run Observatory shipped in `run_tI0TOe3LzMxM`. A cross-vendor judge pass surfaced three defects in the observability feature that are behavioral (not cosmetic). This spec fixes exactly those three findings, in the two files named above, without touching call-sites, shared types, or unrelated components. All three findings are UI-layer state / ordering bugs — they do **not** cross the wire contract (`shared/api-types.ts` is unaffected).

The three findings:

1. **`AttemptMetaGrid.tsx`** — the attempt sort comparator is not a strict weak ordering. It switches ordering keys depending on which pair is compared, which violates transitivity and can produce engine-dependent (unstable) results in `Array.prototype.sort`.
2. **`RunObservatoryPage.tsx`** — `selectedStage` can go stale. The initialization `useEffect` only sets a value when it is currently `null`, so a route change to a different run, or the disappearance of the selected stage from the pipeline, leaves the selection pointing at a stage that no longer exists.
3. **`RunObservatoryPage.tsx`** — the cost display uses `Math.max(liveCost, historicalCost)`, which silently mixes two independent data sources and hides authoritative history when the live overlay is stale or partial. The rule must be explicit: prefer live overlay when it is real, otherwise fall back to the historical run-row cost — never `max`.

---

## 2. Non-goals

- No changes outside the two named files.
- No new API endpoints, no changes to `shared/api-types.ts` or `apiPaths`.
- No changes to catalog files, provider generation, or SQLite schema.
- No changes to catalog / providers / prices files.
- No refactors of unrelated code in the two files (imports, styling, unrelated components). Diffs MUST be minimal and localized to the three findings (see §4.7).
- No new user-facing text. Existing labels stay as-is.

---

## 3. Terminology (RFC 2119)

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** in this document are to be interpreted as described in RFC 2119.

Additional terms:

- **Attempt record**: an element of the attempt list rendered by `AttemptMetaGrid`. It has, at minimum, the fields the current comparator inspects: `attemptId: string`, and optionally `startedAt` (ISO timestamp or epoch ms), `retryIndex?: number | null`, `candidateIndex?: number | null`.
- **Live overlay cost** (`liveCost`): the aggregate USD cost derived from the live SSE budget/cost stream for the currently viewed run.
- **Historical cost** (`historicalCost`): the persisted `cost_usd` value returned by the run-row REST endpoint.
- **Cost series** (`costSeries`): the array of run-scoped budget ticks ingested via the live overlay for the current run.

---

## 4. Requirements

### 4.1 Finding 1 — `AttemptMetaGrid.tsx`: strict-weak-ordering comparator

#### 4.1.1 Problem statement

The current comparator behaves like:

- If both attempts have `startedAt`, compare by `startedAt`.
- Else if both have `retryIndex`, compare by `retryIndex`.
- Else if both have `candidateIndex`, compare by `candidateIndex`.
- Else compare by `attemptId`.

This is **not** a strict weak ordering: two pairs of attempts can end up compared using different keys, which breaks transitivity. `Array.prototype.sort` in modern V8 is stable, but the *result* of a non-transitive comparator is undefined regardless of stability — items can appear to leapfrog each other, and the rendered order can differ between runs, between browsers, and between subtle input mutations.

#### 4.1.2 Normative requirements

- **[MUST]** The comparator MUST compare **every** pair of attempts using **the same tuple of keys, in the same order**, without branching on which fields are populated.
- **[MUST]** The comparator MUST reduce to a **single tuple compare** with the following keys, in this exact order (primary → tie-breaker):

  1. `startedAt` as a numeric timestamp (epoch ms), **newest first** (larger timestamp sorts earlier).
  2. `retryIndex`, **newest first** (larger index sorts earlier).
  3. `candidateIndex`, **newest first** (larger index sorts earlier).
  4. `attemptId`, **lexicographic ascending** as the final total-ordering tie-breaker.

- **[MUST]** Missing values MUST be normalized to a fixed sentinel **before** comparison, so that the comparator remains total:

  - Missing / unparseable `startedAt` → sentinel `Number.NEGATIVE_INFINITY` (so records without a timestamp sort **after** those with one, given newest-first order).
  - Missing `retryIndex` → sentinel `-1`.
  - Missing `candidateIndex` → sentinel `-1`.
  - Missing / non-string `attemptId` → sentinel `""` for the comparator only. The comparator MUST NOT crash on such input; downstream render code is unaffected because it already treats `attemptId` as required.

- **[MUST]** The comparator MUST be a **pure function** for the purposes of this spec, defined precisely as: it MUST NOT call `Date.now()`, `performance.now()`, `Math.random()`, or any other non-deterministic source; it MUST NOT read from or write to any variable outside its own parameters and locals (no closure over mutable outer state); and identical input arrays MUST produce identical sorted output on repeated invocation within the same session.

- **[MUST]** `startedAt` parsing MUST accept both:

  - a `number` (already epoch ms), used as-is (including `0`, which is a valid epoch);
  - a `string` parseable by `Date.parse`; if the result is `NaN`, the sentinel `Number.NEGATIVE_INFINITY` is used.
  - Any other type (`null`, `undefined`, `boolean`, object, etc.) MUST resolve to the sentinel.

- **[MUST]** The tuple-normalization step MUST be a small local helper (e.g. `toSortKey(attempt): [number, number, number, string]`) that is called once per attempt inside the comparator, so the comparator body is a straightforward per-index compare loop and the normalization is easy to reason about. (This was previously SHOULD; promoted to MUST because the review gate requires unambiguous acceptance testability — see [AC-1.6].)

- **[MUST NOT]** The comparator MUST NOT branch on "do both attempts have field X" — that is precisely the pattern that produced the non-transitive behavior.

- **[MUST]** Comparator complexity per invocation MUST be O(1) in the number of attempts (i.e. it MUST NOT scan the full attempt list on each compare). It MAY allocate a fixed-size tuple per attempt via the helper above.

#### 4.1.3 Acceptance criteria

- **[AC-1.1]** Given three attempts A, B, C such that A has `startedAt` and no `retryIndex`, B has `startedAt` and a `retryIndex`, and C has only a `retryIndex`, the sorted output is deterministic and identical across repeated calls with the same input array (verified by manual inspection of the rendered order across a page reload).
- **[AC-1.2]** Given two attempts with identical `startedAt`, identical `retryIndex`, identical `candidateIndex`, and different `attemptId`, the one with the lexicographically **smaller** `attemptId` renders first.
- **[AC-1.3]** Given two attempts with identical `startedAt` and identical `retryIndex` but different `candidateIndex`, the one with the **larger** `candidateIndex` renders first.
- **[AC-1.4]** Given two attempts where one has a valid `startedAt` and the other has `startedAt` missing/`null`/unparseable, the one with the valid `startedAt` renders first, regardless of the values of `retryIndex`/`candidateIndex`.
- **[AC-1.5]** Given a `startedAt` of the numeric literal `0`, the attempt is treated as having a valid timestamp (epoch) and sorts accordingly (older than any positive timestamp, but ahead of attempts whose `startedAt` resolves to the sentinel).
- **[AC-1.6]** The comparator implementation contains no `Date.now()`, `performance.now()`, or `Math.random()` call, and closes over no mutable outer variable (verified by code review of the diff).
- **[AC-1.7]** `pnpm -r build`, `pnpm -r typecheck`, and `pnpm -r test` (with `PP_SKIP_CLI_VERSIONS=1`) all remain green. See §6.

---

### 4.2 Finding 2 — `RunObservatoryPage.tsx`: stale `selectedStage`

#### 4.2.1 Problem statement

`selectedStage` is currently initialized once, when it is `null`. Two failure modes follow:

- **Route change**: the user navigates from run X to run Y. The stage id from run X is still held in state; if run Y has no stage with that id, the page renders "no stage selected" or an empty stage view.
- **Stage churn**: while viewing run X, a stage that was previously selected disappears from the pipeline list (e.g. it was pruned by a re-plan, or the pipeline is re-fetched and shape changes). Selection points at a ghost.

#### 4.2.2 Normative requirements

- **[MUST]** Selection state MUST be **reset whenever `runId` changes**. On the tick where `runId` transitions from one value to another, the effect MUST select the appropriate default (see §4.2.3) computed from the current run's stage list — not carry over the previous run's selection.

- **[MUST]** On **every** render where the stage list is available, if the current `selectedStage` id is **not present** in the current stage list, the effect MUST replace it with the default (see §4.2.3). This covers both the "stage was pruned" case and the "stage list was refetched and shape changed" case.

- **[MUST]** The default selection MUST be:

  1. If the stage list is non-empty, the **latest stage** in the pipeline — defined as the last element of the stage list as returned by the existing pipeline query (the pilot returns stages in order of execution; the last one is the latest). This matches operator intuition ("I opened the run, show me what's happening now") and preserves the existing first-visit behavior.
  2. If the stage list is empty, `null`.

- **[MUST]** The selection reset MUST use the same setter as the existing initialization path — do not introduce a parallel state store or a ref-based shadow copy.

- **[MUST]** The effect MUST have a dependency array that includes at least `runId` and a stable identity for the stage list contents (e.g. the array reference returned by the query, or a derived key such as `stages.map(s => s.id).join(",")`). It MUST NOT depend on `selectedStage` in a way that would create an infinite update loop; concretely, if the effect writes `selectedStage`, it MUST first compare against the current value and only call the setter when the new value differs.

- **[MUST]** The presence check MUST use `stages.some(s => s.id === selectedStage)` — no `Set` construction is required, stage counts are small and this keeps the diff minimal. (Promoted from SHOULD to MUST so that [AC-2.6] is directly verifiable via code review.)

- **[MUST NOT]** The fix MUST NOT change the shape of `selectedStage` (still a nullable stage-id string) and MUST NOT change how downstream components read it.

- **[MUST NOT]** The fix MUST NOT introduce a "loading" flash when navigating between runs where both stage lists are already cached. Concretely: if TanStack Query returns the new run's stage list synchronously (cache hit, `data` is defined on the first render after the route change), the default selection MUST be computed and applied before the child stage panel renders its "no stage selected" placeholder. If the query returns `undefined` (cache miss / loading), the existing loading UI is used unchanged.

#### 4.2.3 Behavioral matrix

| Situation | Old behavior | Required new behavior |
|---|---|---|
| First visit to a run, `selectedStage === null`, stages non-empty | selects latest stage | **unchanged**: selects latest stage |
| First visit to a run, `selectedStage === null`, stages empty | leaves `null` | **unchanged**: leaves `null` |
| `runId` changes from X→Y, Y's stages contain the previously selected id | keeps selection (accidentally correct) | keeps selection **only if the id is genuinely present in Y**; otherwise selects Y's latest |
| `runId` changes from X→Y, Y's stages do NOT contain the previously selected id | keeps stale selection (bug) | selects Y's latest stage |
| Same `runId`, stage list refetch removes the selected stage | keeps stale selection (bug) | selects the new latest stage |
| Same `runId`, stage list refetch keeps the selected stage | keeps selection | keeps selection |
| Same `runId`, stage list is empty (edge) | keeps stale selection (bug) | resets to `null` |

#### 4.2.4 Acceptance criteria

- **[AC-2.1]** When the user navigates from run X (with stages `[s1, s2, s3]`, `selectedStage === s2`) to run Y (with stages `[s10, s11]`), the page renders with `selectedStage === s11` (Y's latest), not `s2`.
- **[AC-2.2]** When the user navigates from run X (`selectedStage === s2`) to run Y (with stages `[s1, s2, s4]`), the page renders with `selectedStage === s2` (id is still present in Y).
- **[AC-2.3]** When the pipeline query refetches and the previously selected stage id is no longer in the list, the selection updates to the new latest stage on the next render, without operator action.
- **[AC-2.4]** When the pipeline is empty for the current run, `selectedStage === null` and the page renders its existing empty-pipeline placeholder (do not change the placeholder).
- **[AC-2.5]** Rapidly toggling between two cached runs (X → Y → X → Y) does not cause a render loop. Manual verification: React DevTools shows the effect running at most once per route transition per stage-list identity change; no "Maximum update depth exceeded" warning is logged.
- **[AC-2.6]** The effect implementation uses `stages.some(s => s.id === selectedStage)` for the presence check, and guards its setter call with a `selectedStage !== next` comparison (verified by code review of the diff).
- **[AC-2.7]** When navigating between two runs whose stage lists are both already in TanStack Query's cache, the stage detail panel does not render its "no stage selected" placeholder at any point during the transition (verified by manual observation).

---

### 4.3 Finding 3 — `RunObservatoryPage.tsx`: cost fallback rule

#### 4.3.1 Problem statement

The current display cost is `Math.max(liveCost, historicalCost)`. That silently mixes two independent data sources:

- If the live SSE overlay is behind (e.g. a partial reconnection), `historicalCost` can dominate — masking the fact that the overlay is stale.
- If the historical row hasn't been updated yet (e.g. a mid-flight run), `liveCost` correctly dominates — but only by coincidence, not by rule.
- If both sources disagree and both are non-zero, `max` picks the larger, which is not always the authoritative one.

The rule must be explicit and observable.

#### 4.3.2 Normative requirements

- **[MUST]** The displayed cost MUST be computed by a single, explicit rule (below) — never by `Math.max`, `Math.min`, `Math.avg`, or any other blending function over `liveCost` and `historicalCost`.

- **[MUST]** The rule is:

  1. Let **liveHasSignal** be true iff **either** `liveCost > 0` **or** the run-scoped `costSeries` for the currently viewed `runId` is non-empty (`costSeries.length > 0`).
  2. If `liveHasSignal` is true, the displayed cost MUST be `liveCost`.
  3. Otherwise, the displayed cost MUST be `historicalCost` (which MAY itself be `0` or `null`; existing rendering for `null` / zero is preserved).

- **[MUST]** `costSeries` MUST be **scoped to the currently viewed `runId`**. If the live overlay retains series from a previously viewed run after route change, the rule MUST evaluate only the series belonging to the current `runId`. Concretely, before applying the rule, the code MUST filter or select `costSeries` to the current `runId` (or MUST read from a source that is already so scoped). This prevents a stale series from one run from causing another run's card to prefer a zero `liveCost`.

- **[MUST]** The rule MUST be implemented as a small local helper or a single computed value with an intention-revealing name (e.g. `displayCost` or `resolveDisplayCost`). It MUST NOT be inlined as a chain of ternaries inside a JSX expression. (Promoted from SHOULD to MUST so [AC-3.5] is directly verifiable via code review, and so the diff has a single obvious place to attach a comment explaining the priority order.)

- **[MUST]** When both `liveHasSignal` is false and `historicalCost` is nullish, the display MUST fall through to whatever placeholder the component already renders for "no cost yet" (e.g. `"—"` or blank). The fix MUST NOT introduce a new placeholder value or string.

- **[MUST NOT]** The fix MUST NOT introduce a new API call, a new query, or a new subscription. It uses only data already available on the page.

- **[MUST NOT]** The fix MUST NOT change the visual formatting (currency symbol, decimal places, tooltip). Only the numeric input to the existing formatter changes.

#### 4.3.3 Behavioral matrix

| liveCost | costSeries (scoped) | historicalCost | Displayed | Notes |
|---|---|---|---|---|
| `0` | empty | `0.42` | `0.42` | historical wins (no live signal) |
| `0` | non-empty | `0.42` | `0` | live wins by presence of ticks, even at $0 |
| `0.10` | empty | `0.42` | `0.10` | live wins by positive value |
| `0.10` | non-empty | `0.42` | `0.10` | live wins on both signals |
| `0.10` | non-empty | `null` | `0.10` | live wins |
| `0` | empty | `null` | placeholder | fall through to existing "no cost" render |
| `0` | empty | `0` | `0` | historical wins; renders as existing zero display |
| `0` | non-empty from **another** run | `0.42` | `0.42` | scoped `costSeries` is empty for the current run |

#### 4.3.4 Acceptance criteria

- **[AC-3.1]** With no SSE overlay ever attached (`liveCost === 0`, `costSeries` empty for the current run) and a `historicalCost` of `0.42`, the page displays `$0.42`.
- **[AC-3.2]** With a live overlay that has produced at least one cost tick for the current run but whose aggregate is still `0` (edge case: first tick was zero), and a `historicalCost` of `0.42`, the page displays `$0.00` — live wins by presence of ticks.
- **[AC-3.3]** With `liveCost === 0.10` and `historicalCost === 0.42`, the page displays `$0.10` (previously it displayed `$0.42` via `max`).
- **[AC-3.4]** When the user navigates from run X (which had a populated `costSeries`) to run Y (never viewed live), Y's card does not preferentially show `liveCost` from X. Y's rule evaluates against a `costSeries` scoped to Y, which is empty, so historical wins.
- **[AC-3.5]** The diff contains no `Math.max(` call involving `liveCost` and `historicalCost`, and the resolution rule is expressed in a single named local helper or computed value (verified by code review of the diff).
- **[AC-3.6]** When `liveHasSignal` is false and `historicalCost` is `null`/`undefined`, the existing "no cost yet" placeholder is rendered (no new placeholder string is introduced).

---

### 4.4 Preserved invariants

The following invariants MUST hold before and after the change:

- **[MUST]** `shared/api-types.ts` is not modified. The wire contract is unchanged.
- **[MUST]** No file outside `ui/src/features/observability/AttemptMetaGrid.tsx` and `ui/src/features/observability/RunObservatoryPage.tsx` is modified. (This is the "confined to two files" acceptance requirement in §6.)
- **[MUST]** No test file is modified or deleted. (Existing tests MUST continue to pass; see §7 for why new tests are not required by this spec.)
- **[MUST]** Reflexion ×1, cross-vendor judging for elevated gates, write-only provider keys, budget tripwires, and additive-only SQLite schema changes are untouched (this feature has no interaction with any of them).
- **[MUST]** Asset resolution order (project → user → builtin, with the two documented exceptions) is not affected — no asset files are touched.

### 4.5 Non-functional requirements

- **[MUST]** The comparator's per-compare cost MUST remain O(1) in the number of attempts. It MUST NOT scan the full attempt list on each compare (see §4.1.2).
- **[MUST]** The `selectedStage` effect MUST NOT trigger an infinite render loop under any of the situations enumerated in §4.2.3. The guarded setter call (§4.2.2) is the mechanism that guarantees this; [AC-2.5] is the acceptance criterion.
- **[SHOULD]** Total added JS bytes SHOULD be modest — a small helper function per file, no new dependency. Deviation is acceptable only if strict adherence to §4.1.2 or §4.3.2 requires more (e.g. a tuple type annotation that a linter demands). No third-party import is permitted.

### 4.6 Scope discipline

- **[MUST]** The final diff MUST contain changes only in the two files named in §1.
- **[MUST]** Within those two files, the diff MUST address only the three findings. Unrelated cleanups, style-only edits, import reordering, or renames MUST NOT be included. Exception: if a MUST in §4.1–§4.3 requires a new local helper, its declaration is in scope; nothing else is.
- **[MUST]** No new user-facing text, no new placeholder strings, no new i18n keys.

---

## 5. Out-of-scope observations

The judge pass may have surfaced other findings (styling nits, accessibility polish, missing empty-state copy, etc.). Those are **out of scope for this spec** and MUST be addressed in a separate run. The purpose of this spec is to close exactly the three behavioral findings enumerated above.

---

## 6. Acceptance gate

The implementation is complete when **all** of the following are true:

1. All acceptance criteria in §4.1.3, §4.2.4, and §4.3.4 pass.
2. All preserved invariants in §4.4 hold.
3. `pnpm -r build` is green.
4. `pnpm -r typecheck` is green.
5. `pnpm -r test` is green with `PP_SKIP_CLI_VERSIONS=1` (per AGENTS.md hard rule 5).
6. `git diff --name-only` on the change lists **exactly** two files: `ui/src/features/observability/AttemptMetaGrid.tsx` and `ui/src/features/observability/RunObservatoryPage.tsx`.

Any failure of items 1–6 is a blocker.

---

## 7. Rationale — why no new tests are required by this spec

Two of the three findings (§4.2 stale selection, §4.3 cost fallback) are stateful UI behaviors driven by SSE + TanStack Query. The existing test scaffolding in `ui/` does not yet cover the RunObservatoryPage at the integration level, and adding that scaffolding is out of scope for a three-finding follow-up. The comparator fix (§4.1) is a pure function, and while unit-testing it in isolation is tempting, extracting it into a new module or a new test file would exceed the "two files only" scope constraint in §4.6.

The acceptance gate therefore relies on:

- **Static verification** (via code review of the diff) for [AC-1.6], [AC-2.6], and [AC-3.5], which are structural requirements on the shape of the change.
- **Manual verification** for the behavioral acceptance criteria that describe observable rendering ([AC-1.1]–[AC-1.5], [AC-2.1]–[AC-2.5], [AC-2.7], [AC-3.1]–[AC-3.4], [AC-3.6]).
- **`pnpm -r test`** for the guarantee that no existing test is broken by the change.

If, during implementation, it turns out that a pure helper (e.g. `toSortKey`, `resolveDisplayCost`) can be trivially unit-tested inside the same file's colocated test — and such a colocated test already exists — the implementer MAY add a case to it. They MUST NOT create a new test file, because that would violate §4.6.

---

## 8. Risks & mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Comparator change alters visible ordering for existing runs, surprising an operator | Low | Low | The new ordering is deterministic and matches operator intuition (newest first by timestamp). The old ordering was undefined for mixed-shape attempt lists, so any perceived "change" was already non-reproducible. |
| Effect rewrite for `selectedStage` triggers an infinite render loop in an untested combination of TanStack Query cache states | Medium | High (page becomes unusable) | Guarded setter call ([AC-2.5]); manual verification across route changes and refetches; effect dependencies scoped to `runId` + stage-list identity only. |
| Cost rule change surfaces a mid-flight state where `liveCost === 0` and `costSeries` is non-empty, so display drops from `$0.42` to `$0.00` | Low | Low | This is the correct behavior per §4.3.2 — the live overlay is authoritative once it has produced any tick. It matches the operator expectation that "the run is live now; the meter is what the meter says." The previous `max` behavior hid this. |
| Scope creep during implementation ("while I'm in here…") | Medium | Medium (invalidates the diff-size acceptance gate) | §4.6 makes scope discipline a MUST; item 6 of the acceptance gate mechanically enforces it via `git diff --name-only`. |

---

## 9. Traceability

| Finding | Files | Sections | Acceptance criteria |
|---|---|---|---|
| 1. Non-transitive comparator | `AttemptMetaGrid.tsx` | §4.1 | [AC-1.1]–[AC-1.7] |
| 2. Stale `selectedStage` | `RunObservatoryPage.tsx` | §4.2 | [AC-2.1]–[AC-2.7] |
| 3. Cost `Math.max` mixing | `RunObservatoryPage.tsx` | §4.3 | [AC-3.1]–[AC-3.6] |
| Scope confinement | both files | §4.4, §4.6 | Acceptance gate items 1–6 |