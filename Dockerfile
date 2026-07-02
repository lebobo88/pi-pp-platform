# syntax=docker/dockerfile:1

# ── builder: install + compile (incl. native better-sqlite3) + build all packages ──
FROM node:22-slim AS builder
RUN corepack enable \
 && apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm -r build

# ── runtime: slim image with git (the pi coding agent shells to git/worktrees) ──
FROM node:22-slim AS runtime
RUN corepack enable \
 && apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production \
    PP_PORT=7878 \
    PP_HOST=0.0.0.0
# Bring the fully built workspace (dist + ui/dist + node_modules w/ linux native binaries).
COPY --from=builder /app /app
# Non-root user with writable home for the persistent state + auth/catalog dirs.
RUN useradd -m -u 10001 ppuser \
 && mkdir -p /home/ppuser/.pair-programmer /home/ppuser/.pi-pp-platform \
 && chown -R ppuser:ppuser /home/ppuser /app
USER ppuser
EXPOSE 7878
# PP_HOST=0.0.0.0 requires PP_API_TOKEN at runtime (the server refuses otherwise).
HEALTHCHECK --interval=30s --timeout=5s --start-period=25s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PP_PORT||7878)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "scripts/serve.mjs"]
