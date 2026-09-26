import { describe, expect, it, vi } from 'vitest';
import { AccountMenu, type AccountMenuLinkProps, type AccountMenuProps } from './AccountMenu.js';
import { PRESS_CLASSES } from './press.js';
import { renderUi, screen, userEvent } from './testing/render.js';
import { useFloatingMenu } from './use-floating-menu.js';

// Mocks only the returned `closeSource` reading -- see RowMenu.test.tsx's identical mock for why
// this is the one thing jsdom can genuinely, synchronously observe about the keyboard-no-animation
// branch, and why the real proof is tests/e2e/keyboard-motion.spec.ts (Task 3).
vi.mock('./use-floating-menu.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./use-floating-menu.js')>();
  return { ...actual, useFloatingMenu: vi.fn(actual.useFloatingMenu) };
});

// The minimal link test double every AccountMenu test below renders through -- packages/ui has no
// router of its own (same reason NavTree.test.tsx never imports next/link), so a plain anchor
// stands in for the caller's real routed link component.
function TestLink({ href, role, 'data-testid': testId, onClick, className, children }: AccountMenuLinkProps) {
  return (
    <a href={href} role={role} data-testid={testId} onClick={onClick} className={className}>
      {children}
    </a>
  );
}

function buildProps(overrides: Partial<AccountMenuProps> = {}): AccountMenuProps {
  return {
    name: 'Ada Lovelace',
    email: 'ada@noodara.test',
    settingsHref: '/settings',
    linkComponent: TestLink,
    signOutSlot: (
      <button type="button" role="menuitem" data-testid="test-sign-out">
        Sign out
      </button>
    ),
    ...overrides,
  };
}

describe('AccountMenu', () => {
  it('renders a single trigger with the fixed accessible name, testid and ARIA menu attributes', () => {
    renderUi(<AccountMenu {...buildProps()} />);

    const trigger = screen.getByTestId('shell-account-menu-trigger');
    expect(trigger).toHaveAttribute('aria-label', 'Account menu');
    expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger.tagName.toLowerCase()).toBe('button');
  });

  it('gives the trigger a 44px-tall touch target', () => {
    renderUi(<AccountMenu {...buildProps()} />);

    expect(screen.getByTestId('shell-account-menu-trigger').className).toContain('h-11');
  });

  it('does not put any menu content in the accessibility tree before the trigger is activated', () => {
    renderUi(<AccountMenu {...buildProps()} />);

    expect(screen.queryByRole('menuitem')).toBeNull();
  });

  it('renders the avatar initials as aria-hidden, uppercase, from the first and last name tokens', () => {
    renderUi(<AccountMenu {...buildProps({ name: 'ada lovelace' })} />);

    const trigger = screen.getByTestId('shell-account-menu-trigger');
    const initials = trigger.querySelector('[aria-hidden="true"]');
    expect(initials).not.toBeNull();
    expect(initials?.textContent).toBe('AL');
  });

  it('renders a single initial for a one-token name', () => {
    renderUi(<AccountMenu {...buildProps({ name: 'Madonna' })} />);

    const trigger = screen.getByTestId('shell-account-menu-trigger');
    const initials = trigger.querySelector('[aria-hidden="true"]');
    expect(initials?.textContent).toBe('M');
  });

  it('degrades to a blank avatar rather than throwing when the name is empty', () => {
    renderUi(<AccountMenu {...buildProps({ name: '' })} />);

    expect(screen.getByTestId('shell-account-menu-trigger')).toBeInTheDocument();
  });

  it('opens the menu with header (name, email), Settings, Appearance+ThemeToggle, Sign out, in that order', async () => {
    const user = userEvent.setup();
    renderUi(<AccountMenu {...buildProps()} />);

    await user.click(screen.getByTestId('shell-account-menu-trigger'));

    const menu = screen.getByRole('menu');
    expect(menu).toHaveTextContent('Ada Lovelace');
    expect(menu).toHaveTextContent('ada@noodara.test');

    const settingsLink = screen.getByTestId('shell-account-menu-settings-link');
    const themeToggle = screen.getByTestId('shell-account-menu-theme-toggle');
    const signOut = screen.getByTestId('test-sign-out');

    expect(menu).toHaveTextContent('Settings');
    expect(menu).toHaveTextContent('Appearance');

    // Document order: header text precedes Settings, which precedes Appearance/ThemeToggle,
    // which precedes Sign out.
    const order = [settingsLink, themeToggle, signOut];
    for (let i = 0; i < order.length - 1; i += 1) {
      const current = order[i];
      const next = order[i + 1];
      if (current === undefined || next === undefined) throw new Error('expected both nodes');
      expect(current.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    }
  });

  it('the header renders no interactive element of its own', async () => {
    const user = userEvent.setup();
    renderUi(<AccountMenu {...buildProps()} />);

    await user.click(screen.getByTestId('shell-account-menu-trigger'));

    const menu = screen.getByRole('menu');
    const header = menu.querySelector('[data-part="account-menu-header"]');
    expect(header).not.toBeNull();
    expect(header?.querySelector('button, a')).toBeNull();
  });

  it('selecting Settings closes the menu', async () => {
    const user = userEvent.setup();
    renderUi(<AccountMenu {...buildProps()} />);

    await user.click(screen.getByTestId('shell-account-menu-trigger'));
    await user.click(screen.getByTestId('shell-account-menu-settings-link'));

    expect(screen.queryByRole('menuitem')).toBeNull();
  });

  it('clicking the theme control inside Appearance does not close the menu', async () => {
    const user = userEvent.setup();
    renderUi(<AccountMenu {...buildProps()} />);

    await user.click(screen.getByTestId('shell-account-menu-trigger'));
    await user.click(screen.getByTestId('shell-account-menu-theme-toggle'));

    expect(screen.getByRole('menu')).toBeInTheDocument();
  });

  it('moves focus between Settings and Sign out with ArrowDown/ArrowUp/Home/End, never onto the header or the Appearance row', async () => {
    const user = userEvent.setup();
    renderUi(<AccountMenu {...buildProps()} />);

    await user.click(screen.getByTestId('shell-account-menu-trigger'));
    expect(screen.getByTestId('shell-account-menu-settings-link')).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByTestId('test-sign-out')).toHaveFocus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByTestId('shell-account-menu-settings-link')).toHaveFocus();

    await user.keyboard('{End}');
    expect(screen.getByTestId('test-sign-out')).toHaveFocus();

    await user.keyboard('{Home}');
    expect(screen.getByTestId('shell-account-menu-settings-link')).toHaveFocus();

    await user.keyboard('{ArrowUp}');
    expect(screen.getByTestId('test-sign-out')).toHaveFocus();
  });

  it('closes on Escape and returns focus to the trigger, sharing use-floating-menu with RowMenu', async () => {
    const user = userEvent.setup();
    renderUi(<AccountMenu {...buildProps()} />);
    const trigger = screen.getByTestId('shell-account-menu-trigger');

    await user.click(trigger);
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('closes when a pointer interaction happens outside the menu', async () => {
    const user = userEvent.setup();
    renderUi(
      <div>
        <AccountMenu {...buildProps()} />
        <button type="button">Outside</button>
      </div>,
    );

    await user.click(screen.getByTestId('shell-account-menu-trigger'));
    expect(screen.getByRole('menu')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Outside' }));

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('carries the floating shadow on the content element and bg-surface-3, same level as RowMenu', async () => {
    const user = userEvent.setup();
    renderUi(<AccountMenu {...buildProps()} />);

    await user.click(screen.getByTestId('shell-account-menu-trigger'));

    const content = screen.getByRole('menu');
    expect(content.className).toContain('shadow-[var(--shadow-floating)]');
    expect(content.className).toContain('bg-surface-3');
  });

  it('renders no accent colour anywhere -- the avatar is monochrome', () => {
    const { container } = renderUi(<AccountMenu {...buildProps()} />);

    expect(container.innerHTML).not.toMatch(/accent/);
  });

  it('AccountMenuProps has no items array -- the fixed three-row shape is enforced by the type itself', () => {
    // @ts-expect-error -- `items` is intentionally not part of AccountMenuProps.
    const invalid: AccountMenuProps = { ...buildProps(), items: [] };
    expect(invalid).toBeTruthy();
  });

  // 08-20-PLAN.md Task 1 (UI-05): the Settings item row gets its press feedback from the one
  // shared PRESS_CLASSES definition -- never a second, local press-scale literal.
  it('gets its press feedback on the Settings item row from the one shared PRESS_CLASSES definition (UI-05)', async () => {
    const user = userEvent.setup();
    renderUi(<AccountMenu {...buildProps()} />);

    await user.click(screen.getByTestId('shell-account-menu-trigger'));
    const settingsLink = screen.getByTestId('shell-account-menu-settings-link');

    for (const token of PRESS_CLASSES.split(/\s+/).filter(Boolean)) {
      expect(settingsLink.className).toContain(token);
    }
  });

  // 08-20-PLAN.md Task 2 (UI-05/§9 #10, pitfall P14): once the shared closeSource (read through
  // useFloatingMenu, never a second useCloseSource call of its own) is wired in, an Escape-close
  // must still dismiss the menu and return focus to the trigger correctly -- the same regression
  // coverage RowMenu.test.tsx gets for the identical mechanism (see its own header comment for
  // why jsdom cannot verify a *rendered* transition's absence here; the real proof is
  // tests/e2e/keyboard-motion.spec.ts, Task 3).
  it('still dismisses via Escape, with focus returning to the trigger, once closeSource is wired in', async () => {
    const user = userEvent.setup();
    renderUi(<AccountMenu {...buildProps()} />);
    const trigger = screen.getByTestId('shell-account-menu-trigger');

    await user.click(trigger);
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('menu')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('applies the zero-duration override to the content while the recorded close source reads keyboard', async () => {
    const user = userEvent.setup();
    const mockedHook = vi.mocked(useFloatingMenu);
    const defaultImpl = mockedHook.getMockImplementation();
    mockedHook.mockImplementation(() => {
      const real = defaultImpl!();
      return { ...real, closeSource: () => 'keyboard' as const };
    });

    try {
      renderUi(<AccountMenu {...buildProps()} />);
      await user.click(screen.getByTestId('shell-account-menu-trigger'));

      expect(screen.getByRole('menu').className).toContain('!duration-0');
    } finally {
      mockedHook.mockImplementation(defaultImpl!);
    }
  });

  it('does not apply the override to the content while the recorded close source is the default, programmatic reading', async () => {
    const user = userEvent.setup();
    renderUi(<AccountMenu {...buildProps()} />);

    await user.click(screen.getByTestId('shell-account-menu-trigger'));

    expect(screen.getByRole('menu').className).not.toContain('!duration-0');
  });
});
