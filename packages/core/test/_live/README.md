# Live tests (excluded from default `test`)

These require a live sibling daemon and are excluded from the M1 gate to keep
it hermetic.

- `eights-integration.smoke.mjs` — a live integration smoke test against the
  real TheEights daemon over stdio (well-known path
  `C:\AiAppDeployments\TheEights\daemon\dist\index.js`, override with
  `PP_EIGHTS_DAEMON`). It self-skips when the peer dist is absent, but on a
  machine where TheEights is built it runs live wire-contract assertions, which
  would couple this package's test gate to a sibling project's build state.

Run manually with:

    node test/_live/eights-integration.smoke.mjs
