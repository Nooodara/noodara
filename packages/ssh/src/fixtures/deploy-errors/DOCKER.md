# Deploy docker error fixtures

Real Docker failure output from the deploy-engine fixture (11-03) for
`classifyDockerError` (11-11). Do not hand-edit: re-capture instead.

- **Capture:** `NOODARA_CAPTURE_FIXTURES=1 NOODARA_TEST_UBUNTU=<22.04|24.04> pnpm exec vitest run --config vitest.integration.config.ts tests/integration/deploy-engine/fixtures.test.ts`
- **Captured:** 2026-09-30, macOS arm64, Docker Desktop.
- **Context:** as `deployer` over SSH, fresh `/opt/noodara-deploy/<uuid>` workspace,
  registry commands use `docker --config <ws>/secrets/docker`. Passwords go on stdin only.
- **Format:** first line `# exit=<code>`, then stderr. Workspace root, UUIDs, 64-hex IDs
  and the registry username are scrubbed (`<ws-root>`, `<uuid>`, `<id>`, `<registry-user>`).

| Ubuntu | Docker server | buildx |
|---|---|---|
| 22.04 | 29.8.1 | v0.37.1 |
| 24.04 | 29.8.1 | v0.37.1 |

| File | Command | Exit | Marker regex (asserted live) |
|---|---|---|---|
| `docker-registry-unauthorized.txt` | `docker pull <registry>/fixtures/nginx:<tag>` without login | 1 | `/authorization failed: no basic auth credentials/` |
| `docker-login-failed.txt` | `docker login --username <u> --password-stdin <registry>`, wrong password | 1 | `/login attempt to \S+ failed with status: 401 Unauthorized/` |
| `docker-image-not-found.txt` | `docker pull <registry>/fixtures/does-not-exist:1` after login | 1 | `/manifest unknown\|not found/` |
| `docker-build-failed.txt` | `docker build --progress=plain` of `fixtures/failing-build` | 1 | `/did not complete successfully: exit code: \d+/` |
| `docker-dockerfile-not-found.txt` | `docker build --file <repo>/Missing.Dockerfile <repo>` | 1 | `/failed to read dockerfile: open \S+: no such file or directory/` |
| `docker-port-in-use.txt` | second `docker run -d -p 13100:3000` on an allocated port | 125 | `/Bind for \S+ failed: port is already allocated/` |

Notes:

- Every failure exits 1 except the port clash (125, `docker run` daemon error). The
  classifier must key on stderr.
- The build's own exit (`exit code: 42` for failing-build) is only in stderr; the CLI exits 1.
- Registry errors come from the daemon (`Error response from daemon:`), so their wording
  follows the Docker server version, not the Ubuntu release.
- Output matches between 22.04 and 24.04 apart from BuildKit timings in the build log.
