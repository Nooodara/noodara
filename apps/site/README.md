# @noodara/site

The public landing page and docs at [noodara.com](https://noodara.com), built with Next.js 16
(static export) and Fumadocs.

## Develop

```bash
pnpm site:dev    # http://localhost:3200
pnpm site:build  # writes apps/site/out
```

## Domain and base path

`basePath` is always the empty string (root) -- Cloudflare Pages serves this static export at the
root on both `*.pages.dev` and any custom domain, so there is no preview-subpath case to gate on.
See `site-config.mjs`/`next.config.mjs`.

## Publishing

`.github/workflows/public-site.yml` deploys the static export to Cloudflare Pages (project
`noodara-site`, Direct Upload) on every push to `main`.

One-time setup (human, not automatable from this repo):

1. In the Cloudflare dashboard, create the Pages project `noodara-site` (Direct Upload, no git
   integration).
2. Create a scoped API token: Account -> Cloudflare Pages -> Edit only (never Account -> All,
   never a Global API Key). Note the account ID.
3. Add both as GitHub repo secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## DNS

`noodara.com` is registered at Namecheap; registration stays there, DNS management moves to
Cloudflare:

1. At Namecheap, switch `noodara.com`'s nameservers to the two Cloudflare-assigned nameservers
   (Custom DNS). This is the nameserver cutover -- Cloudflare becomes authoritative for the zone.
2. Once the zone is active in Cloudflare, add `noodara.com` and `www.noodara.com` as custom
   domains on the `noodara-site` Pages project. Cloudflare verifies ownership and provisions TLS
   automatically.
3. Configure the `www` -> apex redirect via a Cloudflare redirect rule (or the Pages project's own
   custom-domain redirect, whichever the dashboard offers at setup time).

## Analytics

The site ships no analytics. A future self-hosted script would be added to
`src/app/layout.tsx`'s `<head>` from a first-party origin, with that origin added to the export
checker's allowlist (`scripts/check-export.mjs`). Text only -- no code, no placeholder.

No CSP is set in `public/_headers` this round: the static export still emits one reviewed inline
script (the theme-bootstrap script in `layout.tsx`, T-10-11). A nonce/hash-based CSP is a
documented follow-up, not implemented here.

## Rules

Content under `content/` never says "coming soon", "soon", "roadmap" or a date. Screenshots come
only from `docs/ui/approved/`.
