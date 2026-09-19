---
created: 2026-09-19
title: Harden setup token handling in the URL
area: security
source: phase 05 execution, orchestrator review of plan 05-11
files:
  - apps/web/src/app/setup/page.tsx
  - apps/web/next.config.ts
---

## Problem

`/setup?token=...` pre-fills the one-time setup token from the query string. This is by design
(05-UI-SPEC.md §2.1, INST-04: the installer prints a URL plus a single-use token), so the
pattern itself stays. What is missing is defence in depth:

- The token remains in the address bar and browser history after the page has read it.
- No `Referrer-Policy` is set for the web app, so a navigation away from `/setup` could carry
  the full URL in a `Referer` header.
- Not yet checked: whether `next start` access logs or `proxy.ts` ever log the request URL.

The token is single-use and dies on successful setup, so the exposure window is
install → first admin creation. Still in scope of CLAUDE.md §2.3 (secrets never in logs).

## Solution

Test-first (RED → GREEN), small:

1. After reading `token` into state, strip it from the URL (`router.replace('/setup')` or
   `history.replaceState`) — E2E: load `/setup?token=x`, assert the field is pre-filled and
   `page.url()` no longer contains `token=`.
2. Send `Referrer-Policy: no-referrer` (or `same-origin`) from `next.config.ts` `headers()` —
   E2E/integration: assert the response header on `/setup`.
3. Confirm no web-side log line includes the query string; extend the secrets canary if any does.
