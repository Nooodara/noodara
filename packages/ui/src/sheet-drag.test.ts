import { describe, expect, it } from 'vitest';
import {
  DRAG_CLOSE_VELOCITY_PX_PER_S,
  MAX_HANDOFF_VELOCITY_PX_PER_S,
  RUBBER_BAND_COEFFICIENT,
  RUBBER_BAND_LIMIT_PX,
  decidesToClose,
  dragOffsetFor,
  handoffVelocity,
  panelOffsetFor,
  rubberBand,
  rubberBandInverse,
  settledPhase,
  snapBackPhase,
} from './sheet-drag.js';

describe('rubberBand', () => {
  const pulls = [0, 1, 10, 40, 80, 120, 160, 200, 400, 1000, 5000];

  it('does not move the panel without a pull', () => {
    expect(rubberBand(0)).toBe(0);
  });

  it('grows monotonically with the pull', () => {
    for (let i = 1; i < pulls.length; i += 1) {
      expect(rubberBand(pulls[i] ?? 0)).toBeGreaterThan(rubberBand(pulls[i - 1] ?? 0));
    }
  });

  it('is sub-linear: each equal step of pull moves the panel less than the one before', () => {
    const step = 40;
    let previousIncrement = Number.POSITIVE_INFINITY;
    for (let pull = step; pull <= 400; pull += step) {
      const increment = rubberBand(pull) - rubberBand(pull - step);
      expect(increment).toBeLessThan(previousIncrement);
      previousIncrement = increment;
    }
    // Never more than the pull itself, and well short of it once past the first few pixels.
    expect(rubberBand(200)).toBeLessThan(200 * RUBBER_BAND_COEFFICIENT);
  });

  it('is bounded by its limit however far the pointer travels', () => {
    for (const pull of [1e3, 1e5, 1e9]) {
      expect(rubberBand(pull)).toBeLessThan(RUBBER_BAND_LIMIT_PX);
    }
    expect(rubberBand(1e9)).toBeCloseTo(RUBBER_BAND_LIMIT_PX, 3);
  });

  it('starts at the coefficient slope (Apple form (1 - 1/(x*c/d + 1)) * d)', () => {
    expect(rubberBand(0.01) / 0.01).toBeCloseTo(RUBBER_BAND_COEFFICIENT, 3);
    const x = 200;
    const c = RUBBER_BAND_COEFFICIENT;
    const d = RUBBER_BAND_LIMIT_PX;
    expect(rubberBand(x)).toBeCloseTo((1 - 1 / ((x * c) / d + 1)) * d, 10);
  });

  it('resists a leftward pull symmetrically', () => {
    expect(rubberBand(-80)).toBeCloseTo(-rubberBand(80), 10);
  });

  it('uses constants that keep the felt range sensible', () => {
    // Noticeable at the first touch, about half the pull at the close midpoint of a 480px panel.
    expect(rubberBand(40)).toBeGreaterThan(15);
    expect(rubberBand(240)).toBeGreaterThan(50);
    expect(rubberBand(240)).toBeLessThan(80);
  });
});

describe('rubberBandInverse', () => {
  it('round-trips rubberBand', () => {
    for (const pull of [-300, -40, 0, 8, 40, 200, 600]) {
      expect(rubberBandInverse(rubberBand(pull))).toBeCloseTo(pull, 6);
    }
  });

  it('stays finite at or past the limit', () => {
    expect(Number.isFinite(rubberBandInverse(RUBBER_BAND_LIMIT_PX))).toBe(true);
    expect(Number.isFinite(rubberBandInverse(-10 * RUBBER_BAND_LIMIT_PX))).toBe(true);
  });
});

describe('panelOffsetFor / dragOffsetFor', () => {
  it('resists both sides while resting open', () => {
    expect(panelOffsetFor(100, 'resting')).toBe(rubberBand(100));
    expect(panelOffsetFor(-100, 'resting')).toBe(rubberBand(-100));
  });

  it('tracks the closing side 1:1 mid-close (re-grab), still resisting past the open edge', () => {
    expect(panelOffsetFor(300, 'closing')).toBe(300);
    expect(panelOffsetFor(-50, 'closing')).toBe(rubberBand(-50));
  });

  it('is the inverse of panelOffsetFor in each phase, so rebasing never moves the panel', () => {
    for (const phase of ['resting', 'closing', 'returning'] as const) {
      for (const panel of [-30, 0, 8, 60, 100]) {
        expect(panelOffsetFor(dragOffsetFor(panel, phase), phase)).toBeCloseTo(panel, 6);
      }
    }
    expect(dragOffsetFor(300, 'closing')).toBe(300);
  });
});

describe('snapBackPhase / settledPhase', () => {
  it('springs back from a resting pull in the resting phase', () => {
    expect(snapBackPhase('resting')).toBe('resting');
  });

  it('springs back from a re-grab mid-close 1:1, as returning', () => {
    expect(snapBackPhase('closing')).toBe('returning');
    expect(snapBackPhase('returning')).toBe('returning');
    expect(panelOffsetFor(300, 'returning')).toBe(300);
  });

  it('turns a returning panel resting once it is back at or left of rest, where both phases agree', () => {
    expect(settledPhase('returning', 0)).toBe('resting');
    expect(settledPhase('returning', -5)).toBe('resting');
    expect(panelOffsetFor(-5, 'returning')).toBe(panelOffsetFor(-5, 'resting'));
    expect(panelOffsetFor(0, 'returning')).toBe(panelOffsetFor(0, 'resting'));
  });

  it('keeps the phase while the panel is still displaced toward close', () => {
    expect(settledPhase('returning', 12)).toBe('returning');
    expect(settledPhase('resting', 12)).toBe('resting');
  });

  it('never ends a close early, even when the close starts left of rest', () => {
    expect(settledPhase('closing', -20)).toBe('closing');
    expect(settledPhase('closing', 0)).toBe('closing');
  });
});

describe('decidesToClose', () => {
  const width = 480;

  it('closes on a fast release whatever the distance', () => {
    expect(
      decidesToClose(
        { offsetX: 10, velocityX: DRAG_CLOSE_VELOCITY_PX_PER_S + 1, panelX: 2 },
        width,
      ),
    ).toBe(true);
  });

  it('closes on a slow release once the gesture travelled past the midpoint', () => {
    expect(
      decidesToClose({ offsetX: 241, velocityX: 0, panelX: 36 }, width),
    ).toBe(true);
  });

  it('snaps back on a slow, short release', () => {
    expect(
      decidesToClose({ offsetX: 60, velocityX: 50, panelX: 9 }, width),
    ).toBe(false);
  });

  it('closes a slow re-grab released with the panel itself past the midpoint', () => {
    expect(
      decidesToClose({ offsetX: 10, velocityX: 0, panelX: 300 }, width),
    ).toBe(true);
  });

  it('snaps back a slow re-grab released with the panel short of the midpoint', () => {
    expect(
      decidesToClose({ offsetX: 10, velocityX: 0, panelX: 200 }, width),
    ).toBe(false);
  });

  it('never closes on a leftward release', () => {
    expect(
      decidesToClose({ offsetX: -200, velocityX: -900, panelX: 0 }, width),
    ).toBe(false);
  });
});

describe('handoffVelocity', () => {
  it('passes a sane velocity through unchanged', () => {
    expect(handoffVelocity(1200)).toBe(1200);
    expect(handoffVelocity(-300)).toBe(-300);
  });

  it('clamps an extreme velocity to the ceiling, keeping its sign', () => {
    expect(handoffVelocity(1e9)).toBe(MAX_HANDOFF_VELOCITY_PX_PER_S);
    expect(handoffVelocity(-1e9)).toBe(-MAX_HANDOFF_VELOCITY_PX_PER_S);
  });

  it('falls back to the close threshold for a non-finite velocity', () => {
    expect(handoffVelocity(Number.POSITIVE_INFINITY)).toBe(
      DRAG_CLOSE_VELOCITY_PX_PER_S,
    );
    expect(handoffVelocity(Number.NaN)).toBe(DRAG_CLOSE_VELOCITY_PX_PER_S);
  });
});
