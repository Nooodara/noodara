# Domain certificate status — transition table

Versioned mirror of `.claude/skills/noodara-domain-model/SKILL.md` §5 (`.claude/` is gitignored, so
this file is the committed record). Decision: [ADR 0011](../adr/0011-domains-tls-env-contracts.md)
§A3. Implemented in `packages/domain/src/domain/cert-status.ts`; the 36 ordered pairs are asserted
in `cert-status.test.ts` and the `coverage-state-machine` gate requires 100% on the file.

## States

```text
NONE      row exists, domain not added to the proxy yet
PENDING   added; Traefik serves its default certificate until ACME issues
ISSUED    a valid certificate is served
RENEWING  ISSUED with notAfter within 30 days (Traefik renews in that window)
FAILED    issuance did not finish within NOODARA_CERT_ISSUE_TIMEOUT_MS (10 min)
EXPIRED   the served certificate's notAfter is past
```

## Allowed transitions

| From | To | Trigger |
|---|---|---|
| NONE | PENDING | domain added |
| PENDING | ISSUED | issued certificate |
| PENDING | FAILED | timeout: `CERT_DNS_MISMATCH` (dns ≠ RESOLVES), else `CERT_ISSUANCE_FAILED`; proxy down: `CERT_PROXY_UNAVAILABLE` |
| ISSUED | RENEWING | notAfter within 30 days |
| ISSUED, RENEWING | EXPIRED | notAfter past |
| RENEWING | ISSUED | later notAfter |
| FAILED | PENDING | dns-check RESOLVES or PATCH (`retryCertStatus`); reachable proxy after `CERT_PROXY_UNAVAILABLE` (22-08) |
| FAILED, EXPIRED | ISSUED | valid certificate observed (21-02) |
| ISSUED, RENEWING, EXPIRED | PENDING | default certificate served again (21-02) |

Every other pair throws `InvalidCertStatusTransitionError`. The two rows marked 21-02 complete the
ADR table: the probe is ground truth, so a valid certificate always wins and a lost one is
re-issued instead of shown as ISSUED.

## `decideCertStatus(current, probe, now, timings)`

Pure. `probe` is `issued {notAfter}`, `default` or `down`.

- `down`: status unchanged, cause `CERT_PROXY_UNAVAILABLE`; FAILED only when a PENDING issuance
  timed out. The server's `proxy_status` goes RUNNING -> FAILED only after 3 consecutive down
  probes (`PROXY_DOWN_FAILURE_THRESHOLD` in the reconciler), so one restart does not flip it.
- Any non-`down` probe clears `CERT_PROXY_UNAVAILABLE`; FAILED with that cause goes back to PENDING.
- PENDING: an expired certificate counts as not issued yet; a null `pendingSince` never times out.
- NONE never leaves through a probe. An unparseable notAfter leaves the state untouched.
- `notAfter` exactly at `now` is still valid; the renewal window is inclusive.

## Vocabularies

- Failure causes: `CERT_DNS_MISMATCH`, `CERT_ISSUANCE_FAILED`, `CERT_PROXY_UNAVAILABLE`
  (`CERT_FAILURE_MESSAGES`).
- DNS outcomes: `RESOLVES`, `MISMATCH`, `UNRESOLVED`, `UNAVAILABLE` (`DNS_OUTCOME_MESSAGES`,
  `classifyDnsOutcome`); `dnsInstructions` returns the A/AAAA records and the CNAME alternative.
- Checks after a change: at t = 15 s, 30 s and 60 s after the change (absolute offsets,
  `CERT_POST_CHANGE_CHECK_OFFSETS_MS`), then every `NOODARA_CERT_CHECK_INTERVAL_MS` (`nextCertCheckAt`).
- Limits: `MAX_DOMAINS_PER_SERVICE` = 10 (`DOMAIN_LIMIT_REACHED`); the panel host is reserved
  (`isReservedHostname`, `DOMAIN_RESERVED`).
