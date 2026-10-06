import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from 'react';
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';
import { ChevronRight } from 'lucide-react';
import { cn } from './cn.js';
import { DISCLOSURE_CONTENT_CLASSES, DISCLOSURE_INNER_CLASSES } from './Disclosure.js';
import { PRESS_CLASSES } from './press.js';
import { Tooltip } from './Tooltip.js';

/** Props every icon this tree renders must accept -- the same shape `lucide-react`'s icon
 *  components already expose, spread verbatim from `ICON_PROPS` below (unchanged from
 *  `Sidebar.tsx`'s own `ICON_PROPS`). */
export interface NavTreeIconProps {
  readonly 'aria-hidden'?: boolean;
  readonly size?: number;
  readonly strokeWidth?: number;
}

/** Generic tree item -- deliberately domain-agnostic (D-07): no import from any data-model
 *  package, and no field named after a concrete entity this tree might one day be filled with.
 *  A future caller with real hierarchical data only ever needs to build a value of this shape and
 *  pass it in; this file itself never changes. */
export interface NavTreeItem {
  readonly id: string;
  readonly label: string;
  readonly href?: string;
  readonly icon: ComponentType<NavTreeIconProps>;
  readonly children?: readonly NavTreeItem[];
}

/** The minimal prop surface `NavTree` needs from whatever link primitive the caller's router
 *  provides -- this package has no router dependency of its own and must never gain one (the
 *  app supplies its own routed link component in; a test supplies a plain anchor). */
export interface NavTreeLinkProps {
  readonly href: string;
  readonly 'aria-label': string;
  readonly 'aria-current'?: 'page';
  readonly 'data-testid': string;
  readonly onClick?: () => void;
  readonly className: string;
  readonly children: ReactNode;
}

export interface NavTreeProps {
  readonly items: readonly NavTreeItem[];
  readonly activeHref: string;
  readonly onNavigate?: () => void;
  readonly linkComponent: ComponentType<NavTreeLinkProps>;
}

// Reproduces Sidebar.tsx's existing leaf markup byte-for-byte (D-07: "se ve idéntico a la lista
// plana actual") -- moved here so Sidebar.tsx no longer owns its own copy once it composes this
// component instead. PRESS_CLASSES (UI-05, 08-20-PLAN.md Task 1) is the one shared press-feedback
// definition (press.ts, owned by 08-13) -- composed in, never redeclared. Only the press itself
// (:active) gets a transition; navigation activation and aria-current changes stay unanimated
// (D-07).
// Item height comes from the single --row-height token (D-14: 44px comfortable / 36px compact),
// not a fixed 44px utility.
const ITEM_CLASSES = cn(
  'flex h-[var(--row-height)] items-center gap-3 rounded-sm px-3 text-callout font-medium text-ink-secondary hover:bg-surface-2 [&>svg]:shrink-0',
  PRESS_CLASSES,
);
const ACTIVE_ITEM_CLASSES = 'bg-accent-soft text-ink';
// 13-09: the ancestors of the current page read as part of its path -- ink, never a second fill.
const ACTIVE_PATH_CLASSES = 'text-ink';
// Mobile round 1 adjustment (09-14 checkpoint): the label is visible by default (the <900px
// bottom-sheet drawer, D-03) and at >=1280px (the expanded sidebar) -- it is hidden only in the
// 900-1279px icon rail, where the tooltip on the trigger itself carries the label instead. The
// previous `hidden min-[1280px]:inline` silently hid the label everywhere below 1280px, including
// the drawer where it was never meant to be hidden.
// 13-09 H1: a long name with no spaces truncates; the tooltip and aria-label carry it in full.
const LABEL_CLASSES = 'inline min-w-0 truncate min-[900px]:hidden min-[1280px]:inline';
const ICON_PROPS = { 'aria-hidden': true, size: 20, strokeWidth: 1.5 } as const;

const TRIGGER_CLASSES = cn(ITEM_CLASSES, 'w-full justify-between');

// Same grid-template-rows-transition technique as Disclosure.tsx's CONTENT_CLASSES -- never an
// animated `height` (§9 #11) -- gated by `motion-safe:` so `prefers-reduced-motion` collapses it
// to an instant toggle, matching every other Disclosure-based expand/collapse in this system.
const CHEVRON_CLASSES = cn(
  'h-4 w-4 shrink-0 text-ink-secondary motion-safe:transition-transform motion-safe:duration-[var(--duration-micro)]',
  // Keyed to the chevron's own trigger, never an ancestor group: nested disclosures turn independently.
  '[[data-state=open]>&]:rotate-90',
);
// 08-14-PLAN.md Task 2: reuses Disclosure.tsx's own exported grid-template-rows class constant
// rather than keeping a near-copy -- both expand/collapse disclosures now share exactly one
// expression for this technique.
const CONTENT_CLASSES = DISCLOSURE_CONTENT_CLASSES;
const CHILD_LIST_CLASSES = cn(DISCLOSURE_INNER_CLASSES, 'flex flex-col gap-1 pl-4');
// The 900-1279px icon rail has no room for a subtree: a parent with a page of its own shows only
// its link there.
const RAIL_HIDDEN_CLASSES = 'min-[900px]:max-[1279px]:hidden';
const TOGGLE_CLASSES = cn(
  'flex h-[var(--row-height)] w-8 shrink-0 items-center justify-center rounded-sm hover:bg-surface-2',
  RAIL_HIDDEN_CLASSES,
  PRESS_CLASSES,
);

/** The part of an href that names a route: a `#fragment` or `?query` never makes an item current. */
function routeOf(href: string): string {
  return href.split(/[?#]/, 1)[0] ?? href;
}

function matches(activeHref: string, href: string): boolean {
  const route = routeOf(href);
  return activeHref === route || activeHref.startsWith(`${route}/`);
}

/** A leaf with no destination is never rendered at all -- never rendered in an inactive state (§9 #8/#19). */
function hasDestination(item: NavTreeItem): boolean {
  return item.href !== undefined || (item.children !== undefined && item.children.length > 0);
}

function hasChildren(item: NavTreeItem): item is NavTreeItem & { readonly children: readonly NavTreeItem[] } {
  return item.children?.some(hasDestination) ?? false;
}

const PATH_SEPARATOR = '\u0000';

function childPath(parentPath: string, id: string): string {
  return parentPath === '' ? id : `${parentPath}${PATH_SEPARATOR}${id}`;
}

function isOnPath(activeKey: string, path: string): boolean {
  return activeKey === path || activeKey.startsWith(`${path}${PATH_SEPARATOR}`);
}

/**
 * 13-09: the key (ids joined by NUL) of the one item that is the current page -- the item whose
 * route matches `activeHref` most specifically. On a tie the shallower item wins, so a project
 * page never marks one of its environments current. `''` when nothing matches.
 */
function activeKeyFor(items: readonly NavTreeItem[], activeHref: string): string {
  let best = '';
  let bestLength = -1;
  const visit = (list: readonly NavTreeItem[], parentPath: string): void => {
    for (const item of list) {
      if (!hasDestination(item)) continue;
      const path = childPath(parentPath, item.id);
      if (item.href !== undefined && matches(activeHref, item.href)) {
        const length = routeOf(item.href).length;
        if (length > bestLength) {
          best = path;
          bestLength = length;
        }
      }
      if (item.children !== undefined) visit(item.children, path);
    }
  };
  visit(items, '');
  return best;
}

interface NavTreeNodeProps {
  readonly item: NavTreeItem;
  readonly path: string;
  /** The active key when it falls inside this node's subtree, `''` otherwise -- so a navigation
   *  re-renders only the branches it leaves and enters (13-09 H2). */
  readonly activeKey: string;
  /** Stable for the tree's lifetime (NavTree keeps the latest caller callback in a ref). */
  readonly onNavigate: () => void;
  readonly linkComponent: ComponentType<NavTreeLinkProps>;
}

function NavTreeChildren({
  items,
  path,
  activeKey,
  onNavigate,
  linkComponent,
  className,
}: Omit<NavTreeNodeProps, 'item'> & { readonly items: readonly NavTreeItem[]; readonly className: string }) {
  return (
    <ul className={className}>
      {items.filter(hasDestination).map((child) => {
        const nextPath = childPath(path, child.id);
        return (
          <NavTreeNode
            key={child.id}
            item={child}
            path={nextPath}
            activeKey={isOnPath(activeKey, nextPath) ? activeKey : ''}
            onNavigate={onNavigate}
            linkComponent={linkComponent}
          />
        );
      })}
    </ul>
  );
}

// 13-09 H2: memoized per node. A caller that rebuilds its items while keeping unchanged subtrees
// as the same objects (apps/web/src/components/ProjectNav.ts) re-renders only the changed node
// and its ancestors -- a burst of updates to one leaf never touches a sibling branch.
const NavTreeNode = memo(function NavTreeNode({
  item,
  path,
  activeKey,
  onNavigate,
  linkComponent: LinkComponent,
}: NavTreeNodeProps) {
  const Icon = item.icon;
  const current = activeKey === path && path !== '';
  const onActivePath = activeKey !== '' && isOnPath(activeKey, path);
  const parent = hasChildren(item);
  // Expansion is per item. A branch that holds the current page opens itself, also when the page
  // changes later (navigation into it from elsewhere); closing it again stays the user's choice.
  const [open, setOpen] = useState(onActivePath);
  const [openedFor, setOpenedFor] = useState(onActivePath);
  if (onActivePath !== openedFor) {
    setOpenedFor(onActivePath);
    if (onActivePath) setOpen(true);
  }

  const label = <span className={LABEL_CLASSES}>{item.label}</span>;

  if (item.href !== undefined) {
    const currentAttrs = current ? ({ 'aria-current': 'page' } as const) : {};
    const link = (
      <Tooltip content={item.label}>
        <LinkComponent
          href={item.href}
          aria-label={item.label}
          {...currentAttrs}
          data-testid={`nav-tree-item-${item.id}`}
          onClick={onNavigate}
          className={cn(
            ITEM_CLASSES,
            parent ? 'min-w-0 flex-1' : '',
            current ? ACTIVE_ITEM_CLASSES : onActivePath ? ACTIVE_PATH_CLASSES : '',
          )}
        >
          <Icon {...ICON_PROPS} />
          {label}
        </LinkComponent>
      </Tooltip>
    );

    if (!parent) {
      // Leaf: navigation itself carries no transition (D-07/§6.1).
      return <li>{link}</li>;
    }

    // A parent with its own page: the label navigates, a separate disclosure button expands it.
    // In the 64px rail the subtree and its toggle are hidden; the link still navigates.
    return (
      <li>
        <CollapsiblePrimitive.Root open={open} onOpenChange={setOpen}>
          <div className="flex items-center">
            {link}
            <CollapsiblePrimitive.Trigger
              aria-label={`Toggle ${item.label}`}
              data-testid={`nav-tree-toggle-${item.id}`}
              className={TOGGLE_CLASSES}
            >
              <ChevronRight aria-hidden="true" size={16} strokeWidth={1.5} className={CHEVRON_CLASSES} />
            </CollapsiblePrimitive.Trigger>
          </div>
          <CollapsiblePrimitive.Content className={cn(CONTENT_CLASSES, RAIL_HIDDEN_CLASSES)}>
            <NavTreeChildren
              items={item.children}
              path={path}
              activeKey={activeKey}
              onNavigate={onNavigate}
              linkComponent={LinkComponent}
              className={CHILD_LIST_CLASSES}
            />
          </CollapsiblePrimitive.Content>
        </CollapsiblePrimitive.Root>
      </li>
    );
  }

  // Parent without a page of its own: the whole row is the disclosure trigger. In the 64px icon
  // rail its children collapse to this trigger's tooltip, listing the children's labels.
  const flyoutLabel = item.children?.map((child) => child.label).join(', ') ?? item.label;
  return (
    <li>
      <CollapsiblePrimitive.Root open={open} onOpenChange={setOpen}>
        <Tooltip content={flyoutLabel}>
          <CollapsiblePrimitive.Trigger
            aria-label={item.label}
            data-testid={`nav-tree-item-${item.id}`}
            className={cn(TRIGGER_CLASSES, onActivePath ? ACTIVE_PATH_CLASSES : '')}
          >
            <span className="flex min-w-0 items-center gap-3">
              <Icon {...ICON_PROPS} />
              {label}
            </span>
            <ChevronRight aria-hidden="true" size={16} strokeWidth={1.5} className={CHEVRON_CLASSES} />
          </CollapsiblePrimitive.Trigger>
        </Tooltip>
        <CollapsiblePrimitive.Content className={CONTENT_CLASSES}>
          <NavTreeChildren
            items={item.children ?? []}
            path={path}
            activeKey={activeKey}
            onNavigate={onNavigate}
            linkComponent={LinkComponent}
            className={CHILD_LIST_CLASSES}
          />
        </CollapsiblePrimitive.Content>
      </CollapsiblePrimitive.Root>
    </li>
  );
});

// NavTree (D-07, 08-UI-SPEC.md §3) -- generic hierarchical navigation. Today's caller passes
// exactly three flat leaves and this renders visually identical to the flat list it replaces; a
// later caller fills the same component with real nested data purely by passing `items`, never by
// changing this file. No section labels, no inactive/greyed-out items (§9 #8/#19).
export function NavTree({ items, activeHref, onNavigate, linkComponent }: NavTreeProps) {
  // The caller's callback may be a new function every render; memoized nodes get one stable
  // wrapper that always calls the latest.
  const onNavigateRef = useRef(onNavigate);
  useLayoutEffect(() => {
    onNavigateRef.current = onNavigate;
  });
  const handleNavigate = useCallback((): void => {
    onNavigateRef.current?.();
  }, []);
  const activeKey = useMemo(() => activeKeyFor(items, activeHref), [items, activeHref]);
  return (
    <NavTreeChildren
      items={items}
      path=""
      activeKey={activeKey}
      onNavigate={handleNavigate}
      linkComponent={linkComponent}
      className="flex flex-col gap-1"
    />
  );
}
