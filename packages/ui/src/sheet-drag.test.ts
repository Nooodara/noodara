import { describe, expect, it } from 'vitest';
import {
  DRAG_CLOSE_VELOCITY_PX_PER_S,
  DRAG_ELASTIC_AT_REST,
  MAX_HANDOFF_VELOCITY_PX_PER_S,
  decidesToClose,
  dragElasticFor,
  handoffVelocity,
} from './sheet-drag.js';

describe('dragElasticFor', () => {
  it('resists on both sides while the sheet is resting open', () => {
    expect(dragElasticFor('resting')).toBe(DRAG_ELASTIC_AT_REST);
  });

  it('leaves the closing side unconstrained mid-close so a re-grab tracks 1:1, keeping resistance past the open edge', () => {
    expect(dragElasticFor('closing')).toEqual({
      left: DRAG_ELASTIC_AT_REST,
      right: 1,
    });
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
