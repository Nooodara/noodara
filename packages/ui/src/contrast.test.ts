import { describe, expect, it } from 'vitest';
import {
  auditTheme,
  compositeOver,
  contrastRatio,
  parseColor,
  parseTokensCss,
  relativeLuminance,
  roundDown,
  toHex,
} from './contrast.js';

// Reference-value tests (05-33-PLAN.md Task 1): these pin the WCAG 2.x relative-luminance and
// contrast-ratio implementation against known, independently-verifiable answers before it is ever
// pointed at a real token. This is a new pure module with no prior behaviour to regress against,
// so green-from-the-start here is acceptable (the plan's own RED that matters is Task 3's
// exhaustive gate assertion over the current, still-failing token values).
describe('relativeLuminance', () => {
  it('white is 1', () => {
    expect(relativeLuminance('#ffffff')).toBe(1);
  });

  it('black is 0', () => {
    expect(relativeLuminance('#000000')).toBe(0);
  });
});

describe('contrastRatio', () => {
  it('white on white is 1.00', () => {
    expect(roundDown(contrastRatio('#ffffff', '#ffffff'))).toBe(1);
  });

  it('black on white is 21.00', () => {
    expect(roundDown(contrastRatio('#000000', '#ffffff'))).toBe(21);
  });

  it('#767676 on white is approximately 4.54 (passes AA)', () => {
    const ratio = contrastRatio('#767676', '#ffffff');
    expect(ratio).toBeCloseTo(4.5422, 3);
    expect(roundDown(ratio)).toBe(4.54);
    expect(ratio >= 4.5).toBe(true);
  });

  it('#777777 on white is approximately 4.48 (fails AA)', () => {
    const ratio = contrastRatio('#777777', '#ffffff');
    expect(ratio).toBeCloseTo(4.4781, 3);
    expect(roundDown(ratio)).toBe(4.47);
    expect(ratio >= 4.5).toBe(false);
  });

  it('is order-independent', () => {
    expect(contrastRatio('#767676', '#ffffff')).toBe(contrastRatio('#ffffff', '#767676'));
  });
});

describe('roundDown', () => {
  it('truncates rather than rounds -- 4.496 reports as 4.49, never 4.5', () => {
    expect(roundDown(4.496)).toBe(4.49);
  });

  it('does not round a clean value up', () => {
    expect(roundDown(4.5)).toBe(4.5);
  });
});

describe('parseColor', () => {
  it('parses a 6-digit hex colour as fully opaque', () => {
    expect(parseColor('#ff3b30')).toEqual({ r: 255, g: 59, b: 48, a: 1 });
  });

  it('parses a 3-digit hex colour by doubling each digit', () => {
    expect(parseColor('#f00')).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it('parses rgba() with an explicit alpha', () => {
    expect(parseColor('rgba(255, 59, 48, 0.14)')).toEqual({ r: 255, g: 59, b: 48, a: 0.14 });
  });

  it('parses rgb() with no alpha as fully opaque', () => {
    expect(parseColor('rgb(0, 113, 227)')).toEqual({ r: 0, g: 113, b: 227, a: 1 });
  });

  it('throws on an unrecognised colour string', () => {
    expect(() => parseColor('hsl(0, 0%, 0%)')).toThrow('unrecognised colour value');
  });
});

describe('compositeOver', () => {
  // Hand-computed case: rgba(255,0,0,0.5) over opaque white. Per channel:
  //   r = 255*0.5 + 255*0.5 = 255
  //   g =   0*0.5 + 255*0.5 = 127.5 -> rounds to 128 (round-half-up)
  //   b =   0*0.5 + 255*0.5 = 127.5 -> rounds to 128
  it('alpha-composites a translucent foreground over an opaque background (hand-computed)', () => {
    const composited = compositeOver('rgba(255, 0, 0, 0.5)', '#ffffff');
    expect(composited).toEqual({ r: 255, g: 127.5, b: 127.5 });
    expect(toHex(composited)).toBe('#ff8080');
  });

  it('a fully opaque foreground composites to itself regardless of the background', () => {
    expect(toHex(compositeOver('#123456', '#ffffff'))).toBe('#123456');
  });

  it('a fully transparent foreground composites to the background', () => {
    expect(toHex(compositeOver('rgba(0, 0, 0, 0)', '#0071e3'))).toBe('#0071e3');
  });
});

describe('parseTokensCss', () => {
  const FIXTURE_CSS = `
    :root {
      --canvas: #f5f5f7;
      --surface-1: #ffffff;
      --accent: #0071e3;
      --status-ok: #34c759;
      --status-ok-soft: rgba(52, 199, 89, 0.14);
    }
    [data-theme="dark"] {
      --canvas: #161618;
      --surface-1: #1d1d1f;
      --accent: #2997ff;
      --status-ok: #30d158;
      --status-ok-soft: rgba(48, 209, 88, 0.14);
    }
  `;

  it('parses the :root block as the light theme and the [data-theme="dark"] block as dark', () => {
    const tokens = parseTokensCss(FIXTURE_CSS);
    expect(tokens.light.accent).toBe('#0071e3');
    expect(tokens.dark.accent).toBe('#2997ff');
    expect(tokens.light['status-ok-soft']).toBe('rgba(52, 199, 89, 0.14)');
  });

  it('throws when no :root block is present', () => {
    expect(() => parseTokensCss('[data-theme="dark"] { --accent: #fff; }')).toThrow(':root');
  });

  it('throws when no [data-theme="dark"] block is present', () => {
    expect(() => parseTokensCss(':root { --accent: #fff; }')).toThrow('dark');
  });
});

describe('auditTheme', () => {
  it('derives the status pair list from parsed token names, not a hardcoded list', () => {
    const tokens = {
      'surface-1': '#ffffff',
      accent: '#0071e3',
      'on-accent': '#ffffff',
      'status-ok': '#34c759',
      'status-ok-soft': 'rgba(52, 199, 89, 0.14)',
      // A made-up status token with no corresponding audit entry written anywhere -- proves the
      // pair list comes from a runtime scan, since this test never names "status-newthing".
      'status-newthing': '#ff00ff',
      'status-newthing-soft': 'rgba(255, 0, 255, 0.14)',
    };

    const results = auditTheme(tokens, 'light');
    const labels = results.map((r) => r.label);

    expect(labels).toContain('--status-ok on --status-ok-soft over --surface-1');
    expect(labels).toContain('--status-newthing on --status-newthing-soft over --surface-1');
  });

  it('never audits a -soft token as if it were itself a foreground status colour', () => {
    const tokens = {
      'surface-1': '#ffffff',
      'status-ok': '#34c759',
      'status-ok-soft': 'rgba(52, 199, 89, 0.14)',
    };

    const results = auditTheme(tokens, 'light');
    const labels = results.map((r) => r.label);

    expect(labels.some((label) => label.startsWith('--status-ok-soft on'))).toBe(false);
  });
});
