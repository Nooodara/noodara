# Playwright host ports

The E2E harness accepts two **test-only** environment variables:

| Variable | Default when absent |
| --- | --- |
| `NOODARA_E2E_WEB_PORT` | `3000` |
| `NOODARA_E2E_API_PORT` | `3100` |

Values must contain decimal digits only and resolve to distinct integers in `1..65535`.
Empty values, whitespace, signs, fractional/hex/exponent notation, zero and values above
65535 fail before building or starting stack resources. One override is allowed when the
resolved pair remains distinct. There is no automatic port fallback. Host and scheme remain
`http://localhost`; these settings never change deployed application container ports.
Production and dev commands retain their existing configuration.

Run the compatibility smoke suite on another pair:

```sh
NOODARA_E2E_WEB_PORT=33993 NOODARA_E2E_API_PORT=33994 pnpm exec playwright test tests/e2e/canary-ui.spec.ts tests/e2e/settings.spec.ts tests/e2e/theme-first-paint.spec.ts
```

The unchanged security command accepts the same E2E overrides:

```sh
NOODARA_E2E_WEB_PORT=33993 NOODARA_E2E_API_PORT=33994 pnpm security:scan-leaks
```

`NOODARA_TEST_PORT_OVERRIDE` is an independent integration-harness override. It neither
selects nor overrides either Playwright host port; setting the E2E variables does not change
the integration half of `security:scan-leaks`.

The stack probes only its selected host ports before the build and container creation. If
one is occupied, it fails with a port-only diagnostic and leaves the listener alone. The
probe does not reserve a port: another process can bind between check and startup. In that
case startup must fail within the existing 60-second readiness budget for that process,
without falling back or accepting an unrelated HTTP response as readiness. Readiness comes
from the owned process's stdout. Failure cleanup stops only owned process groups and
containers; an injected foreign listener survives. Normal teardown checks the selected pair,
is idempotent, and checks this run's container IDs. No listener is killed by port number.

The selected API origin must be present at **build time and runtime**: Next's same-origin
`/api/*` and webhook rewrites are baked into the build. The stack sets `NOODARA_API_ORIGIN`
before `buildWorkspace`; Turbo already hashes this variable, so changing the selected API
cannot reuse a rewrite for the default API. It supplies the same origin to the API, worker
and web process, sets `NOODARA_PUBLIC_URL` to the selected web origin, and passes the web port
explicitly to `next start` as well as `PORT`. Requests, cookies, setup-token URLs and real
Origin-guard checks retain the shared localhost web origin. No authentication or Origin
checks are disabled.

Resolver regressions preserve default and partial-override behavior. Lifecycle regressions
use real owned Node listeners to cover occupied ports, startup failure, both API/web
check/bind races and cleanup. Real default-port smoke runs require an isolated environment
where both defaults are free; never stop somebody else's listener to make room.
