# Noodara

> Your infrastructure, understood.

Noodara is an open-source, self-hostable, AI-native PaaS for deploying, operating and
understanding applications and infrastructure on your own servers.

## Status

This is **v0.1 Foundation**: connect a server over SSH, run discovery, and see it in the panel.
Deployments, domains, HTTPS, secrets management, observability and AI features arrive in later
releases (v0.2 through v0.5) — they are not part of this release.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/REPLACE_WITH_GITHUB_OWNER/noodara/main/install.sh | sh
```

See [`docs/install.md`](docs/install.md) for requirements, the download-read-run alternative,
supported variables, upgrade, rollback and troubleshooting.

## Development

```sh
pnpm install
pnpm dev
pnpm test
pnpm test:integration
pnpm test:installer
pnpm lint
pnpm typecheck
pnpm boundaries
pnpm check:posix-sh
```

- `pnpm dev` — runs the control-plane API, worker and web UI together.
- `pnpm test` — unit tests (Vitest).
- `pnpm test:integration` — integration tests against real Postgres, Redis and Docker
  (Testcontainers).
- `pnpm test:installer` — the installer's own Docker-in-Docker test suite.
- `pnpm lint` / `pnpm typecheck` — static checks.
- `pnpm boundaries` — enforces `packages/domain`'s zero-I/O boundary.
- `pnpm check:posix-sh` — the installer's own strict-POSIX-shell static gate.

## Learn more

- [`docs/roadmap-v0.1-v0.5.md`](docs/roadmap-v0.1-v0.5.md) — the roadmap from v0.1 through v0.5.
- [`docs/adr/`](docs/adr/) — architecture decision records.
- [`LICENSE`](LICENSE) — Apache License 2.0.
