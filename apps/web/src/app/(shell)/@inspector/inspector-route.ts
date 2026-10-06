// 13-14: what the `@inspector` slot shows comes from the route (H3): `?deployment=<id>` opens that
// deployment's build log, `?logs=runtime` opens the service's runtime logs, nothing selected keeps
// the slot empty (zero width, as in Phase 8). Links carry only the query, so they keep the current
// service path.
import { cn } from '@noodara/ui';
import { isRoutableId } from '../../../components/ProjectNav';

export const DEPLOYMENT_PARAM = 'deployment';
export const LOGS_PARAM = 'logs';

export type InspectorSelection =
  | { readonly kind: 'deployment'; readonly deploymentId: string }
  | { readonly kind: 'runtime' }
  | { readonly kind: 'not-found' };

export function inspectorSelection(
  params: Pick<URLSearchParams, 'get'>,
): InspectorSelection | null {
  const deploymentId = params.get(DEPLOYMENT_PARAM);
  if (deploymentId !== null) {
    return isRoutableId(deploymentId)
      ? { kind: 'deployment', deploymentId }
      : { kind: 'not-found' };
  }
  if (params.get(LOGS_PARAM) === 'runtime') return { kind: 'runtime' };
  return null;
}

export function deploymentInspectorHref(deploymentId: string): string {
  return `?${DEPLOYMENT_PARAM}=${encodeURIComponent(deploymentId)}`;
}

export const RUNTIME_LOGS_INSPECTOR_HREF = `?${LOGS_PARAM}=runtime`;

/** The shell's `<aside>` around the slot. `w-0 border-0` unconditionally keeps an empty slot free
 *  at every viewport; `has-[>*]:` (the rendered DOM, not a JS boolean) sizes a populated one:
 *  >=1280px an in-flow 384px column; 640-1279px a fixed 384px right-edge panel; <640px a
 *  full-height, full-width sheet. Solid surface, no overlay, no shadow (Phase 8 D-08). */
export const INSPECTOR_SLOT_CLASSES = cn(
  'w-0 border-0',
  'has-[>*]:min-[1280px]:w-[384px]',
  'has-[>*]:max-[1279px]:fixed has-[>*]:max-[1279px]:inset-y-0 has-[>*]:max-[1279px]:right-0 has-[>*]:max-[1279px]:z-40 has-[>*]:max-[1279px]:bg-surface-elevated',
  'has-[>*]:min-[640px]:max-[1279px]:w-[384px] has-[>*]:min-[640px]:max-[1279px]:border-l has-[>*]:min-[640px]:max-[1279px]:border-hairline',
  'has-[>*]:max-[639px]:w-full has-[>*]:max-[639px]:left-0',
);
