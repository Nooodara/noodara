---
status: partial
phase: 10-sitio-de-docs-y-landing-p-blica
source: [10-VERIFICATION.md]
started: 2026-09-28T15:45:41Z
updated: 2026-09-30T01:10:20Z
---

## Current Test

[1 pending: www → apex redirect]

## Tests

### 1. Real Cloudflare Pages deploy of noodara-site
expected: the `noodara-site` Pages project exists (Direct Upload), `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` are set as GitHub repo secrets, and a green `public-site.yml` run on a push to main serves the same site at the project's `*.pages.dev` URL as the local `apps/site/out` build.
result: pass — `Publish site` run 36491137838 green (`npx wrangler@4.143.0 pages deploy`, 152 files uploaded); https://noodara-site.pages.dev and /docs return 200 with the `_headers` security headers (HSTS, nosniff, X-Frame-Options DENY, Referrer-Policy). Verified by the orchestrator with curl, 2026-09-28.

### 2. Nameserver cutover and custom domain for noodara.com
expected: `noodara.com`'s nameservers at Namecheap point to Cloudflare's two assigned nameservers, and `noodara.com` and `www.noodara.com` are added as custom domains on the `noodara-site` Pages project with TLS active.
result: pass — NS = coco/uriah.ns.cloudflare.com (whois); https://noodara.com, /docs and /docs/getting-started/install return 200, an unknown path returns the site 404, http:// returns 301 to https://, Let's Encrypt cert CN=noodara.com; https://www.noodara.com returns 200. Namecheap parking A record (162.255.119.15) had to be removed and the apex re-added as a Pages custom domain (error 1016 until then). Verified with curl, 2026-09-28.

### 3. www redirects to the apex
expected: https://www.noodara.com answers 301 to https://noodara.com/ (Cloudflare Redirect Rule "Redirect from WWW to root"), since the site's canonical URL and metadataBase are https://noodara.com.
result: [pending]

## Summary

total: 3
passed: 2
issues: 0
pending: 1
skipped: 0
blocked: 0

## Gaps
