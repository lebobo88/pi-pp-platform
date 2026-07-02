# Deploying pi-pp-platform

Three ways to run it, from a laptop to a networked container. All serve the same
Fastify control-plane (`ppd`) + built React UI over `@pp/pilot`/`@pp/engine`
(the pi runtime) on SQLite.

| Command | Engine | Bind | Auth | DB | Use |
|---|---|---|---|---|---|
| `pnpm dev` | fake | 127.0.0.1:5273 (Vite) + :7878 | none | temp | UI dev w/ HMR |
| `pnpm demo` | fake | 127.0.0.1:7878 | none | temp | click-through demo, no tokens |
| `pnpm start` | **pi** | 127.0.0.1:7878 | none | persistent | local real use |
| `pnpm serve` | **pi** | `$PP_HOST` | token if networked | persistent | production |
| `docker compose up` | **pi** | 0.0.0.0:7878 | **token required** | volume | container/VM/cloud |

## Prerequisites

- **Node ≥ 22.19.0** and **pnpm 9** (`corepack enable`).
- **git** on `PATH` (the pi coding agent shells to git + worktrees). On Windows,
  Git Bash. The container image installs git for you.
- At least one **provider API key** to do real generation/judging (set in the
  Providers UI or via env — see the key table below). Zero keys ⇒ only the fake
  engine (`dev`/`demo`) is useful.

## 1. Local (single machine)

```bash
pnpm install
pnpm serve            # builds ui + server, boots the real pi engine on 127.0.0.1:7878
```

Persistent state lives at `~/.pair-programmer/state.db`; stored provider keys +
catalog at `~/.pi-pp-platform/`. Open http://127.0.0.1:7878 and set keys on the
**Providers** page.

## 2. Networked (expose beyond loopback)

Binding a non-loopback host **requires** `PP_API_TOKEN` — the server refuses to
start otherwise, and every `/api` request must send `Authorization: Bearer <token>`.

```bash
PP_HOST=0.0.0.0 PP_PORT=7878 PP_API_TOKEN="$(openssl rand -hex 24)" pnpm serve
```

Front it with a TLS-terminating reverse proxy (nginx/Caddy). Example Caddy:

```
your.domain {
  reverse_proxy 127.0.0.1:7878
}
```

Notes: SSE (run event streams) needs proxy buffering **off** for `/api/v1/**/events`
(nginx: `proxy_buffering off;`). The token is a single shared secret — put the
proxy in front and restrict source IPs if you need per-user auth.

## 3. Container (Docker / compose)

```bash
cp .env.example .env         # set PP_API_TOKEN (required) + any provider keys
docker compose up --build
```

- `PP_HOST=0.0.0.0` in the image ⇒ `PP_API_TOKEN` is mandatory (compose fails fast if unset).
- Named volumes persist runs (`~/.pair-programmer`) and keys/catalog
  (`~/.pi-pp-platform`) across `docker compose restart`.
- `HEALTHCHECK` polls `/healthz`; `SIGTERM` drains and closes cleanly.
- The image installs **git** (required at runtime).

## Environment reference

| Env | Default | Purpose |
|---|---|---|
| `PP_HOST` | `127.0.0.1` | Bind host. Non-loopback ⇒ `PP_API_TOKEN` required. |
| `PP_PORT` | `7878` | Bind port. |
| `PP_API_TOKEN` | — | Bearer token gate. Required for non-loopback. |
| `PP_UI_DIST` | `ui/dist` | Static UI dir; unset ⇒ API only. |
| `PP_DB_PATH` | `~/.pair-programmer/state.db` | SQLite path. |
| `PP_PLATFORM_DIR` | `~/.pi-pp-platform` | Stored keys (`auth.json`) + `catalog.json`. |
| `PP_LLM` | `pi` | `fake` for the deterministic engine (demo/dev). |
| `PP_ECOSYSTEM` | off | `1` enables best-effort Hydra/TheEights writes. |
| `PP_MAX_CONCURRENT_RUNS` | `2` | Run queue width. |
| `PP_DISABLE_<PROVIDER>` | — | Per-provider kill switch (e.g. `PP_DISABLE_OPENAI`). |

Provider keys pi reads from env (or set them in the Providers UI, which persists
them): `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GEMINI_API_KEY`, `DEEPSEEK_API_KEY`,
`XAI_API_KEY`, `MISTRAL_API_KEY`, `GROQ_API_KEY`, `OPENROUTER_API_KEY`, plus the
other pi providers (see the Providers → “Add a provider” list, 35 in total).

## Verify a deployment

```bash
curl -s http://127.0.0.1:7878/healthz                 # {"ok":true,...}
curl -s http://127.0.0.1:7878/api/v1/providers         # your configured providers
pnpm validate:live                                     # REAL gen + judge (needs keys) — see docs/VALIDATION.md
```
