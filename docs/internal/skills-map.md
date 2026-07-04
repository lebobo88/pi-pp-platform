# pair-programmer skills → pilot policy map (SK1)

> **Internal notes** — maintainer/migration reference, not user documentation.

pair-programmer encoded 8 harness skills as Claude-Code skill markdown that the
driver read at session start. In the pi platform there is no skill-loading host;
each skill's behavior is folded into pilot code (policies/guards) and/or injected
into role prompts by the prompt loader. This table records where each skill's
behavior now lives.

| pp skill | Behavior | Pilot home |
|---|---|---|
| `pair-programmer.md` | Master driver protocol (9 phases, Reflexion ×1, judge-halt, never-fabricate) | `packages/pilot/src/run-pilot.ts` + `src/phases/*` (the RunPilot state machine) |
| `judge-policy.md` | Cross/same-vendor selection, rotation, escalation, kill switches | `packages/pilot/src/judge-policy.ts` (`JudgePolicy`) over core `evaluateGate` |
| `rubric-application.md` | Rubric selection + pass/fail/revise thresholds | `src/phases/stage-loop.ts` judge step + core `getRubric`/`validateCritiqueResult` |
| `master-plan-patching.md` | Taxonomy-section → master-plan-section mapping | `src/phases/master-plan.ts` (`TAXONOMY_TO_MASTER`) |
| `artifact-conventions.md` | Stage kinds, artifact kinds, gate types, paths | `src/phases/stage-loop.ts` (`SECTION_BY_KIND`, `ARTIFACT_KIND_BY_KIND`) + `run-pilot.ts` stage plans |
| `profile-aware-gating.md` | Profile-driven tier/rubric/cross-vendor upgrades | `src/tier-resolver.ts` (profile `model_tier_policy`) + core `evaluateGate` profile logic |
| `taxonomy-adherence.md` | Required-section coverage + missability gating | `src/phases/taxonomy.ts` + `src/phases/missability.ts` |
| `game-design.md` | Game-profile gotchas + prompt addenda injection | `src/prompts/loader.ts` (`loadGotchasForProfile`, `loadPromptAddendum`) |

The load-bearing invariants those skills asserted (Reflexion ×1, judge-tool-
failure halting, never-fabricate-verdicts, loop ceiling, summary format) are
enforced in code and pinned by `packages/pilot/test/e2e-fixtures.test.ts`,
`e2e-single.test.ts`, and `hooks-parity.test.ts` (H28/H29).
