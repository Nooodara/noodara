import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  auditTheme,
  auditTokens,
  compositeOver,
  contrastRatio,
  parseColor,
  parseTokensCss,
  relativeLuminance,
  roundDown,
  toHex,
  type AuditPair,
} from './contrast.js';

// The real, on-disk stylesheet -- read once per test-file run so every assertion below measures
// whatever is actually in `tokens.css` at the moment the suite runs, never a hand-copied snapshot
// (05-33-PLAN.md key_links: "parsing the literal token values out of the stylesheet, not a
// duplicated copy of them"). A token edit on disk is therefore what a re-run of this suite
// measures -- exactly the property that makes this an enforceable regression gate, not a one-off
// audit (T-5G-33-02).
const TOKENS_CSS_PATH = new URL('../tokens.css', import.meta.url);
function readRealTokens() {
  return parseTokensCss(readFileSync(TOKENS_CSS_PATH, 'utf8'));
}

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

  // D1 (05-33 continuation, 2026-09-20): the `-text` variant is derived the same
  // derive-don't-hardcode way as the base status token, and audited against every real
  // StatusPill background, not only --surface-1.
  it('derives the status-*-text pair list from parsed token names, on every real pill background', () => {
    const tokens = {
      canvas: '#f5f5f7',
      'surface-1': '#ffffff',
      'surface-2': '#fafafc',
      'status-newthing': '#ff00ff',
      'status-newthing-soft': 'rgba(255, 0, 255, 0.14)',
      'status-newthing-text': '#7a0d5f',
    };

    const results = auditTheme(tokens, 'light');
    const labels = results.map((r) => r.label);

    expect(labels).toContain('--status-newthing-text on --status-newthing-soft over --surface-1');
    expect(labels).toContain('--status-newthing-text on --status-newthing-soft over --canvas');
    expect(labels).toContain('--status-newthing-text on --status-newthing-soft over --surface-2');
  });

  it('audits --accent as both text (4.5) and outline/border (3.0) verdicts on the same pair', () => {
    const tokens = { accent: '#0071e3', canvas: '#f5f5f7', 'surface-1': '#ffffff' };

    const results = auditTheme(tokens, 'light');
    const textPair = results.find((r) => r.label === '--accent as text on --surface-1');
    const outlinePair = results.find((r) => r.label === '--accent as outline/border on --surface-1');

    expect(textPair?.threshold).toBe(4.5);
    expect(outlinePair?.threshold).toBe(3);
    // Same underlying ratio, two different bars -- a value that clears 3.0 but not 4.5 must fail
    // the text verdict while passing the outline verdict (this is exactly what let the rejected
    // Candidate A look safe when only the fill pair was checked).
    expect(textPair?.ratio).toBe(outlinePair?.ratio);
  });

  it('audits --on-accent on --accent-fill as its own pair, independent of --accent', () => {
    const tokens = { 'on-accent': '#ffffff', accent: '#2997ff', 'accent-fill': '#0071e3' };

    const results = auditTheme(tokens, 'dark');
    const fillPair = results.find((r) => r.label === '--on-accent on --accent-fill');
    const accentPair = results.find((r) => r.label === '--on-accent on --accent');

    expect(fillPair).toBeDefined();
    expect(accentPair).toBeDefined();
    expect(fillPair?.backgroundEffective).toBe('#0071e3');
    expect(accentPair?.backgroundEffective).toBe('#2997ff');
  });

  // D4 (05-45, 2026-09-20): `--accent-text` is link text ONLY -- unlike `--accent`, which doubles
  // as outline/border foreground (the dual-verdict case above), this token has no second role.
  it('audits --accent-text as a text-only pair on every surface, with no outline/border verdict', () => {
    const tokens = {
      'accent-text': '#0066cc',
      canvas: '#f5f5f7',
      'surface-1': '#ffffff',
      'surface-2': '#fafafc',
      'surface-3': '#f0f0f2',
    };

    const results = auditTheme(tokens, 'light');
    const textPairs = results.filter((r) => r.label.startsWith('--accent-text as link text on'));

    expect(textPairs).toHaveLength(4);
    for (const pair of textPairs) {
      expect(pair.threshold).toBe(4.5);
    }
    expect(results.some((r) => r.label.includes('accent-text') && r.label.includes('outline'))).toBe(false);
  });

  // D5 (05-45, 2026-09-20): any `status-<tone>-fill` token is audited the same way `accent-fill`
  // already is -- `--on-accent` on top of it, derived from parsed names, not hardcoded to `error`.
  it('derives an --on-accent on --status-<tone>-fill pair from a made-up fill token name', () => {
    const tokens = { 'on-accent': '#ffffff', 'status-newthing-fill': '#d70015' };

    const results = auditTheme(tokens, 'light');
    const pair = results.find((r) => r.label === '--on-accent on --status-newthing-fill');

    expect(pair).toBeDefined();
    expect(pair?.threshold).toBe(4.5);
    expect(pair?.backgroundEffective).toBe('#d70015');
  });

  it('never treats a -fill token as a base --status-* foreground (STATUS_TOKEN_RE exclusion)', () => {
    const tokens = {
      'on-accent': '#ffffff',
      'surface-1': '#ffffff',
      'status-newthing-fill': '#d70015',
      // A fictitious -soft sibling for the fill token itself -- if STATUS_TOKEN_RE mistakenly
      // matched `status-newthing-fill` as a base status token, this would produce a spurious
      // "--status-newthing-fill on --status-newthing-fill-soft over --surface-1" pair.
      'status-newthing-fill-soft': 'rgba(215, 0, 21, 0.14)',
    };

    const results = auditTheme(tokens, 'light');

    expect(results.some((r) => r.label.startsWith('--status-newthing-fill on --status-newthing-fill-soft'))).toBe(
      false,
    );
    expect(results.some((r) => r.label === '--on-accent on --status-newthing-fill')).toBe(true);
  });
});

// `auditTheme` derives pairs purely from token NAMES, not from which component actually renders
// them -- so it necessarily also computes a handful of pairs that no real call site renders
// anymore after D1/D2 (05-33 continuation, 2026-09-20), plus two pairs gate_requirements demands
// be checked (accent-as-link-text on every surface) that this plan is not authorised to fix
// (D2 explicitly keeps --accent's own value unchanged for link/outline/border use). Each entry
// below is individually named and justified -- an unlisted failure still fails the gate below, so
// this allowlist can only ever get SMALLER over time (a future plan closing one of these must
// remove its line here, not the other way around).
const KNOWN_UNRENDERED_OR_DEFERRED_FAILURES = new Set<string>([
  // Superseded pattern: --on-accent is never paired with plain --accent as a fill anywhere in the
  // real app anymore -- every bg-accent+text-on-accent call site (Button primary, SegmentedControl
  // checked state, the skip link) moved to --accent-fill (D2). --accent itself is genuinely never
  // used as a background under on-accent text today; this pair is retained in `auditTheme`
  // purely because both token names still exist, not because it is rendered.
  '[dark] --on-accent on --accent',
  // Superseded pattern: --status-{tone} is never paired with its own --status-{tone}-soft as pill
  // text anymore -- StatusPill (the only place bg-status-*-soft appears with foreground text)
  // moved to --status-{tone}-text (D1). The base --status-{tone} tokens stay at their original,
  // vivid values deliberately, for the dot/borders/meters, which carry no text of their own.
  '[light] --status-error on --status-error-soft over --surface-1',
  '[light] --status-idle on --status-idle-soft over --surface-1',
  '[light] --status-ok on --status-ok-soft over --surface-1',
  '[light] --status-warn on --status-warn-soft over --surface-1',
  '[dark] --status-error on --status-error-soft over --surface-1',
  '[dark] --status-idle on --status-idle-soft over --surface-1',
  // Real, currently-rendered, pre-existing gap D2 explicitly did not authorise fixing: --accent as
  // link text (ActivityRow.tsx's server link, servers/[id]/page.tsx's "Servers" not-found link)
  // renders on --canvas in light mode (both call sites have no card wrapper, 05-UI-SPEC.md D-09's
  // no-card pattern) at 4.31:1, and would render on --surface-3 at 4.12:1 if a future call site
  // used it there -- both below 4.5:1. D2's own text is explicit: "--accent stays #0071e3 light /
  // #2997ff dark for links, outlines, borders" with no exception carved out for this. Fixing it
  // would mean darkening --accent's light value, which D2 forbids; deferred, logged in
  // deferred-items.md and docs/contrast-decision-05.md section 3's erratum, not silently dropped.
  // (The OUTLINE/BORDER verdict for these same two pairs, at the looser 3.0:1 bar, already
  // passes -- 4.31 and 4.12 both clear 3.0 -- so focus rings and input borders are unaffected.)
  '[light] --accent as text on --canvas',
  '[light] --accent as text on --surface-3',
]);

// The exhaustive gate (05-33-PLAN.md Task 3, extended by the 2026-09-20 continuation's D1/D2/D3
// decisions): every pair `auditTokens` derives from the REAL tokens.css must clear its own
// threshold in BOTH themes, EXCEPT the individually-named, justified exceptions above. This is
// what makes a future token edit that regresses contrast fail CI instead of silently shipping
// (T-5G-33-02) -- proved once by temporarily reverting a token value locally and watching this
// test go red (05-33-continuation SUMMARY records that run's literal output), never by
// `git stash`/`git checkout .`.
describe('the real tokens.css gate', () => {
  it('every audited pair clears its threshold in both themes, except the named deferred failures', () => {
    const results = auditTokens(readRealTokens());
    const describe = (r: AuditPair) => `[${r.theme}] ${r.label}`;
    const failing = results.filter((r) => !r.pass && !KNOWN_UNRENDERED_OR_DEFERRED_FAILURES.has(describe(r)));
    const withRatio = (r: AuditPair) => `[${r.theme}] ${r.label}: ${String(r.ratio)} < ${String(r.threshold)}`;

    expect(failing.map(withRatio)).toEqual([]);
  });

  it('the deferred-failures allowlist names only pairs that still actually fail (no stale entries)', () => {
    // If a future token change fixes one of the named exceptions above, this test forces that
    // line to be deleted rather than silently becoming a no-op false allowance.
    const results = auditTokens(readRealTokens());
    const describe = (r: AuditPair) => `[${r.theme}] ${r.label}`;
    const stillFailing = new Set(results.filter((r) => !r.pass).map(describe));

    for (const allowed of KNOWN_UNRENDERED_OR_DEFERRED_FAILURES) {
      expect(stillFailing.has(allowed), `${allowed} no longer fails -- remove it from the allowlist`).toBe(true);
    }
  });

  // WR-C-08 named call sites (doc §1.2) that are NOT derivable from a generic token-name scan --
  // each depends on knowledge of which component renders where, so they are asserted explicitly
  // here rather than folded into `auditTheme`'s derived pairs.
  it('Banner.tsx errorCode: --ink-secondary on composited --status-error-soft over --surface-1 (both themes)', () => {
    const { light, dark } = readRealTokens();
    for (const [theme, tokens] of [['light', light] as const, ['dark', dark] as const]) {
      const inkSecondary = tokens['ink-secondary'];
      const errorSoft = tokens['status-error-soft'];
      const surface1 = tokens['surface-1'];
      if (inkSecondary === undefined || errorSoft === undefined || surface1 === undefined) {
        throw new Error(`${theme}: tokens.css is missing --ink-secondary/--status-error-soft/--surface-1`);
      }
      const composited = toHex(compositeOver(errorSoft, surface1));
      const ratio = roundDown(contrastRatio(inkSecondary, composited));
      expect(ratio, `${theme}: --ink-secondary on ${composited} = ${String(ratio)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('Field.tsx inline error: --status-error-text directly on --surface-1 (both themes)', () => {
    const { light, dark } = readRealTokens();
    for (const [theme, tokens] of [['light', light] as const, ['dark', dark] as const]) {
      const errorText = tokens['status-error-text'];
      const surface1 = tokens['surface-1'];
      if (errorText === undefined || surface1 === undefined) {
        throw new Error(`${theme}: tokens.css is missing --status-error-text/--surface-1`);
      }
      const ratio = roundDown(contrastRatio(errorText, surface1));
      expect(ratio, `${theme}: --status-error-text on --surface-1 = ${String(ratio)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('RowMenu.tsx "Delete" item: --status-error-text directly on --surface-3 (both themes)', () => {
    const { light, dark } = readRealTokens();
    for (const [theme, tokens] of [['light', light] as const, ['dark', dark] as const]) {
      const errorText = tokens['status-error-text'];
      const surface3 = tokens['surface-3'];
      if (errorText === undefined || surface3 === undefined) {
        throw new Error(`${theme}: tokens.css is missing --status-error-text/--surface-3`);
      }
      const ratio = roundDown(contrastRatio(errorText, surface3));
      expect(ratio, `${theme}: --status-error-text on --surface-3 = ${String(ratio)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  // D4 (05-45, 2026-09-20): the four --accent-text link-text pairs must exist and pass in both
  // themes -- this is what closes the two real, deferred failures named in
  // KNOWN_UNRENDERED_OR_DEFERRED_FAILURES above (those stay listed because --accent's OWN value
  // is unchanged; the fix moved the real call sites to this new token instead).
  it('the four --accent-text link-text pairs exist and pass in both themes', () => {
    const results = auditTokens(readRealTokens());
    const surfaces = ['canvas', 'surface-1', 'surface-2', 'surface-3'];
    for (const theme of ['light', 'dark'] as const) {
      for (const surface of surfaces) {
        const label = `--accent-text as link text on --${surface}`;
        const pair = results.find((r) => r.theme === theme && r.label === label);
        expect(pair, `${theme}: missing pair ${label}`).toBeDefined();
        expect(pair?.pass, `${theme}: ${label} = ${String(pair?.ratio)}`).toBe(true);
      }
    }
  });

  // D5 (05-45, 2026-09-20): the destructive-filled confirm button (Dialog.tsx's `filled` variant,
  // Button.tsx's `DESTRUCTIVE_FILLED_CLASSES`) -- `--on-accent` directly on the new fill token,
  // asserted by name so the intent survives a future edit, in the style of the Field.tsx/
  // RowMenu.tsx named assertions below.
  it('destructive-filled confirm button: --on-accent directly on --status-error-fill (both themes)', () => {
    const { light, dark } = readRealTokens();
    for (const [theme, tokens] of [['light', light] as const, ['dark', dark] as const]) {
      const onAccent = tokens['on-accent'];
      const fill = tokens['status-error-fill'];
      if (onAccent === undefined || fill === undefined) {
        throw new Error(`${theme}: tokens.css is missing --on-accent/--status-error-fill`);
      }
      const ratio = roundDown(contrastRatio(onAccent, fill));
      expect(ratio, `${theme}: --on-accent on --status-error-fill = ${String(ratio)}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('does not silently drop a new --status-* token that lacks a -soft sibling', () => {
    // A token named `status-foo` with no `status-foo-soft` must not throw or be silently skipped
    // in a way that hides a real missing-pair authoring mistake -- auditTheme's own `continue`
    // guard means it is simply omitted from results (not asserted as passing), which this test
    // pins so a future refactor cannot turn that omission into a false PASS.
    const tokens = { 'surface-1': '#ffffff', 'status-foo': '#ff0000' };
    const results = auditTheme(tokens, 'light');
    expect(results.some((r) => r.label.startsWith('--status-foo'))).toBe(false);
  });
});
