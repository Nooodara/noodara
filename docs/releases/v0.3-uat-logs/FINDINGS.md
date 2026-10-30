# v0.3.0-rc.1 UAT findings (20-05)

Host: Lima VM `noodara-uat` (Ubuntu 24.04.5, arm64, 4 vCPU, 4 GiB), 2026-10-30 UTC. None of these blocks A1/H1; product code was not changed.

## F1 — Healthcheck log lines are joined without a separator (low, cosmetic)

The `healthcheck` and `rollback` log phases show consecutive system lines glued together, e.g.
`Healthcheck attempt 1: HTTP 200Healthcheck passed.` and
`Rolling back: restoring the previous version.noodara-<serviceId>`.

Repro: service with an HTTP healthcheck (`/health`, 200), deploy, then
`GET /api/deployments/<id>/logs?phase=healthcheck` -> one item with text
`"Healthcheck attempt 1: HTTP 200Healthcheck passed.\n"`. Same for a rolled-back attempt
(`u10-bad-push-auto-rollback.txt`). Likely cause: `log()` in `apps/control-plane/src/deploy/run-deployment.ts`
writes `system` lines without a trailing newline and the sink concatenates them with command output.
Effect: the build log panel shows run-on lines; nothing else.

## F2 — After the documented downgrade to v0.2.0, history of services with v0.3-only values returns 500 (medium, read degradation, no data loss)

Repro: on v0.3.0-rc.1 create a webhook deploy, a `ROLLED_BACK` attempt and a manual rollback; run the
installer with `NOODARA_VERSION=0.2.0`; then as admin:
`GET /api/services/<svc>/deployments` -> 500 `INTERNAL_ERROR` (api log: `response failed schema validation`);
`GET /api/services/<svc>/deployments/<id>` -> 500 for any row with trigger `webhook`/`rollback` or status `ROLLED_BACK`;
`GET /api/deployments/<id>/logs?phase=healthcheck` -> 400. Services without v0.3 rows (`node-api`) read fine,
both containers keep serving, counts are identical, and re-upgrading restores every read (`u13`, `u14`).
Cause: v0.2.0 response schemas do not know the 0011-0013 enum values. The checklist anticipated this.
Gap: `docs/releases/v0.3.0.md` § Rollback only says migrations are not reverted; it does not warn that v0.2
cannot show the history of services deployed by v0.3. Suggested: one line in the release notes / rollback doc.

## F3 — Rollback command in the release notes omits `sudo` (low, docs)

`docs/releases/v0.3.0.md` (lines 22 and 34) pipes the installer into `sh` without `sudo`; the installer exits with
`not-root` ("This installer must be run as root. Re-run it with sudo."). The UAT used `sudo NOODARA_VERSION=... sh`.

## Observation (not a bug) — default container check writes no `healthcheck` log lines

U6 expected a `healthcheck` log phase on the redeploy of a v0.2 service. By design (`resolveHealthcheck(null)`
keeps the v0.2 post-start polls), a NULL healthcheck passes through HEALTHCHECK (step `verify`, 3.5 s, success)
without writing to that phase. Only configured checks log attempts (U7, U10).
