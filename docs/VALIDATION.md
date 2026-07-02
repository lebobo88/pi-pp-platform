# Validation: what's proven, and how

An honest map of what the test suites actually verify versus what only a live
run against real providers can prove.

## What the default suites prove (no keys)

`pnpm test` runs ~200 tests across core/engine/server/ui/pilot/mcp-adapter. They
exercise the **real** HTTP/SSE/SQLite/pilot-lifecycle/git-worktree plumbing —
but every generation/critique runs against the **deterministic fake engine**
(`PP_LLM=fake`, `packages/engine/src/fake.ts`). So a green suite proves the
wiring works **with a fake brain**. It does NOT prove that a real model produces
correct output, that prompts elicit useful results, or that cost/token
accounting matches reality.

## What only a live run proves (needs ≥1 key)

- **`pnpm validate:live`** — the real end-to-end check. Does a REAL generation
  with one provider/model and a REAL cross-provider critique with another, then
  asserts on the actual output: non-empty text, `tokens_out > 0`, a parseable
  verdict with an `outcome`. Non-zero exit on any failure.

  Defaults to `deepseek/deepseek-v4-flash` → `openai/gpt-5.4`. Override:
  ```bash
  PP_VALIDATE_GEN_PROVIDER=anthropic PP_VALIDATE_GEN_MODEL=claude-opus-4-8 \
  PP_VALIDATE_JUDGE_PROVIDER=openai  PP_VALIDATE_JUDGE_MODEL=gpt-5.4 \
  pnpm validate:live
  ```
  Requires a key for both providers (Providers UI or env). Generator and judge
  must be different providers (the cross-provider JUDGE-1 invariant).

  Reference run: `deepseek-v4-flash` generated a correct `add()` (59→34 tok,
  $0.000018); `gpt-5.4` judged it `outcome="pass"` (487→120 tok, $0.003018).

- **`pnpm -F @pp/engine test:live`** — a lighter opt-in smoke (`PP_LIVE=1`): a
  1-token reachability probe + one trivial critique per provider whose key is
  present. Good for "is my key wired", not a full run.

- **Browser validation (real drive)** — on `web-ui`/`mobile` profiles, opt in
  with `PP_BROWSER_VALIDATION=1` and the stage drives the routes in real headless
  chromium (`packages/pilot/src/phases/browser-*.ts`): it resolves a base URL
  (`PP_BROWSER_BASE_URL`, else it boots the project's `runtime_smoke_test.dev_cmd`),
  navigates each route, and records console/page/network errors into findings;
  the stage **surfaces** on any error. Requires the chromium binary
  (`pnpm -F @pp/pilot exec playwright install chromium`). Without opt-in or the
  binary it **degrades open** (records an evidence gap, never blocks). The
  finding→severity wiring is unit-tested with an injectable driver (no chromium
  needed); the real drive is verified to capture console errors + non-2xx
  responses.

## Known gaps (tracked, not yet automated)

- **No CI on real keys / real browser**: `validate:live`/`test:live` and the
  `PP_BROWSER_VALIDATION=1` drive are manual (the browser drive needs a chromium
  binary in CI). Run them before shipping a change that touches the
  generation/critique/pricing or web-ui runtime paths.

## TL;DR

`pnpm test` green ⇒ the plumbing is sound. `pnpm validate:live` exit 0 ⇒ the
product actually generates and judges correctly against real providers.
