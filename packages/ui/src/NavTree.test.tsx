import { describe, expect, it } from 'vitest';
import { NavTree, type NavTreeItem, type NavTreeLinkProps } from './NavTree.js';
import { renderUi, screen, userEvent } from './testing/render.js';

// Task 1 (08-07-PLAN.md): a generic navigation tree -- items with optional children, no import
// from any data-model package and no field named after a concrete entity. `FakeLink` stands in
// for the app's real router link (D-07/08-UI-SPEC.md §3: `packages/ui` never imports a router of
// its own), a plain anchor carrying every prop `NavTreeLinkProps` promises.
function FakeLink({
  href,
  children,
  onClick,
  className,
  'aria-label': ariaLabel,
  'aria-current': ariaCurrent,
  'data-testid': testId,
}: NavTreeLinkProps) {
  return (
    <a href={href} onClick={onClick} className={className} aria-label={ariaLabel} aria-current={ariaCurrent} data-testid={testId}>
      {children}
    </a>
  );
}

function DummyIcon() {
  return <svg aria-hidden="true" />;
}

const FLAT_ITEMS: readonly NavTreeItem[] = [
  { id: 'servers', label: 'Servers', href: '/servers', icon: DummyIcon },
  { id: 'activity', label: 'Activity', href: '/activity', icon: DummyIcon },
  { id: 'settings', label: 'Settings', href: '/settings', icon: DummyIcon },
];

describe('NavTree flat leaves (today\'s data shape)', () => {
  it('renders three leaves as links, with no expand control anywhere', () => {
    renderUi(<NavTree items={FLAT_ITEMS} activeHref="/servers" linkComponent={FakeLink} />);

    expect(screen.getByRole('link', { name: 'Servers' })).toHaveAttribute('href', '/servers');
    expect(screen.getByRole('link', { name: 'Activity' })).toHaveAttribute('href', '/activity');
    expect(screen.getByRole('link', { name: 'Settings' })).toHaveAttribute('href', '/settings');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('renders each leaf with data-testid="nav-tree-item-{id}"', () => {
    renderUi(<NavTree items={FLAT_ITEMS} activeHref="/servers" linkComponent={FakeLink} />);

    expect(screen.getByTestId('nav-tree-item-servers')).toHaveAttribute('href', '/servers');
    expect(screen.getByTestId('nav-tree-item-activity')).toHaveAttribute('href', '/activity');
    expect(screen.getByTestId('nav-tree-item-settings')).toHaveAttribute('href', '/settings');
  });

  it('marks only the active href with aria-current="page"', () => {
    renderUi(<NavTree items={FLAT_ITEMS} activeHref="/activity" linkComponent={FakeLink} />);

    expect(screen.getByRole('link', { name: 'Activity' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('link', { name: 'Servers' })).not.toHaveAttribute('aria-current');
    expect(screen.getByRole('link', { name: 'Settings' })).not.toHaveAttribute('aria-current');
  });

  it('calls onNavigate when a leaf is activated', async () => {
    const user = userEvent.setup();
    let navigated = false;
    renderUi(
      <NavTree
        items={FLAT_ITEMS}
        activeHref="/servers"
        onNavigate={() => {
          navigated = true;
        }}
        linkComponent={FakeLink}
      />,
    );

    await user.click(screen.getByRole('link', { name: 'Activity' }));

    expect(navigated).toBe(true);
  });

  it('never renders a leaf with no href and no children', () => {
    const items: readonly NavTreeItem[] = [
      ...FLAT_ITEMS,
      { id: 'ghost', label: 'Ghost', icon: DummyIcon },
    ];
    renderUi(<NavTree items={items} activeHref="/servers" linkComponent={FakeLink} />);

    expect(screen.queryByText('Ghost')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Ghost' })).toBeNull();
  });
});

describe('NavTree parent items (structural, not exercised by today\'s data)', () => {
  const PARENT_ITEMS: readonly NavTreeItem[] = [
    {
      id: 'group-a',
      label: 'Group A',
      icon: DummyIcon,
      children: [{ id: 'child-a', label: 'Child A', href: '/a', icon: DummyIcon }],
    },
    {
      id: 'group-b',
      label: 'Group B',
      icon: DummyIcon,
      children: [{ id: 'child-b', label: 'Child B', href: '/b', icon: DummyIcon }],
    },
  ];

  it('renders a toggle carrying aria-expanded, with its children absent from the document while collapsed', () => {
    renderUi(<NavTree items={PARENT_ITEMS} activeHref="/a" linkComponent={FakeLink} />);

    expect(screen.getByRole('button', { name: 'Group A' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Child A' })).toBeNull();
  });

  it('expands only the parent that was activated -- state is held per item', async () => {
    const user = userEvent.setup();
    renderUi(<NavTree items={PARENT_ITEMS} activeHref="/a" linkComponent={FakeLink} />);

    await user.click(screen.getByRole('button', { name: 'Group A' }));

    expect(screen.getByRole('button', { name: 'Group A' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Child A' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Group B' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Child B' })).toBeNull();
  });
});
