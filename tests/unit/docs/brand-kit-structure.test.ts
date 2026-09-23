// 07-08-PLAN.md Task 2 (BRAND-01, ROADMAP success criterion 1): the brand kit has to let a person
// reproduce the logo correctly WITHOUT ASKING.
//
// A brand kit is documentation about code, which is exactly the shape
// `tests/unit/docs/install-docs-accuracy.test.ts` already handles for `docs/install.md` against
// `install.sh`: the numbers in the prose are read from the module that actually draws the mark, the
// asset list is read from the manifest that actually writes the files, and the commands are checked
// against the real `package.json`. Nothing here is typed twice, so an adjustment round that retunes
// a constant fails this suite instead of silently making the document lie.
//
// It also guards the two things that make the kit publishable: no colour literal (the palette is
// referenced by token name, the same discipline `check:ui-safety` enforces in source), and no
// internal planning identifier or AI attribution -- `docs/brand/` is the one folder whose contents
// get copied outward into a public site.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  APERTURE_RADIUS,
  CONCEPT_META,
  DEFAULT_CONCEPT,
  GRID,
  LOCKUP_GAP,
  MARGIN,
  STROKE,
} from '../../../packages/ui/src/brand/geometry.js';
import { ASSET_FILES } from '../../../scripts/brand/asset-manifest.js';

const KIT_PATH = 'docs/brand/BRAND.md';
const kit = (): string => readFileSync(KIT_PATH, 'utf8');

/** The nine topics, in the order a reader needs them: what the mark means, how it is built, which
 *  lockup goes where, how much room it needs, how it is coloured, how it is set, what is forbidden,
 *  where the files are, and who approved it. */
const HEADINGS = [
  '## Meaning',
  '## Construction',
  '## Lockups',
  '## Clear space and minimum size',
  '## Color',
  '## Typography',
  '## Misuse',
  '## Assets and exports',
  '## Approval',
] as const;

/** Everything under one `## ` heading, up to the next one. */
function section(heading: string): string {
  const name = heading.replace('## ', '');
  const match = new RegExp(`\\n## ${name}\\n([\\s\\S]*?)(\\n## |$)`).exec(kit());
  expect(match, `no "${heading}" section in ${KIT_PATH}`).toBeTruthy();
  return match?.[1] ?? '';
}

function listItems(text: string): string[] {
  return text.split('\n').filter((line) => /^[-*] /.test(line));
}

describe('docs/brand/BRAND.md structure', () => {
  it('opens with the kit title', () => {
    expect(kit().startsWith('# Noodara brand kit\n')).toBe(true);
  });

  it('carries exactly the nine topics, in order', () => {
    const found = [...kit().matchAll(/^## .+$/gm)].map((match) => match[0]);
    expect(found).toEqual([...HEADINGS]);
  });
});

describe('BRAND.md Meaning', () => {
  it('says the name is invented and the mark encodes seeing clearly', () => {
    const meaning = section('## Meaning').toLowerCase();
    expect(meaning).toContain('invented');
    expect(meaning).toContain('your infrastructure, understood.');
    for (const word of ['etymology', 'understand']) {
      expect(meaning).toContain(word);
    }
  });

  it('names the approved construction by its own name and quotes its meaning verbatim', () => {
    const meta = CONCEPT_META[DEFAULT_CONCEPT];
    const meaning = section('## Meaning');
    expect(meaning).toContain(meta.name);
    expect(meaning).toContain(meta.meaning);
  });
});

describe('BRAND.md Construction', () => {
  it('states every constant with the value geometry.ts actually exports', () => {
    const construction = section('## Construction');
    const expected: readonly (readonly [string, number])[] = [
      ['GRID', GRID],
      ['MARGIN', MARGIN],
      ['STROKE', STROKE],
      ['APERTURE_RADIUS', APERTURE_RADIUS],
      ['LOCKUP_GAP', LOCKUP_GAP],
    ];
    for (const [name, value] of expected) {
      expect(construction, `${name} is not stated with its real value`).toContain(`${name} = ${String(value)}`);
    }
  });

  it('embeds the generated construction sheet', () => {
    expect(section('## Construction')).toContain('![Construction](construction.svg)');
  });

  it('explains why the mark is filled outlines under the nonzero rule, not strokes', () => {
    const construction = section('## Construction').toLowerCase();
    expect(construction).toContain('filled outline');
    expect(construction).toContain('nonzero');
    expect(construction).toContain('16 px');
  });

  it('describes the wordmark rules, including the aperture reused as the round letters', () => {
    const construction = section('## Construction').toLowerCase();
    for (const word of ['x-height', 'ascender', 'kern']) {
      expect(construction).toContain(word);
    }
  });
});

describe('BRAND.md Lockups', () => {
  it('names all three lockups', () => {
    const lockups = section('## Lockups').toLowerCase();
    for (const name of ['monogram', 'horizontal lockup', 'wordmark']) {
      expect(lockups).toContain(name);
    }
  });

  it('maps each lockup to the surfaces it belongs on', () => {
    const lockups = section('## Lockups').toLowerCase();
    for (const surface of ['rail', 'favicon', 'apple-touch-icon', 'sidebar', '/login', '/setup', 'readme', 'site']) {
      expect(lockups, `no surface "${surface}" in the lockup table`).toContain(surface);
    }
  });
});

describe('BRAND.md Clear space and minimum size', () => {
  it('derives clear space from the grid rather than picking a number', () => {
    const clear = section('## Clear space and minimum size');
    expect(clear).toContain('STROKE');
    expect(clear.toLowerCase()).toContain('clear space');
  });

  it('gives a minimum size in px for each lockup', () => {
    const clear = section('## Clear space and minimum size');
    expect(clear).toMatch(/\d+\s?px/);
    expect(clear).toContain('16 px');
  });
});

describe('BRAND.md Color', () => {
  it('references the palette by token name and names the one blue surface', () => {
    const color = section('## Color');
    for (const token of ['currentColor', '--ink', '--accent-fill', '--on-accent', '--canvas']) {
      expect(color, `${token} is not referenced in the colour section`).toContain(token);
    }
    expect(color).toContain('only surface');
  });

  it('contains no colour literal anywhere in the document', () => {
    expect(kit()).not.toMatch(/#[0-9a-fA-F]{6}\b/);
    expect(kit()).not.toMatch(/\brgba?\(/);
  });
});

describe('BRAND.md Typography', () => {
  it('says the wordmark is drawn, not set in a font, and that the UI keeps the system stack', () => {
    const typography = section('## Typography').toLowerCase();
    expect(typography).toContain('drawn');
    expect(typography).toContain('system font');
    expect(typography).toContain('no font file');
  });
});

describe('BRAND.md Misuse', () => {
  it('lists at least eight prohibitions', () => {
    expect(listItems(section('## Misuse')).length).toBeGreaterThanOrEqual(8);
  });

  it('covers every prohibition the design brief makes hard', () => {
    const misuse = section('## Misuse').toLowerCase();
    for (const word of ['gradient', 'glow', 'shadow', 'accent', 'emoji', 'stretch', 'rotate', 'outline']) {
      expect(misuse, `the misuse list says nothing about "${word}"`).toContain(word);
    }
  });
});

describe('BRAND.md Assets and exports', () => {
  it('links every file the asset manifest writes', () => {
    const assets = section('## Assets and exports');
    expect(ASSET_FILES.length).toBe(13);
    for (const file of ASSET_FILES) {
      expect(assets, `${file} is not linked from the assets section`).toContain(`packages/ui/brand/${file}`);
    }
  });

  it('names the package subpath the site consumes and shows the README snippet', () => {
    const assets = section('## Assets and exports');
    expect(assets).toContain('@noodara/ui/brand/');
    expect(assets).toContain('<picture>');
  });

  it('every pnpm command it names is a real script', () => {
    const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts: Record<string, string> };
    const commands = [...new Set([...kit().matchAll(/`pnpm ([a-z0-9:_-]+)`/g)].map((match) => match[1]))];
    expect(commands.length).toBeGreaterThan(0);
    for (const command of commands) {
      expect(pkg.scripts, `pnpm ${String(command)} is documented but is not a real script`).toHaveProperty(
        String(command),
      );
    }
  });
});

describe('BRAND.md Approval', () => {
  it('points at the approval record', () => {
    expect(section('## Approval')).toContain('APPROVAL.md');
  });
});

describe('BRAND.md is publishable', () => {
  it('carries no AI attribution', () => {
    const text = kit().toLowerCase();
    for (const needle of ['claude', 'anthropic', 'co-authored-by']) {
      expect(text).not.toContain(needle);
    }
  });

  it('names no internal planning id', () => {
    for (const pattern of [/\bD-\d{2}\b/, /\b0[1-7]-\d{2}\b/, /\bT-0\d-\d+\b/]) {
      expect(kit()).not.toMatch(pattern);
    }
  });

  it('is written in product copy style: sentence case, no exclamation marks', () => {
    // Markdown's own image syntax is the one legitimate `!` in the file.
    expect(kit()).not.toMatch(/!(?!\[)/);
    for (const heading of HEADINGS) {
      const words = heading.replace('## ', '').split(' ').slice(1);
      for (const word of words) {
        expect(/^[A-Z]/.test(word), `"${heading}" is not sentence case`).toBe(false);
      }
    }
  });
});
