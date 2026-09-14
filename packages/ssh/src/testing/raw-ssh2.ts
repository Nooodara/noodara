// Test-only re-export of ssh2's low-level `Client`/`utils` surface (02-04-PLAN.md Wave 0
// empirical spikes). packages/ssh's actual production surface (`../ssh-port.js`,
// `../commands/index.js`) never exposes ssh2 itself — no plan before 02-06 implements `SshPort`,
// and no plan after it needs raw ssh2 access again. This module exists solely so
// tests/integration/ssh/contracts.test.ts can drive a real `ssh2.Client` directly (the plan's own
// words: "using a raw ssh2.Client in this spike — the adapter does not exist yet") while
// packages/ssh/src/boundary.test.ts keeps enforcing that no file *outside* packages/ssh imports
// `ssh2` itself: this file lives under packages/ssh/src, so that guard's own
// `isUnderSshPackage` check exempts it, and the test file imports `@noodara/ssh/testing` instead
// of `ssh2`.
//
// Never shipped: packages/ssh/tsconfig.build.json already excludes `src/testing/**` (declared in
// Plan 02-01, unused until this file), and packages/ssh/package.json's `exports` map has no
// subpath pointing here — only the Vitest-only `@noodara/ssh/testing` source alias
// (vitest.shared.ts) resolves this specifier, so plain Node can never reach it.
export { Client, utils } from 'ssh2';
export type { ClientChannel, ConnectConfig, ParsedKey } from 'ssh2';
