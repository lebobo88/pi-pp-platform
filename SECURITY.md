# Security Policy

## Reporting a vulnerability

Please report suspected vulnerabilities privately via
[GitHub Security Advisories](https://github.com/lebobo88/pi-pp-platform/security/advisories/new)
rather than opening a public issue. You should receive an acknowledgement
within a few days.

## Scope and deployment model

pi-pp-platform is a **local-first control plane**. The daemon (`ppd`) binds to
`127.0.0.1:7878` by default and refuses to bind a non-loopback host unless
`PP_API_TOKEN` is set (all `/api/v1` requests then require
`Authorization: Bearer <token>`; the SSE streams accept the same token via a
`?token=` query parameter because `EventSource` cannot send headers).

Things worth knowing when deploying:

- **Provider API keys are write-only.** Keys sent to
  `PUT /api/v1/providers/:vendor/key` are stored in the platform credential
  store (`~/.pi-pp-platform`) and are never echoed back by any endpoint —
  responses carry only a masked fingerprint.
- **Runs execute code-generation against your project directories.** Treat the
  daemon like you would treat an IDE with a coding agent: only register
  projects you trust, and review generated diffs before shipping them.
- **Budgets and kill switches** (`PP_DISABLE_<PROVIDER>`, budget caps with
  tripwires) bound spend, not security.

See [docs/DEPLOY.md](docs/DEPLOY.md) for the hardened/containerized deployment
path.
