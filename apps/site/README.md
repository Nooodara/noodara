# @noodara/site

The public landing page and docs at [noodara.com](https://noodara.com), built with Next.js 16
(static export) and Fumadocs.

## Develop

```bash
pnpm site:dev    # http://localhost:3200
pnpm site:build  # writes apps/site/out
```

## Domain and base path

`public/CNAME` holds the production domain. Changing the domain means editing only that file.
With no `CNAME` present, the build serves from `/noodara` instead (so it still works from
`<owner>.github.io/noodara` before DNS/CNAME is configured) -- see `site-config.mjs`.

## Publishing

`.github/workflows/public-site.yml` publishes the static export to GitHub Pages on every push to
`main`. One-time repo setup:

- Settings -> Pages -> Build and deployment -> Source: **GitHub Actions**
- Settings -> Pages -> Custom domain: `noodara.com`
- Once DNS resolves, enable **Enforce HTTPS**

## DNS

Point `noodara.com` at GitHub Pages. Confirm these IPs are still current at
[docs.github.com/pages](https://docs.github.com/pages) before editing DNS:

- Apex (`noodara.com`) A records: `185.199.108.153`, `185.199.109.153`, `185.199.110.153`,
  `185.199.111.153`
- Apex AAAA records (optional, IPv6): `2606:50c0:8000::153`, `2606:50c0:8001::153`,
  `2606:50c0:8002::153`, `2606:50c0:8003::153`
- `www.noodara.com`: CNAME to `nooodara.github.io.`

## Analytics

The site ships no analytics. A future self-hosted script would be added to
`src/app/layout.tsx`'s `<head>` from a first-party origin, with that origin added to the export
checker's allowlist (`scripts/check-export.mjs`). Text only -- no code, no placeholder.

## Rules

Content under `content/` never says "coming soon", "soon", "roadmap" or a date. Screenshots come
only from `docs/ui/approved/`.
