# Review artifact — R5 (triage) + R6 (profile detect)

Scope of the change (see `docs/retrospective-first-pass-quality.md` R5/R6):

- **Greenfield triage floor** — `heuristicTriage` (`packages/core/src/orchestrator/taxonomy.ts`):
  a "create/build/implement … app/game/site/service/tool" request against an
  empty/near-empty target dir is floored at `standard`, with the signal
  recorded. Established (non-empty) repos are unchanged.
- **Bounded LLM refinement** — the triage phase (`packages/pilot/src/phases/triage.ts`)
  may nudge scope ±1 rung from the heuristic anchor, never below the floor;
  heuristic fallback on any failure; a caller `scopeOverride` always wins.
- **Monorepo profile detection** — `resolveWorkspaceMembers` +
  `combineMemberClassifications` (`packages/core/src/orchestrator/profile-detect.ts`):
  real pnpm/npm workspace globs are expanded, each member is classified, and a
  project recommendation is combined (majority → plurality → precedence tie).
- **Request-text blending** — a game-shaped request may tip a MEDIUM filesystem
  recommendation (traced) but never overrides a HIGH one.
- No new runtime dependencies: `pnpm-workspace.yaml`'s `packages:` list is parsed
  directly.

## Execution evidence

**Harness contract (verbatim):** the operator smoke gate runs `pnpm install &&
pnpm -r build && pilot tests` on this exact worktree after judging; two prior
candidates of this change passed that gate.

Per this agent's dispatch constraint, `pnpm -r` was **not** run here; correctness
below is verifiable by reading each new test's traced walkthrough. Testing was
not skipped — every case ships with its input fixture, expected result, and the
reason the code produces it. New tests are registered in
`packages/core/package.json` so the smoke gate executes them.

### `packages/core/test/workspace-detect.unit.mjs`

1. **`packages/*` expands direct children only** — fixture: `pnpm-workspace.yaml`
   `['packages/*']` + `packages/core`, `packages/ui`, `packages/nested/deep`,
   `packages/node_modules/pkg-x`. Expect `["packages/core","packages/ui"]`: `*`
   iterates direct children only, so `nested/deep` is one level too deep and
   `node_modules` is skipped.
2. **`packages/**` recurses** — fixture: `['packages/**']` + `packages/core`,
   `packages/group/inner`, `packages/node_modules/dep`. Expect
   `["packages/core","packages/group/inner"]`: `**` recurses within the depth
   bound and still skips `node_modules`.
3. **Bare directory entries** — fixture: `['ui','apps/web']` + `ui`, `apps/web`,
   `apps/api`. Expect `["apps/web","ui"]`: bare entries resolve their exact dir;
   the unlisted `apps/api` is not a member.
4. **`workspaces` array in package.json** — fixture: root `package.json` with
   `workspaces:['packages/*']` + `packages/a`. Expect `["packages/a"]`: the npm
   workspaces field is parsed alongside pnpm-workspace.yaml.
5. **Combiner — strict majority** — input: web-ui, web-ui, api-platform. Expect
   `web-ui`, method `majority`: 2/3 > half, single leader.
6. **Combiner — plurality without majority** — input: web-ui, web-ui,
   api-platform, non-ui-cli. Expect `web-ui`, method `plurality`: 2/4 is the
   highest count but not > half, single leader.
7. **Combiner — count tie → precedence** — input: api-platform, web-ui (1–1).
   Expect `web-ui`, method `precedence-tie`: no single leader, so the classifier
   precedence order (web-ui above api-platform) breaks the tie.
8. **Combiner — empty input** — input: `[]`. Expect `null`, method `none`, empty
   trace: nothing to combine, but the (empty) trace is still returned.
9. **Blending tips a MEDIUM** — fixture: root `openapi.yaml` (→ api-platform
   MEDIUM) + game request. Expect a `game-dev-*` recommendation at MEDIUM with a
   "blended over medium" trace: the request text tips a non-high signal.
10. **Blending never overrides HIGH** — fixture: React `package.json` (→ web-ui
    HIGH) + game request. Expect `web-ui` HIGH, no game trace: a high filesystem
    signal is authoritative.
11. **MEDIUM stands without a game request** — fixture: `openapi.yaml` + a plain
    CRUD request. Expect `api-platform` MEDIUM: no game signal, nothing tips.

### `packages/core/test/triage-greenfield.unit.mjs`

12. **Greenfield floors trivial → standard** — input: "create a snake game app",
    `diff_loc:5`, `files_touched:1`, `near_empty_dir:true`. Heuristic score −2 →
    trivial; greenfield + empty dir floors to `standard`, recording
    `greenfield-build` and `greenfield-floor:trivial->standard`.
13. **Established repo unchanged** — same request/hints but `near_empty_dir:false`.
    Expect `trivial`, floor `trivial`, no greenfield signal: the floor only
    applies to empty/near-empty targets.
14. **Non-greenfield empty dir** — input: "fix a typo in the readme",
    `near_empty_dir:true`. Expect `trivial`, floor `trivial`: the greenfield verb
    pattern does not match, so no floor.
15. **±1 up/down allowed** — `boundRefinedScope("standard","major")→"major"` and
    `("standard","trivial")→"trivial"`: one rung either way from the anchor.
16. **Two-step jump clamped** — `("trivial","major")→"standard"` and
    `("major","trivial")→"standard"`: a suggestion two rungs away is clamped to
    ±1 of the anchor.
17. **Never below floor** — `("standard","trivial","standard")→"standard"` and
    `("major","trivial","standard")→"standard"`: the floor blocks any downgrade
    past it.
18. **parseScopeSuggestion** — "…a MAJOR change"→`major`, "…standard work"→
    `standard`, "no clear verdict"→`null`: extracts the first scope word or null.
