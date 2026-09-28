---
status: partial
phase: 10-sitio-de-docs-y-landing-p-blica
source: [10-VERIFICATION.md]
started: 2026-09-28T15:45:41Z
updated: 2026-09-28T15:45:41Z
---

## Current Test

[awaiting human testing]

## Tests

### 1. Real Cloudflare Pages deploy of noodara-site
expected: the `noodara-site` Pages project exists (Direct Upload), `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` are set as GitHub repo secrets, and a green `public-site.yml` run on a push to main serves the same site at the project's `*.pages.dev` URL as the local `apps/site/out` build.
result: [pending]

### 2. Nameserver cutover and custom domain for noodara.com
expected: `noodara.com`'s nameservers at Namecheap point to Cloudflare's two assigned nameservers, `noodara.com` and `www.noodara.com` are added as custom domains on the `noodara-site` Pages project with TLS active, and `www` redirects to the apex.
result: [pending]

## Summary

total: 2
passed: 0
issues: 0
pending: 2
skipped: 0
blocked: 0

## Gaps
