---
created: 2026-09-19
title: Make the web SSE route handler abort-safe and bounded
area: reliability
source: phase 05 execution, orchestrator review of plan 05-12
files:
  - apps/web/src/app/api/events/route.ts
  - tests/e2e/shell.spec.ts
---

## Problem

`apps/web/src/app/api/events/route.ts` (added in 05-12 because `next.config.ts` `rewrites()`
buffers SSE) streams `/api/events` from the control plane. It forwards only the `cookie`
header and sets its own response headers, which is good. Two gaps against CLAUDE.md §2.3
("timeouts explícitos en toda operación remota") and the DoD ("ningún fallo de
infraestructura tumba la API"):

1. The upstream `fetch` is not tied to `request.signal`. Upstream teardown on browser
   disconnect relies on body-stream cancellation propagating implicitly. No test proves the
   control-plane connection is actually released, so a leak of long-lived upstream
   connections (one per closed tab / reconnect) is possible.
2. No bound on connect/response-headers time, and a rejected `fetch` (API down, DNS, refused)
   is unhandled: the browser gets Next's generic 500 instead of a controlled 502/503 the
   client backoff can reason about.

## Solution

Test-first (RED → GREEN):

1. Pass an `AbortController` signal that aborts on `request.signal` abort; add a headers
   timeout that is cleared once the upstream responds (the stream itself stays unbounded).
2. Catch upstream failure → `503` with a fixed body, no error details.
3. Regression test: open the stream, close the page/context, assert the control plane's
   subscriber count (or open upstream sockets) returns to baseline within a bound.
