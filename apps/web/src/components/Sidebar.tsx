'use client';

// The shell's sidebar (UI-01, 05-UI-SPEC.md SS1) -- exactly three entity items, no v0.2+
// placeholder of any kind (CLAUDE.md SS8), plus a single account menu (D-05) available from every
// authenticated screen (AUTH-03). Three fixed breakpoints: >=1280px shows labels, 900-1279px
// collapses to a 64px icon rail with tooltip labels on hover/focus, and below 900px this renders
// as a bottom sheet controlled by the toolbar's own menu button (`toggleMobileNav`,
// apps/web/src/lib/shell-context.tsx) rather than any state this component owns itself.
//
// 08-08-PLAN.md Task 2 (UI-11, D-05): the old two-control cluster (`ThemeToggle` +
// `SignOutButton`, rendered side by side) is gone -- `AccountMenu` absorbs sign out, and settings
// navigation. `ThemeToggle` is not imported or mounted by this file at all: 08-19-PLAN.md Task 3
// (G3 adjustment round 1, item 5, D-05 change) moved it out of `AccountMenu` too, into an
// Appearance `InsetGroup` on `/settings` (`apps/web/src/components/SettingsGroups.tsx`) -- its
// only mount left in the app.
//
// 13-09: Projects joins as the second peer, a live Project -> Environment -> Service tree built by
// ProjectNav.ts. Services stay live from `service.updated` / `service.deleted` through the same
// synced collection the service lists use; projects and environments come with each snapshot,
// which refetches on stream (re)open, on the projects-changed bus, and once per unknown
// environment. Deleting the service the user is viewing moves them to its project with a notice.
import { History, Server, Settings } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
import { AccountMenu, cn, NavTree, Notice, type NavTreeItem } from '@noodara/ui';
import { Lockup, Logo } from '@noodara/ui';
import { SignOutButton } from './SignOutButton';
import { useSessionUser } from '../lib/session-user';
import { useShellContext } from '../lib/shell-context';
import { createSyncedCollection, serviceWriteFromEvent } from '../lib/deploy-store';
import { listEnvironments, listProjects, listServices, type ServiceView } from '../lib/deploy-api';
import type { DeployEntityEvent } from '../lib/server-events';
import {
  buildProjectNav,
  EMPTY_PROJECT_NAV,
  loadProjectNavData,
  projectHref,
  serviceRouteOf,
  shareStructure,
  subscribeProjectsChanged,
  type ProjectNavData,
} from './ProjectNav';

export interface SidebarProps {
  readonly open: boolean;
  readonly onClose: () => void;
}

// The three flat leaves NavTree renders today (D-07) -- unchanged labels/hrefs/icons from the
// hand-written list this replaces. A future caller fills the same NavTree with real hierarchical
// data purely by changing this array's shape, never by touching NavTree.tsx itself.
const SERVERS_ITEM: NavTreeItem = { id: 'servers', label: 'Servers', href: '/servers', icon: Server };
const ACTIVITY_ITEM: NavTreeItem = { id: 'activity', label: 'Activity', href: '/activity', icon: History };
const SETTINGS_ITEM: NavTreeItem = { id: 'settings', label: 'Settings', href: '/settings', icon: Settings };

const NO_EVENTS = (): (() => void) => () => undefined;

/** The Projects item, kept live. Unchanged branches keep their identity (shareStructure), so
 *  NavTree re-renders only the path to a changed node. */
function useProjectNavTree(pathname: string | null, onActiveServiceDeleted: (projectId: string) => void): NavTreeItem {
  const shell = useShellContext();
  const subscribeDeploy = shell.subscribeDeploy ?? NO_EVENTS;
  const { registerResync } = shell;
  const [tree, setTree] = useState<NavTreeItem>(() => buildProjectNav(EMPTY_PROJECT_NAV));
  const deletedRef = useRef(onActiveServiceDeleted);
  const pathnameRef = useRef(pathname);
  useEffect(() => {
    deletedRef.current = onActiveServiceDeleted;
    pathnameRef.current = pathname;
  });

  useEffect(() => {
    let structure: ProjectNavData<ServiceView> = EMPTY_PROJECT_NAV as ProjectNavData<ServiceView>;
    const requestedEnvironments = new Set<string>();
    const publish = (services: readonly ServiceView[]): void => {
      const next = buildProjectNav({ ...structure, services });
      setTree((prev) => shareStructure(prev, next));
    };
    const collection = createSyncedCollection<ServiceView>({
      load: async () => {
        const data = await loadProjectNavData<ServiceView>({ listProjects, listEnvironments, listServices });
        if (data === null) return null;
        structure = data;
        return data.services;
      },
      toWrite: (event) => serviceWriteFromEvent<ServiceView>(event),
      onChange: (services) => {
        publish(services);
        // A service in an environment this snapshot did not have (created since): one refetch.
        const known = new Set(structure.environments.map((environment) => environment.id));
        const unknown = services.find(
          (service) => !known.has(service.environmentId) && !requestedEnvironments.has(service.environmentId),
        );
        if (unknown !== undefined) {
          requestedEnvironments.add(unknown.environmentId);
          void collection.refetch();
        }
      },
    });
    const onEvent = (event: DeployEntityEvent): void => {
      collection.handleEvent(event);
      if (event.type === 'service.deleted') {
        const route = serviceRouteOf(pathnameRef.current);
        if (route !== null && route.serviceId === event.id) deletedRef.current(route.projectId);
      }
    };
    const offEvents = subscribeDeploy(onEvent);
    const offResync = registerResync(() => {
      void collection.refetch();
    });
    const offProjects = subscribeProjectsChanged(() => {
      void collection.refetch();
    });
    void collection.refetch();
    return () => {
      offEvents();
      offResync();
      offProjects();
      collection.dispose();
    };
  }, [subscribeDeploy, registerResync]);

  return tree;
}
// The brand slot (BRAND-02, D-04): the monogram alone in the 64px rail, the horizontal lockup in
// the expanded sidebar, and NO mark at all in the below-900px bottom sheet -- the sheet is a
// temporary navigation overlay, not the product's chrome. Both marks are always in the DOM and one
// is hidden per breakpoint, riding the same two thresholds the nav items already use
// (`min-[900px]` for the rail, `min-[1280px]` for the expanded state, inverted here exactly as
// LABEL_CLASSES inverts them). Height 44px (`h-11`) and `px-3` line the mark up with the nav items
// above the 8px grid; `text-ink` is what the mark's own `currentColor` inherits -- never the
// accent utility class, since the single action colour is reserved for actions and states (D-09).
// (Named descriptively rather than literally, following 07-03's own precedent, so this plan's
// "no second brand colour anywhere in this file" grep stays exact.)
const BRAND_RAIL_CLASSES = 'mb-3 hidden h-11 items-center px-3 text-ink min-[900px]:flex min-[1280px]:hidden';
const BRAND_EXPANDED_CLASSES = 'mb-3 hidden h-11 items-center px-3 text-ink min-[1280px]:flex';

export function Sidebar({ open, onClose }: SidebarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const sessionUser = useSessionUser();
  const [serviceGone, setServiceGone] = useState(false);
  const projectsItem = useProjectNavTree(pathname, (projectId) => {
    setServiceGone(true);
    router.replace(projectHref(projectId));
  });
  const items = useMemo(() => [SERVERS_ITEM, projectsItem, ACTIVITY_ITEM, SETTINGS_ITEM], [projectsItem]);

  return (
    <>
      {open ? (
        // Mobile scrim -- closing the bottom sheet on an outside tap/click, hidden from >=900px
        // where the sidebar is never a sheet.
        <div
          aria-hidden="true"
          data-testid="shell-sidebar-scrim"
          onClick={onClose}
          className="fixed inset-0 z-40 bg-black/40 min-[900px]:hidden"
        />
      ) : null}
      <nav
        aria-label="Primary"
        data-testid="shell-sidebar"
        className={cn(
          // Below 900px this is a temporary bottom-sheet overlay, not permanent chrome -- it
          // keeps its own opaque surface and top border so it still reads as a sheet over the
          // content behind it (D-03).
          'fixed inset-x-0 bottom-0 z-50 flex-col gap-1 border-t border-hairline bg-surface-1 p-4',
          // >=900px: the chrome retreats and fuses with the page's own canvas (D-03) -- no right
          // edge border of its own; separation comes from spacing and the InsetGroup blocks' own
          // hairline borders in the content column.
          //
          // 08-19-PLAN.md Task 3 (G3 adjustment round 1, item 2): `static` (the shell's flex row
          // stretches this element to `h-screen` only as an *initial* height) let the sidebar
          // scroll away with the page the moment `main`'s own content grew taller than the
          // viewport -- `sticky top-0` pins it to the viewport instead, `h-screen` now bounding
          // its own permanently-visible height rather than a one-time layout measurement.
          'min-[900px]:sticky min-[900px]:top-0 min-[900px]:inset-auto min-[900px]:z-auto min-[900px]:h-screen min-[900px]:w-16 min-[900px]:shrink-0 min-[900px]:border-t-0 min-[900px]:bg-canvas min-[900px]:p-3',
          'min-[1280px]:w-60',
          open ? 'flex' : 'hidden min-[900px]:flex',
        )}
      >
        <div className={BRAND_RAIL_CLASSES}>
          <Logo title="Noodara" size={24} data-testid="brand-monogram" />
        </div>
        <div className={BRAND_EXPANDED_CLASSES}>
          <Lockup title="Noodara" height={20} data-testid="brand-lockup" />
        </div>
        <NavTree items={items} activeHref={pathname} onNavigate={onClose} linkComponent={Link} />
        <div className="mt-auto border-t border-hairline pt-1">
          <AccountMenu
            name={sessionUser?.name ?? ''}
            email={sessionUser?.email ?? ''}
            settingsHref="/settings"
            linkComponent={Link}
            signOutSlot={<SignOutButton />}
          />
        </div>
      </nav>
      {serviceGone ? (
        <div className="fixed bottom-4 right-4 z-50 w-[min(22rem,calc(100vw-2rem))]">
          <Notice
            data-testid="sidebar-service-deleted"
            message="This service was deleted. You are now viewing its project."
            onDismiss={() => {
              setServiceGone(false);
            }}
          />
        </div>
      ) : null}
    </>
  );
}
