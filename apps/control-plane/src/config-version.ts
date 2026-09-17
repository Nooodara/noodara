// D-21/RESEARCH.md Pattern 6: `dist/config-version.js` and `src/config-version.ts` sit at the
// same relative depth (one level) below `apps/control-plane/package.json` — confirmed via
// `tsconfig.build.json`'s `rootDir: "src"` / `outDir: "dist"`. A single `../package.json`
// specifier therefore resolves identically under `tsx watch` (dev), plain `node dist/*.js`
// (prod) and Vitest alike. This file must stay at depth 1 directly under `src/` for that
// invariant to hold — do not nest it inside a subdirectory.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export const CONTROL_PLANE_VERSION: string = (require('../package.json') as { version: string }).version;
