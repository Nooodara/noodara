// Pure drag-to-dismiss rules for Sheet (UI-06, brief §7.4). No `motion` import here: D19 keeps
// Motion confined to Sheet.tsx, so this module only computes the values Sheet hands to it.

// Brief §7.4 step 6: a release faster than 0.11 px/ms closes regardless of distance. Assumes
// Motion's `info.velocity` is px/s (research Pitfall 3, Assumption A3).
export const DRAG_CLOSE_VELOCITY_PX_PER_S = 110;

// Ceiling on the velocity handed to the closing spring: a near-zero time between the last two
// pointer samples can produce a non-finite velocity that leaves the spring never settling.
export const MAX_HANDOFF_VELOCITY_PX_PER_S = 8000;

// 14-33 (user decision 2026-10-14): overscroll resists progressively, Apple-style rubber band
// `(1 - 1/(x*c/d + 1)) * d` -- slope `c` at the first touch, flattening towards the bound `d`,
// never a hard stop (brief §7.4 step 5). Replaces the linear 0.15 elastic.
export const RUBBER_BAND_COEFFICIENT = 0.55;
export const RUBBER_BAND_LIMIT_PX = 120;

/** Panel displacement for a pull of `pullPx` past the edge (signed, odd, bounded by `limitPx`). */
export function rubberBand(
  pullPx: number,
  limitPx: number = RUBBER_BAND_LIMIT_PX,
  coefficient: number = RUBBER_BAND_COEFFICIENT,
): number {
  const pull = Math.abs(pullPx);
  if (pull === 0) return 0;
  return Math.sign(pullPx) * (1 - 1 / ((pull * coefficient) / limitPx + 1)) * limitPx;
}

// The inverse diverges at the bound; displacements are clamped just short of it.
const INVERSE_CEILING = 0.999;

/** The pull that produces `displacementPx` (inverse of `rubberBand`). */
export function rubberBandInverse(
  displacementPx: number,
  limitPx: number = RUBBER_BAND_LIMIT_PX,
  coefficient: number = RUBBER_BAND_COEFFICIENT,
): number {
  const displacement = Math.min(Math.abs(displacementPx), INVERSE_CEILING * limitPx);
  if (displacement === 0) return 0;
  return Math.sign(displacementPx) * (limitPx / coefficient) * (displacement / (limitPx - displacement));
}

/**
 * `resting`: open (or springing back from a resting pull). `closing`: the release-to-close
 * animation runs. `returning`: springing back to rest after a re-grab mid-close.
 */
export type SheetDragPhase = 'resting' | 'closing' | 'returning';

/**
 * Sheet hands Motion a raw drag value (pointer-driven, 1:1) and renders the panel at this offset.
 * Resting, both sides rubber-band. Closing or returning, the close side is 1:1 so a re-grab
 * tracks the pointer from where the panel sits on screen; past the open edge it still resists.
 */
export function panelOffsetFor(dragPx: number, phase: SheetDragPhase): number {
  return phase !== 'resting' && dragPx > 0 ? dragPx : rubberBand(dragPx);
}

/** Inverse of `panelOffsetFor`: the raw drag value that renders the panel at `panelPx`. */
export function dragOffsetFor(panelPx: number, phase: SheetDragPhase): number {
  return phase !== 'resting' && panelPx > 0 ? panelPx : rubberBandInverse(panelPx);
}

/** The phase for a release that springs back to rest instead of closing. */
export function snapBackPhase(phase: SheetDragPhase): SheetDragPhase {
  return phase === 'resting' ? 'resting' : 'returning';
}

/**
 * A returning panel becomes resting once it is back at or left of rest, where both mappings
 * render the same offset (so the switch never moves it). Closing stays closing until it ends.
 */
export function settledPhase(phase: SheetDragPhase, dragPx: number): SheetDragPhase {
  return phase === 'returning' && dragPx <= 0 ? 'resting' : phase;
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
