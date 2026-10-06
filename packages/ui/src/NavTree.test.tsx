import { describe, expect, it } from 'vitest';
import type { ComponentType, ReactElement } from 'react';
import { NavTree, type NavTreeItem, type NavTreeLinkProps } from './NavTree.js';
import { renderUi, screen, userEvent } from './testing/render.js';
import { TooltipProvider } from './Tooltip.js';

// `rerender` from renderUi drops its provider; re-wrap so the second render matches the first.
function withProvider(ui: ReactElement): ReactElement {
  return <TooltipProvider delayDuration={0}>{ui}</TooltipProvider>;
}

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

  // D-14: item height comes from the single --row-height token, not a hardcoded h-11.
  it('takes its leaf item height from var(--row-height), never a hardcoded h-11', () => {
    renderUi(<NavTree items={FLAT_ITEMS} activeHref="/servers" linkComponent={FakeLink} />);

    const item = screen.getByTestId('nav-tree-item-servers');
    expect(item.className).toMatch(/h-\[var\(--row-height\)\]/);
    expect(item.className).not.toMatch(/\bh-11\b/);
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

  // Mobile round 1 adjustment (09-14 checkpoint): below the 900px rail breakpoint (bottom-sheet
  // drawer and any other narrow layout) the label must render alongside the icon -- it was
  // previously hidden everywhere below 1280px, silently erasing "Servers / Activity / Settings"
  // text from the <900px drawer, which only ever meant to hide the label in the 900-1279px icon
  // rail specifically.
  it('shows the label below the 900px rail breakpoint and at >=1280px, hiding it only in the 900-1279px icon rail', () => {
    renderUi(<NavTree items={FLAT_ITEMS} activeHref="/servers" linkComponent={FakeLink} />);

    const label = screen.getByTestId('nav-tree-item-servers').querySelector('span');
    expect(label).not.toBeNull();
    expect(label?.className).toContain('inline');
    expect(label?.className).toContain('min-[900px]:hidden');
    expect(label?.className).toContain('min-[1280px]:inline');
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

  // 13-09: a branch holding the current page now opens itself, so these two cases sit on a route
  // outside both groups.
  it('renders a toggle carrying aria-expanded, with its children absent from the document while collapsed', () => {
    renderUi(<NavTree items={PARENT_ITEMS} activeHref="/elsewhere" linkComponent={FakeLink} />);

    expect(screen.getByRole('button', { name: 'Group A' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Child A' })).toBeNull();
  });

  it('expands only the parent that was activated -- state is held per item', async () => {
    const user = userEvent.setup();
    renderUi(<NavTree items={PARENT_ITEMS} activeHref="/elsewhere" linkComponent={FakeLink} />);

    await user.click(screen.getByRole('button', { name: 'Group A' }));

    expect(screen.getByRole('button', { name: 'Group A' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('link', { name: 'Child A' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Group B' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('link', { name: 'Child B' })).toBeNull();
  });
});

// 13-09: Projects -> Environment -> Service. A parent can have a page of its own (the label is a
// link) plus a separate disclosure button; the current page is the most specific match.
describe('NavTree parents with their own page (13-09)', () => {
  function tree(serviceLabel = 'api'): readonly NavTreeItem[] {
    return [
      { id: 'servers', label: 'Servers', href: '/servers', icon: DummyIcon },
      {
        id: 'projects',
        label: 'Projects',
        href: '/projects',
        icon: DummyIcon,
        children: [
          {
            id: 'project-p1',
            label: 'Shop',
            href: '/projects/p1',
            icon: DummyIcon,
            children: [
              {
                id: 'environment-e1',
                label: 'production',
                href: '/projects/p1#environment-e1',
                icon: DummyIcon,
                children: [{ id: 'service-s1', label: serviceLabel, href: '/projects/p1/services/s1', icon: DummyIcon }],
              },
            ],
          },
        ],
      },
    ];
  }

  it('renders the label as a link and a separate toggle, collapsed off the active path', () => {
    renderUi(<NavTree items={tree()} activeHref="/servers" linkComponent={FakeLink} />);

    expect(screen.getByTestId('nav-tree-item-projects')).toHaveAttribute('href', '/projects');
    expect(screen.getByTestId('nav-tree-toggle-projects')).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('nav-tree-item-project-p1')).toBeNull();
  });

  it('opens every branch on the active path and marks only the deepest match as the current page', () => {
    renderUi(<NavTree items={tree()} activeHref="/projects/p1/services/s1" linkComponent={FakeLink} />);

    const service = screen.getByTestId('nav-tree-item-service-s1');
    expect(service).toHaveAttribute('aria-current', 'page');
    expect(service.className).toContain('bg-accent-soft');
    for (const id of ['projects', 'project-p1']) {
      const link = screen.getByTestId(`nav-tree-item-${id}`);
      expect(link).not.toHaveAttribute('aria-current');
      expect(link.className).toContain('text-ink');
      expect(link.className).not.toContain('bg-accent-soft');
      expect(screen.getByTestId(`nav-tree-toggle-${id}`)).toHaveAttribute('aria-expanded', 'true');
    }
    expect(screen.getByTestId('nav-tree-item-environment-e1')).not.toHaveAttribute('aria-current');
    expect(screen.getAllByRole('link').filter((link) => link.getAttribute('aria-current') === 'page')).toHaveLength(1);
  });

  it('marks a project page current, never its environment (a #fragment route is not a page)', () => {
    renderUi(<NavTree items={tree()} activeHref="/projects/p1" linkComponent={FakeLink} />);

    expect(screen.getByTestId('nav-tree-item-project-p1')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('nav-tree-item-environment-e1')).not.toHaveAttribute('aria-current');
    expect(screen.getByTestId('nav-tree-item-projects')).not.toHaveAttribute('aria-current');
  });

  it('opens a branch when navigation moves into it later', () => {
    const { rerender } = renderUi(<NavTree items={tree()} activeHref="/servers" linkComponent={FakeLink} />);
    expect(screen.queryByTestId('nav-tree-item-service-s1')).toBeNull();

    rerender(withProvider(<NavTree items={tree()} activeHref="/projects/p1/services/s1" linkComponent={FakeLink} />));

    expect(screen.getByTestId('nav-tree-item-service-s1')).toHaveAttribute('aria-current', 'page');
  });

  it('works by keyboard: Tab reaches the link then its toggle, Enter on the toggle expands it', async () => {
    const user = userEvent.setup();
    renderUi(<NavTree items={tree()} activeHref="/servers" linkComponent={FakeLink} />);

    await user.tab();
    expect(screen.getByTestId('nav-tree-item-servers')).toHaveFocus();
    await user.tab();
    expect(screen.getByTestId('nav-tree-item-projects')).toHaveFocus();
    await user.tab();
    const toggle = screen.getByTestId('nav-tree-toggle-projects');
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAccessibleName('Toggle Projects');

    await user.keyboard('{Enter}');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.tab();
    expect(screen.getByTestId('nav-tree-item-project-p1')).toHaveFocus();
  });

  it('hides a subtree and its toggle in the 900-1279px icon rail', () => {
    renderUi(<NavTree items={tree()} activeHref="/projects/p1" linkComponent={FakeLink} />);

    expect(screen.getByTestId('nav-tree-toggle-projects').className).toContain('min-[900px]:max-[1279px]:hidden');
    const content = screen.getByTestId('nav-tree-item-project-p1').closest('ul')?.parentElement;
    expect(content?.className).toContain('min-[900px]:max-[1279px]:hidden');
  });

  it('renders a hostile or very long label as inert, truncated text with the full name in its accessible name', () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const long = 'a'.repeat(300);
    const items: readonly NavTreeItem[] = [
      { id: 'x', label: hostile, href: '/x', icon: DummyIcon },
      { id: 'y', label: long, href: '/y', icon: DummyIcon },
    ];
    const { container } = renderUi(<NavTree items={items} activeHref="/servers" linkComponent={FakeLink} />);

    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('nav-tree-item-x')).toHaveAccessibleName(hostile);
    expect(screen.getByTestId('nav-tree-item-x')).toHaveTextContent(hostile);
    const longLink = screen.getByTestId('nav-tree-item-y');
    expect(longLink).toHaveAccessibleName(long);
    expect(longLink.querySelector('span')?.className).toContain('truncate');
  });
});

describe('NavTree re-render bounds (13-09 H2)', () => {
  const renders = new Map<string, number>();
  const icons = new Map<string, ComponentType>();
  function countingIcon(id: string): ComponentType {
    const existing = icons.get(id);
    if (existing !== undefined) return existing;
    function CountingIcon() {
      renders.set(id, (renders.get(id) ?? 0) + 1);
      return <svg aria-hidden="true" />;
    }
    icons.set(id, CountingIcon);
    return CountingIcon;
  }
  function leaf(id: string, label: string): NavTreeItem {
    return { id, label, href: `/${id}`, icon: countingIcon(id) };
  }

  it('re-renders only the changed leaf and its ancestors when unchanged subtrees keep their identity', () => {
    renders.clear();
    const otherBranch: NavTreeItem = {
      id: 'b',
      label: 'B',
      href: '/b',
      icon: countingIcon('b'),
      children: [leaf('b1', 'B1'), leaf('b2', 'B2')],
    };
    const sibling = leaf('a2', 'A2');
    const build = (label: string): readonly NavTreeItem[] => [
      { id: 'a', label: 'A', href: '/a', icon: countingIcon('a'), children: [leaf('a1', label), sibling] },
      otherBranch,
    ];
    const { rerender } = renderUi(<NavTree items={build('A1 v0')} activeHref="/a/x" linkComponent={FakeLink} />);
    expect(renders.get('a1')).toBe(1);
    renders.clear();

    for (let index = 1; index <= 200; index += 1) {
      rerender(withProvider(<NavTree items={build(`A1 v${String(index)}`)} activeHref="/a/x" linkComponent={FakeLink} />));
    }

    expect(screen.getByTestId('nav-tree-item-a1')).toHaveTextContent('A1 v200');
    expect(renders.get('a1')).toBe(200);
    expect(renders.get('a')).toBe(200);
    expect(renders.get('a2')).toBeUndefined();
    expect(renders.get('b')).toBeUndefined();
  });
});
