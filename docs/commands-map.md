# /pp:* command → platform surface map (CMD1)

pair-programmer exposed its lifecycle as 19 Claude-Code `/pp:*` slash commands.
The pi platform replaces the Claude-Code host, so each command maps onto one of
three in-platform surfaces:

- **ppp CLI** — `packages/pilot/bin/ppp.ts` (`ppp run …`), the headless driver.
- **REST/SSE** — `@pp/server` endpoints (M5); run-control + reads.
- **UI** — `@pp/ui` control surfaces (M6); wizard, controls, review screens.
- **pilot API** — `RunPilot` / exported functions consumed by the above.

| /pp command | Purpose | Platform equivalent |
|---|---|---|
| `/pp:run` | Full single-mode lifecycle | `ppp run <path> "<req>"` · `RunPilot({mode:"single"})` · UI run wizard |
| `/pp:team <name>` | Team pipeline | `ppp run … --mode team --team <name>` · `RunPilot({mode:"team",team})` |
| `/pp:review <forum>` | Governance forum | `ppp run … --mode review` · `RunPilot({mode:"review",forum})` |
| `/pp:best-of <N>` | N-candidate race | `ppp run … --mode best_of --n N` · `RunPilot({mode:"best_of",n})` |
| `/pp:retry` | Reflexion retry of a surfaced stage | pilot `retryWithCritique` seam (`checkRetryEligible`) · UI run controls |
| `/pp:gate` | Re-run judge only | pilot `JudgePolicy` + `recordVerdict` · UI stage detail |
| `/pp:replay <run>` | Reconstruct a run | core `buildReplayBundle` · REST `/runs/:id/replay` · UI replay view |
| `/pp:status` | List/inspect runs | core `listRuns`/`getRun` · REST `/runs` · UI runs list |
| `/pp:budget` | Budget totals | core `budgetStatus` · REST `/budget` · UI budget caps |
| `/pp:doctor` | Harness health | core/engine `doctor`/`doctorProbe` · REST `/doctor` |
| `/pp:profile` | Show/render profile | core `loadProjectProfile`/`getBuiltinProfile` · UI profile editor |
| `/pp:teams` | List teams | core `listTeams` · REST `/teams` · UI |
| `/pp:taxonomy` | Taxonomy mapping | core `heuristicMapping`/`TAXONOMY_SECTIONS` · UI |
| `/pp:rubrics` | List/show rubrics | core `listRubrics`/`getRubric` · REST `/rubrics` |
| `/pp:master` | PROJECT_MASTER.md | core `ensureMasterPlan`/`masterPlanStatus` |
| `/pp:checklist` | Completion checklist | core `COMPLETION_CHECKLIST` |
| `/pp:claudemd` | AGENTS.md/CLAUDE.md | core `ensureAgentsAndClaudeMd`/`agentsMdStatus` |
| `/pp:constitution` | CONSTITUTION.md | core `constitutionSha`/constitution helpers |
| `/pp:evolution` | Autogenesis proposals | core `analyzeAndPropose`/`listProposals` · UI evolution review |

The user-explicit invariant (a run flow only starts on an explicit command,
never from ambient chat) is preserved: the ppp CLI and the UI wizard are both
explicit entry points, and `RunPilot.execute()` is never invoked implicitly.
