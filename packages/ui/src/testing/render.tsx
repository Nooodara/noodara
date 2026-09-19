import type { ReactElement } from 'react';
import { render, type RenderResult } from '@testing-library/react';
// Named import, not the default: @testing-library/user-event's package.json carries no
// "type" field, so under `moduleResolution: nodenext` its .d.ts is classified CommonJS-format
// regardless of its ESM-looking `export { userEvent as default }` syntax -- esModuleInterop's
// synthetic default then resolves to the whole module namespace object, not the actual
// exported value, and `userEvent.setup` type-checks as missing. The named `userEvent` export
// is unaffected by that interop rule.
import { userEvent } from '@testing-library/user-event';
import { TooltipProvider } from '../Tooltip.js';

// The single component-test entry point for @noodara/ui and (once it exists) apps/web,
// reachable only via the `@noodara/ui/testing` subpath (packages/ui/package.json's `exports`
// map) -- never via the barrel (packages/ui/src/index.ts never re-exports this module). This
// file is excluded from production output semantics (never imported by non-test code, enforced
// by Plan 05-21's `check:ui-safety` gate) and from coverage (vitest.config.ts's
// coverage.exclude, mirroring the existing packages/ssh/src/testing/** entry).
//
// renderUi is a thin wrapper over Testing Library's own `render` -- the one place a shared
// provider is added so every component test picks it up automatically instead of each test file
// wiring its own provider list. `TooltipProvider` (Plan 05-24) is the first: `delayDuration={0}`
// keeps tests fast/deterministic rather than waiting on the primitive's real 700ms hover delay --
// `apps/web`'s own root layout mounts the same `TooltipProvider` (without this override) for the
// real app.
export function renderUi(ui: ReactElement): RenderResult {
  return render(<TooltipProvider delayDuration={0}>{ui}</TooltipProvider>);
}

// Re-exported so no component test imports @testing-library/react directly.
export { screen, within, waitFor, fireEvent } from '@testing-library/react';
export { userEvent };
