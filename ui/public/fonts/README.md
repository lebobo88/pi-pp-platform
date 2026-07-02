# Self-hosted fonts

The instrument-panel design language calls for **Inter** (UI) and **JetBrains
Mono** (mono / all data values). This build ships with **system-stack
fallbacks** only — no font binaries and no network font fetch — because the
build environment is offline.

To self-host:

1. Drop the woff2 files here:
   - `Inter-Variable.woff2`
   - `JetBrainsMono-Variable.woff2`
2. Uncomment the two `@font-face` blocks in `ui/src/styles/global.css`.

Until then the app renders with the system stacks defined in
`ui/src/styles/tokens.css` (`--font-ui`, `--font-mono`).
