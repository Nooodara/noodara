import { describe, expect, it } from 'vitest';
import { renderUi, screen } from '@noodara/ui/testing';
import { ShellContext, type ShellContextValue } from '../lib/shell-context';
import { ServerDetailToolbar } from './ServerDetailToolbar';

// 08-11-PLAN.md Task 3 round 1 (deferred-items.md "ServerDetailToolbar's server-name title
// truncates to almost nothing at 375px"): the title wrapper claims `flex flex-1 ... truncate`
// but neither it nor the `h1` carries `min-w-0`, so the flex item's intrinsic content width wins
// over the available-space calculation before `truncate`'s `overflow:hidden` can act -- a long
// server name plus the back link, `StatusPill` and primary action starves the title down to a
// couple of characters at 375px. Asserted here as class presence (jsdom has no real layout
// engine to measure the actual rendered width against, matching Toolbar.test.tsx's own
// discipline for this exact kind of flex/truncate contract).

const SHELL_CONTEXT: ShellContextValue = {
  connected: true,
  subscribe: () => () => undefined,
  registerResync: () => () => undefined,
  close: () => undefined,
  closedByCaller: false,
  mobileNavOpen: false,
  toggleMobileNav: () => undefined,
  closeMobileNav: () => undefined,
};

function renderToolbar(props: Partial<Parameters<typeof ServerDetailToolbar>[0]> = {}) {
  return renderUi(
    <ShellContext.Provider value={SHELL_CONTEXT}>
      <ServerDetailToolbar
        serverId="server-1"
        serverName="ui-review-connected"
        status="CONNECTED"
        primaryAction={null}
        {...props}
      />
    </ShellContext.Provider>,
  );
}

describe('ServerDetailToolbar title truncation (deferred-items.md 08-11 round 1)', () => {
  it('gives the truncating title wrapper min-w-0 so the flex item can shrink below its content width', () => {
    renderToolbar();
    const title = screen.getByRole('heading', { level: 1, name: 'ui-review-connected' });
    const wrapper = title.parentElement;
    expect(wrapper).not.toBeNull();
    expect(wrapper?.className).toContain('min-w-0');
    expect(wrapper?.className).toContain('truncate');
  });

  it('gives the h1 itself min-w-0 too, since it is its own nested flex item next to StatusPill', () => {
    renderToolbar();
    const title = screen.getByRole('heading', { level: 1, name: 'ui-review-connected' });
    expect(title.className).toContain('min-w-0');
    expect(title.className).toContain('truncate');
  });
});
