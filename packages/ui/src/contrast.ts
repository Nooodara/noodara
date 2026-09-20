// WCAG 2.x relative luminance and contrast-ratio computation (05-33-PLAN.md Task 1, T-5G-33-01,
// T-5G-33-02). No colour-library dependency (T-5-33-SC) -- the formula is ~80 lines of plain
// TypeScript, matching this repo's zero-new-dependency posture for small pure computations.
//
// The sRGB linearisation step uses the 0.04045 breakpoint on the normalised (0-1) channel value,
// the exact intersection of the WCAG formula's two curve segments (0.0031308 * 12.92 =
// 0.040449936...), rather than the commonly republished 0.03928 approximation. Both breakpoints
// agree to at least 4 decimal places on every reference value this module is pinned against
// (verified directly: #767676 on white computes to the same 4.5422... under either breakpoint) --
// 0.04045 is used because it is the mathematically exact segment boundary, not because the two
// diverge for any value audited by this plan.
//
// This module does no file I/O of its own -- `parseTokensCss` takes a CSS string, never a path,
// so it stays trivially testable and so a caller (contrast.test.ts, or a one-off audit script)
// decides whether that string came from `packages/ui/tokens.css` on disk or a fixture.

export interface RgbColor {
  readonly r: number; // 0-255
  readonly g: number; // 0-255
  readonly b: number; // 0-255
}

export interface RgbaColor extends RgbColor {
  readonly a: number; // 0-1
}

const HEX6_RE = /^#([0-9a-fA-F]{6})$/;
const HEX3_RE = /^#([0-9a-fA-F]{3})$/;
const RGBA_RE = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/;

/** Narrows `T | undefined` to `T` once the caller has already guaranteed the value is present --
 *  mirrors `packages/domain/src/validators/network.ts`'s `assertDefined`, needed here for regex
 *  capture groups under `noUncheckedIndexedAccess` (a match on a fixed-group regex always yields
 *  those groups). */
function assertDefined<T>(value: T | undefined): T {
  return value as T;
}

/** Parses a `#rrggbb`, `#rgb` or `rgb()`/`rgba()` colour string (the only forms this repo's
 *  tokens.css uses) into 0-255 channels plus an alpha in [0,1] (1 for any form with no alpha
 *  channel). Throws on anything else -- a silent fallback would let a typo'd token value pass
 *  through as "black" or similar and corrupt every ratio computed from it. */
export function parseColor(value: string): RgbaColor {
  const trimmed = value.trim();

  const hex6 = HEX6_RE.exec(trimmed);
  if (hex6) {
    const hex = assertDefined(hex6[1]);
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
      a: 1,
    };
  }

  const hex3 = HEX3_RE.exec(trimmed);
  if (hex3) {
    const hex = assertDefined(hex3[1]);
    const r = assertDefined(hex[0]);
    const g = assertDefined(hex[1]);
    const b = assertDefined(hex[2]);
    return {
      r: parseInt(r + r, 16),
      g: parseInt(g + g, 16),
      b: parseInt(b + b, 16),
      a: 1,
    };
  }

  const rgba = RGBA_RE.exec(trimmed);
  if (rgba) {
    return {
      r: Number(rgba[1]),
      g: Number(rgba[2]),
      b: Number(rgba[3]),
      a: rgba[4] === undefined ? 1 : Number(rgba[4]),
    };
  }

  throw new Error(`contrast.ts: unrecognised colour value "${value}"`);
}

// Exact intersection of the WCAG sRGB piecewise-linear formula's two segments: solving
// c/12.92 = ((c+0.055)/1.055)**2.4 for the boundary itself gives 0.0031308 in *linear* space,
// which is 0.0031308 * 12.92 = 0.040449936... in normalised (0-1) sRGB space.
const SRGB_LINEAR_THRESHOLD = 0.04045;

function linearizeChannel(channel255: number): number {
  const c = channel255 / 255;
  return c <= SRGB_LINEAR_THRESHOLD ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance: L = 0.2126*R + 0.7152*G + 0.0722*B over linearised sRGB
 *  channels. Accepts either a colour string (hex or rgb()/rgba(), alpha ignored -- luminance is
 *  only meaningful for an opaque colour, composite first via `compositeOver` if the source has
 *  alpha) or an already-parsed `RgbColor`. */
export function relativeLuminance(color: string | RgbColor): number {
  const { r, g, b } = typeof color === 'string' ? parseColor(color) : color;
  return 0.2126 * linearizeChannel(r) + 0.7152 * linearizeChannel(g) + 0.0722 * linearizeChannel(b);
}

/** WCAG 2.x contrast ratio: (Lmax + 0.05) / (Lmin + 0.05), order-independent. */
export function contrastRatio(a: string | RgbColor, b: string | RgbColor): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Alpha-composites `foreground` (a hex or rgba() string; its alpha channel drives the blend --
 *  a hex or alpha-less rgb() input is treated as fully opaque, matching `parseColor`'s a:1
 *  default) over the fully opaque `background`, using the standard "source-over" operator for an
 *  opaque backdrop: result = fg*alpha + bg*(1-alpha), per channel. This is the real rendered
 *  colour a translucent `-soft` pill background produces once drawn over the surface underneath
 *  it (e.g. `--status-error-soft` over `--surface-1`) -- computing a ratio against the raw,
 *  uncomposited `-soft` value would measure a colour that is never actually on screen. */
export function compositeOver(foreground: string, background: string): RgbColor {
  const fg = parseColor(foreground);
  const bg = parseColor(background);
  const a = fg.a;
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  };
}

/** Renders an `RgbColor` back to a `#rrggbb` string, rounding each channel to the nearest
 *  integer (JS `Math.round`'s round-half-up behaviour, e.g. 127.5 -> 128). */
export function toHex(color: RgbColor): string {
  const channel = (n: number) => Math.round(n).toString(16).padStart(2, '0');
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`;
}

/** Truncates (never rounds) a ratio to `decimals` places -- per this plan's reporting rule, a
 *  measured 4.496 is reported as 4.49, never rounded up to 4.5. */
export function roundDown(ratio: number, decimals = 2): number {
  const factor = 10 ** decimals;
  return Math.floor(ratio * factor) / factor;
}

export interface ThemeTokens {
  readonly light: Record<string, string>;
  readonly dark: Record<string, string>;
}

// Matches the whole `:root { ... }` or `[data-theme="dark"] { ... }` block. tokens.css has no
// nested braces inside either block (no calc()/url() usage), so a single non-greedy-to-first-`}`
// match is exact -- verified directly against the real file.
const ROOT_BLOCK_RE = /:root\s*\{([^}]*)\}/;
const DARK_BLOCK_RE = /\[data-theme=(["'])dark\1\]\s*\{([^}]*)\}/;
const DECLARATION_RE = /--([a-z0-9-]+)\s*:\s*([^;]+);/gi;

function parseDeclarationBlock(block: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  DECLARATION_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = DECLARATION_RE.exec(block)) !== null) {
    const name = assertDefined(match[1]);
    const value = assertDefined(match[2]).trim();
    tokens[name] = value;
  }
  return tokens;
}

/** Parses the literal `--token: value;` declarations out of a tokens.css-shaped string's
 *  `:root` (light theme) and `[data-theme="dark"]` (dark theme) blocks -- the single source of
 *  truth every audit in this module reads from, so a token edit on disk is what a re-run
 *  measures, never a hand-copied duplicate that can silently go stale (05-33-PLAN.md
 *  key_links). Takes a CSS string, not a path -- see module header. */
export function parseTokensCss(css: string): ThemeTokens {
  const rootMatch = ROOT_BLOCK_RE.exec(css);
  if (!rootMatch) throw new Error('contrast.ts: could not find a :root block in the given CSS');
  const darkMatch = DARK_BLOCK_RE.exec(css);
  if (!darkMatch) {
    throw new Error('contrast.ts: could not find a [data-theme="dark"] block in the given CSS');
  }
  return {
    light: parseDeclarationBlock(assertDefined(rootMatch[1])),
    dark: parseDeclarationBlock(assertDefined(darkMatch[2])),
  };
}

export interface AuditPair {
  readonly label: string;
  readonly theme: 'light' | 'dark';
  readonly foregroundToken: string;
  readonly backgroundDescription: string;
  readonly foregroundValue: string;
  readonly backgroundEffective: string;
  readonly ratio: number;
  readonly threshold: number;
  readonly pass: boolean;
}

const THRESHOLD_NORMAL_TEXT = 4.5;

// Any token named `status-<word>` that is NOT itself a `-soft` variant -- deliberately a runtime
// scan over the parsed token names, not a hand-written list of the four current statuses
// (T-5G-33-02): a future `--status-newthing` + `--status-newthing-soft` pair is picked up by this
// regex automatically and audited below, so a new status token cannot silently dodge the gate.
const STATUS_TOKEN_RE = /^status-(?!.*-soft$)[a-z0-9]+$/;
// Any `--ink*` token (ink, ink-secondary, ink-tertiary, and any future ink-* addition) -- same
// derive-don't-hardcode rationale.
const INK_TOKEN_RE = /^ink(-.+)?$/;
// The four background surfaces content text is audited against (canvas, surface-1/2/3) -- also
// derived from the parsed names rather than a literal ['canvas','surface-1',...] array.
const SURFACE_BG_RE = /^(canvas|surface-\d+)$/;

/** Runs the full measured audit for a single theme's parsed token map: `--on-accent` on
 *  `--accent`; every `--status-*` token (derived, see `STATUS_TOKEN_RE`) on its own composited
 *  `-soft` background over `--surface-1`; and every `--ink*` token (derived) on every
 *  `--canvas`/`--surface-*` background (derived) -- the exact pair set 05-33-PLAN.md Task 1's
 *  `<behavior>` names, built so that a token this plan does not yet know about is still covered
 *  the moment it is added to tokens.css (05-33-PLAN.md Task 3's exhaustiveness requirement). */
export function auditTheme(tokens: Record<string, string>, theme: 'light' | 'dark'): AuditPair[] {
  const results: AuditPair[] = [];

  const onAccent = tokens['on-accent'];
  const accent = tokens.accent;
  if (onAccent !== undefined && accent !== undefined) {
    const ratio = contrastRatio(onAccent, accent);
    results.push({
      label: '--on-accent on --accent',
      theme,
      foregroundToken: '--on-accent',
      backgroundDescription: '--accent',
      foregroundValue: onAccent,
      backgroundEffective: accent,
      ratio: roundDown(ratio),
      threshold: THRESHOLD_NORMAL_TEXT,
      pass: ratio >= THRESHOLD_NORMAL_TEXT,
    });
  }

  const surface1 = tokens['surface-1'];
  const statusNames = Object.keys(tokens)
    .filter((name) => STATUS_TOKEN_RE.test(name))
    .sort();
  for (const name of statusNames) {
    const softName = `${name}-soft`;
    const foregroundValue = tokens[name];
    const softValue = tokens[softName];
    if (foregroundValue === undefined || softValue === undefined || surface1 === undefined) continue;
    const composited = compositeOver(softValue, surface1);
    const compositedHex = toHex(composited);
    const ratio = contrastRatio(foregroundValue, compositedHex);
    results.push({
      label: `--${name} on --${softName} over --surface-1`,
      theme,
      foregroundToken: `--${name}`,
      backgroundDescription: `--${softName} over --surface-1`,
      foregroundValue,
      backgroundEffective: compositedHex,
      ratio: roundDown(ratio),
      threshold: THRESHOLD_NORMAL_TEXT,
      pass: ratio >= THRESHOLD_NORMAL_TEXT,
    });
  }

  const inkNames = Object.keys(tokens)
    .filter((name) => INK_TOKEN_RE.test(name))
    .sort();
  const surfaceNames = Object.keys(tokens)
    .filter((name) => SURFACE_BG_RE.test(name))
    .sort();
  for (const inkName of inkNames) {
    const foregroundValue = tokens[inkName];
    if (foregroundValue === undefined) continue;
    for (const surfaceName of surfaceNames) {
      const backgroundValue = tokens[surfaceName];
      if (backgroundValue === undefined) continue;
      const ratio = contrastRatio(foregroundValue, backgroundValue);
      results.push({
        label: `--${inkName} on --${surfaceName}`,
        theme,
        foregroundToken: `--${inkName}`,
        backgroundDescription: `--${surfaceName}`,
        foregroundValue,
        backgroundEffective: backgroundValue,
        ratio: roundDown(ratio),
        threshold: THRESHOLD_NORMAL_TEXT,
        pass: ratio >= THRESHOLD_NORMAL_TEXT,
      });
    }
  }

  return results;
}

/** Runs `auditTheme` over both parsed themes from a `ThemeTokens` (see `parseTokensCss`). */
export function auditTokens(tokens: ThemeTokens): AuditPair[] {
  return [...auditTheme(tokens.light, 'light'), ...auditTheme(tokens.dark, 'dark')];
}
