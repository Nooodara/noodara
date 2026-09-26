import { describe, expect, it } from 'vitest';
import { PRESS_CLASSES } from './press.js';

// Contract test for the one press-feedback definition in the system (UI-05/UI-10,
// 08-UI-SPEC.md §7.1/§7.2, docs/ui-build-prompt.md §7.3/§9 #9/#11). This pins the shape of the
// exported class string itself -- Button.test.tsx/ListRow.test.tsx assert it actually renders on
// the real DOM elements that compose it in.
describe('PRESS_CLASSES', () => {
  const tokens = PRESS_CLASSES.split(/\s+/).filter(Boolean);

  it('never uses transition-all', () => {
    expect(tokens.some((token) => token.includes('transition-all'))).toBe(false);
  });

  it('names transform explicitly in its transition, at 160ms with --ease-out, gated motion-safe', () => {
    expect(tokens).toContain('motion-safe:transition-[transform]');
    expect(tokens.some((token) => token.startsWith('motion-safe:') && token.includes('duration-[160ms]'))).toBe(
      true,
    );
    expect(
      tokens.some((token) => token.startsWith('motion-safe:') && token.includes('ease-[var(--ease-out)]')),
    ).toBe(true);
  });

  it('scales to 0.97 on :active, gated motion-safe', () => {
    expect(
      tokens.some(
        (token) => token.startsWith('motion-safe:active:') && token.includes('scale-[0.97]'),
      ),
    ).toBe(true);
  });

  it('dims opacity instead of scaling under prefers-reduced-motion, with no transform token', () => {
    const motionReduceTokens = tokens.filter((token) => token.startsWith('motion-reduce:'));
    expect(motionReduceTokens.length).toBeGreaterThan(0);
    expect(motionReduceTokens.some((token) => token.includes('active:opacity-'))).toBe(true);
    expect(motionReduceTokens.some((token) => token.includes('scale') || token.includes('transform'))).toBe(false);
  });

  it('suppresses both the scale and the dim on a disabled control', () => {
    expect(
      tokens.some((token) => token.startsWith('disabled:active:') && token.includes('scale-100')),
    ).toBe(true);
    expect(
      tokens.some((token) => token.startsWith('disabled:active:') && token.includes('opacity-100')),
    ).toBe(true);
  });
});
