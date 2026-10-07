// Pure drag-to-dismiss rules for Sheet (UI-06, brief §7.4). No `motion` import here: D19 keeps
// Motion confined to Sheet.tsx, so this module only computes the values Sheet hands to it.

// Brief §7.4 step 6: a release faster than 0.11 px/ms closes regardless of distance. Assumes
// Motion's `info.velocity` is px/s (research Pitfall 3, Assumption A3).
export const DRAG_CLOSE_VELOCITY_PX_PER_S = 110;

// Ceiling on the velocity handed to the closing spring: a near-zero time between the last two
// pointer samples can produce a non-finite velocity that leaves the spring never settling.
export const MAX_HANDOFF_VELOCITY_PX_PER_S = 8000;

// Resistance while the panel is open: progressive, never a hard stop (brief §7.4 step 5).
export const DRAG_ELASTIC_AT_REST = 0.15;

/** `resting`: open, or springing back open. `closing`: the release-to-close animation runs. */
export type SheetDragPhase = 'resting' | 'closing';

export type SheetDragElastic =
  number | { readonly left: number; readonly right: number };

/**
 * Motion's `dragElastic` for the drag surface. Motion takes the value at grab time as the drag
 * origin and applies the elastic to the absolute position (`0 + elastic * (origin + offset)` past
 * the `{0, 0}` constraints). At rest that is the resistance curve; mid-close it would pull a
 * panel grabbed at 300px back to ~45px. While closing, the right side is therefore unconstrained
 * (elastic 1), so a re-grab tracks the pointer 1:1 from where the panel sits on screen.
 */
export function dragElasticFor(phase: SheetDragPhase): SheetDragElastic {
  return phase === 'closing'
    ? { left: DRAG_ELASTIC_AT_REST, right: 1 }
    : DRAG_ELASTIC_AT_REST;
}

export interface SheetDragRelease {
  /** Pointer travel of this gesture, px. */
  readonly offsetX: number;
  /** Release velocity, px/s. */
  readonly velocityX: number;
  /** The panel's on-screen displacement at release, px. */
  readonly panelX: number;
}

/**
 * Release decision: velocity first (brief §7.4 step 6), then midpoint-snap on whichever is further,
 * the gesture's own travel or the panel's on-screen position (a re-grab mid-close starts with a
 * small offset but a panel already past the midpoint).
 */
export function decidesToClose(
  release: SheetDragRelease,
  panelWidthPx: number,
): boolean {
  return (
    release.velocityX > DRAG_CLOSE_VELOCITY_PX_PER_S ||
    Math.max(release.offsetX, release.panelX) > panelWidthPx / 2
  );
}

/** The release velocity clamped to a finite, sane range for the closing spring. */
export function handoffVelocity(velocityX: number): number {
  if (!Number.isFinite(velocityX)) return DRAG_CLOSE_VELOCITY_PX_PER_S;
  return (
    Math.sign(velocityX) *
    Math.min(Math.abs(velocityX), MAX_HANDOFF_VELOCITY_PX_PER_S)
  );
}
