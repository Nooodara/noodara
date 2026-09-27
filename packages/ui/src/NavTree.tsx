import { type ComponentType, type ReactNode } from 'react';
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
  'flex h-[var(--row-height)] items-center gap-3 rounded-sm px-3 text-callout font-medium text-ink-secondary hover:bg-surface-2',
  PRESS_CLASSES,
);
const ACTIVE_ITEM_CLASSES = 'bg-accent-soft text-ink';
// Mobile round 1 adjustment (09-14 checkpoint): the label is visible by default (the <900px
// bottom-sheet drawer, D-03) and at >=1280px (the expanded sidebar) -- it is hidden only in the
// 900-1279px icon rail, where the tooltip on the trigger itself carries the label instead. The
// previous `hidden min-[1280px]:inline` silently hid the label everywhere below 1280px, including
// the drawer where it was never meant to be hidden.
const LABEL_CLASSES = 'inline min-[900px]:hidden min-[1280px]:inline';
const ICON_PROPS = { 'aria-hidden': true, size: 20, strokeWidth: 1.5 } as const;

const TRIGGER_CLASSES = cn(ITEM_CLASSES, 'w-full justify-between');

// Same grid-template-rows-transition technique as Disclosure.tsx's CONTENT_CLASSES -- never an
// animated `height` (§9 #11) -- gated by `motion-safe:` so `prefers-reduced-motion` collapses it
// to an instant toggle, matching every other Disclosure-based expand/collapse in this system.
const CHEVRON_CLASSES = cn(
  'h-4 w-4 shrink-0 text-ink-secondary motion-safe:transition-transform motion-safe:duration-[var(--duration-micro)]',
  'group-data-[state=open]:rotate-90',
);
// 08-14-PLAN.md Task 2: reuses Disclosure.tsx's own exported grid-template-rows class constant
// rather than keeping a near-copy -- both expand/collapse disclosures now share exactly one
// expression for this technique.
const CONTENT_CLASSES = DISCLOSURE_CONTENT_CLASSES;

/** Narrows `T | undefined` to `T` once the caller has already guaranteed the value is present --
 *  same precedent as `packages/ui/src/contrast.ts`'s own `assertDefined`. Needed once, below, for
 *  a leaf's `href`: `hasDestination` already guarantees a childless item carries one, but that
 *  guarantee does not survive the `.filter().map()` boundary for the type checker. */
function assertDefined<T>(value: T | undefined): T {
  return value as T;
}

function isActive(activeHref: string, href: string): boolean {
  return activeHref === href || activeHref.startsWith(`${href}/`);
}

/** A leaf with no destination is never rendered at all -- never rendered in an inactive state (§9 #8/#19). */
function hasDestination(item: NavTreeItem): boolean {
  return item.href !== undefined || (item.children !== undefined && item.children.length > 0);
}

interface RenderItemsArgs {
  readonly items: readonly NavTreeItem[];
  readonly activeHref: string;
  /** Always a real function by the time it reaches here -- `NavTree` itself defaults an absent
   *  `onNavigate` to a no-op, so this never carries an explicit `undefined` down into a JSX prop
   *  the link component declares as merely optional (exactOptionalPropertyTypes: an optional
   *  prop's declared type and a required-but-possibly-undefined value are not interchangeable). */
  readonly onNavigate: () => void;
  readonly linkComponent: ComponentType<NavTreeLinkProps>;
}

function renderItems({
  items,
  activeHref,
  onNavigate,
  linkComponent: LinkComponent,
}: RenderItemsArgs): ReactNode {
  return items.filter(hasDestination).map((item) => {
    const Icon = item.icon;

    if (item.children === undefined || item.children.length === 0) {
      // Leaf: identical to Sidebar.tsx's current <li><Tooltip><Link>...</Link></Tooltip></li> --
      // navigation itself carries no transition (D-07/§6.1); only a parent's own disclosure
      // (below) ever animates.
      const href = assertDefined(item.href);
      // Built as a spread rather than an inline `aria-current={... ? 'page' : undefined}` so the
      // attribute key is omitted entirely on an inactive leaf, never present-but-`undefined` --
      // `NavTreeLinkProps['aria-current']` is optional, not a union with `undefined`
      // (exactOptionalPropertyTypes distinguishes the two).
      const currentAttrs = isActive(activeHref, href) ? ({ 'aria-current': 'page' } as const) : {};
      return (
        <li key={item.id}>
          <Tooltip content={item.label}>
            <LinkComponent
              href={href}
              aria-label={item.label}
              {...currentAttrs}
              data-testid={`nav-tree-item-${item.id}`}
              onClick={onNavigate}
              className={cn(ITEM_CLASSES, isActive(activeHref, href) ? ACTIVE_ITEM_CLASSES : '')}
            >
              <Icon {...ICON_PROPS} />
              <span className={LABEL_CLASSES}>{item.label}</span>
            </LinkComponent>
          </Tooltip>
        </li>
      );
    }

    // Parent: expand/collapse via CollapsiblePrimitive -- `aria-expanded` supplied entirely by
    // the primitive, expansion state held per item since each Root instance owns its own
    // uncontrolled open state (expanding one never touches a sibling's). In the 64px icon rail a
    // parent's children collapse to this same trigger's hover/focus tooltip, listing the
    // children's own labels -- not exercised by today's three flat leaves, but the shape must
    // exist so a later caller can hand this component a real subtree without a rewrite.
    const children = item.children;
    const flyoutLabel = children.map((child) => child.label).join(', ');
    return (
      <li key={item.id}>
        <CollapsiblePrimitive.Root className="group">
          <Tooltip content={flyoutLabel}>
            <CollapsiblePrimitive.Trigger
              aria-label={item.label}
              data-testid={`nav-tree-item-${item.id}`}
              className={TRIGGER_CLASSES}
            >
              <span className="flex items-center gap-3">
                <Icon {...ICON_PROPS} />
                <span className={LABEL_CLASSES}>{item.label}</span>
              </span>
              <ChevronRight
                aria-hidden="true"
                size={16}
                strokeWidth={1.5}
                className={CHEVRON_CLASSES}
              />
            </CollapsiblePrimitive.Trigger>
          </Tooltip>
          <CollapsiblePrimitive.Content className={CONTENT_CLASSES}>
            <ul className={cn(DISCLOSURE_INNER_CLASSES, 'flex flex-col gap-1 pl-6')}>
              {renderItems({
                items: children,
                activeHref,
                onNavigate,
                linkComponent: LinkComponent,
              })}
            </ul>
          </CollapsiblePrimitive.Content>
        </CollapsiblePrimitive.Root>
      </li>
    );
  });
}

// NavTree (D-07, 08-UI-SPEC.md §3) -- generic hierarchical navigation. Today's caller passes
// exactly three flat leaves and this renders visually identical to the flat list it replaces; a
// later caller fills the same component with real nested data purely by passing `items`, never by
// changing this file. No section labels, no inactive/greyed-out items (§9 #8/#19).
export function NavTree({ items, activeHref, onNavigate, linkComponent }: NavTreeProps) {
  const handleNavigate = onNavigate ?? ((): void => undefined);
  return (
    <ul className="flex flex-col gap-1">
      {renderItems({
        items,
        activeHref,
        onNavigate: handleNavigate,
        linkComponent,
      })}
    </ul>
  );
}
