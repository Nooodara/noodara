# Deploy git error fixtures

Real `git clone` failure output from the deploy-engine fixture (11-03) for
`classifyGitError` (11-11). Do not hand-edit: re-capture instead.

- **Capture:** `NOODARA_CAPTURE_FIXTURES=1 NOODARA_TEST_UBUNTU=<22.04|24.04> pnpm exec vitest run --config vitest.integration.config.ts tests/integration/deploy-engine/contracts-g1-g2.test.ts -t "git clone failure"`
- **Captured:** 2026-09-29, macOS arm64, Docker Desktop.
- **Command** (as `deployer`, cwd = fresh `/opt/noodara-deploy/<uuid>`, key written over stdin):
  `GIT_SSH_COMMAND="ssh -i <ws>/secrets/deploy_key -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile=<ws>/secrets/known_hosts" git clone --depth 1 --branch <branch> -- <url> repo`
- **Host key mismatch** (14-06): `git-host-key-mismatch.txt` is captured by
  `tests/integration/deploy-engine/deploy-templates.test.ts` (`-t "GIT_HOST_KEY_MISMATCH"`, same
  `NOODARA_CAPTURE_FIXTURES=1`), cloning with known_hosts pinned to a key the host does not hold.
- **Format:** first line `# exit=<code>`, then stderr verbatim.

| Ubuntu | OpenSSH | git | Docker server |
|---|---|---|---|
| 22.04 | OpenSSH_8.9p1 Ubuntu-3ubuntu0.17 | 2.34.1 | 29.8.1 |
| 24.04 | OpenSSH_9.6p1 Ubuntu-3ubuntu13.19 | 2.43.0 | 29.8.1 |

| File | Trigger | Exit | Marker regex (asserted live) |
|---|---|---|---|
| `git-auth-failed.txt` | key not in the git host's authorized_keys | 128 | `/Permission denied \(publickey[,)]/` |
| `git-repository-not-found.txt` | `/srv/git/does-not-exist.git` | 128 | `/does not appear to be a git repository/` |
| `git-branch-not-found.txt` | `--branch does-not-exist` | 128 | `/Remote branch does-not-exist not found in upstream origin/` |
| `git-host-unreachable.txt` | host `nohost.noodara-test.internal` | 128 | `/Could not resolve hostname nohost\.noodara-test\.internal/` |
| `git-host-key-mismatch.txt` | known_hosts pinned to another ed25519 key | 128 | `/Host key verification failed\./` |

Notes:

- Output is byte-identical between 22.04 and 24.04. Every case exits 128, so the
  classifier must key on stderr, not the exit code.
- The fixture sshd also offers password auth, so the method list reads
  `(publickey,password,keyboard-interactive)`; hosts like GitHub print `(publickey)`.
  The marker accepts both.
- `Warning: Permanently added ...` in the 2026-09-29 captures comes from the
  trust-on-first-use mode used before 14-06. It is not an error. Since 14-06 the
  clone pins the host key (`StrictHostKeyChecking=yes`), so new captures omit it.
