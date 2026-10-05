import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  MAX_PROJECT_DESCRIPTION_LENGTH,
  MAX_PROJECT_NAME_LENGTH,
  MAX_PROJECT_SLUG_LENGTH,
  PROJECT_SLUG_FALLBACK,
  RESERVED_PROJECT_SLUGS,
  type ProjectName,
  type ProjectSlug,
  deriveProjectSlug,
  projectSlugWithSuffix,
  validateProjectCreateInput,
  validateProjectDescription,
  validateProjectName,
  validateProjectSlug,
  validateProjectUpdateInput,
} from './project.js';

function codeOf(result: { ok: boolean; code?: string }): string | undefined {
  return result.ok ? undefined : result.code;
}

describe('validateProjectName', () => {
  it('accepts a display name and returns it trimmed', () => {
    const result = validateProjectName('  Acme Storefront  ');

    expect(result).toEqual({ ok: true, value: 'Acme Storefront' });
  });

  it('normalizes to NFC so visually equal names compare equal', () => {
    const decomposed = 'Cafe\u0301';

    const result = validateProjectName(decomposed);

    expect(result.ok && result.value).toBe('Caf\u00e9');
  });

  it('counts length in code points, accepting exactly the maximum', () => {
    const name = '\u{1F680}'.repeat(MAX_PROJECT_NAME_LENGTH);

    expect(validateProjectName(name).ok).toBe(true);
    expect(codeOf(validateProjectName(`${name}x`))).toBe('PROJECT_NAME_INVALID');
  });

  it.each([
    '',
    '   ',
    'a\u0000b',
    'line\nbreak',
    'tab\there',
    'esc\u001b[31m',
    'c1\u0085',
    'rtl\u202eexe',
    'iso\u2066x',
  ])('rejects %j with PROJECT_NAME_INVALID', (input) => {
    expect(codeOf(validateProjectName(input))).toBe('PROJECT_NAME_INVALID');
  });

  it('rejects a non-string value', () => {
    expect(codeOf(validateProjectName(42))).toBe('PROJECT_NAME_INVALID');
  });
});

describe('deriveProjectSlug', () => {
  it.each([
    ['My App', 'my-app'],
    ['  --Hello__World!!  ', 'hello-world'],
    ['Caf\u00e9 \u00dcn\u00efcode', 'cafe-unicode'],
    ['Cafe\u0301', 'cafe'],
    ['Stra\u00dfe', 'strasse'],
    [
      '\u00c6ther \u0152uvre \u00d8re \u0141\u00f3d\u017a \u0110ak \u00deorn \u00f0',
      'aether-oeuvre-ore-lodz-dak-thorn-d',
    ],
    ['\uff21\uff22\uff23 \ufb01le', 'abc-file'],
    ['\u0130stanbul', 'istanbul'],
    ['api v2', 'api-v2'],
    ['2024 Launch', '2024-launch'],
  ])('derives %j as %j', (name, slug) => {
    expect(deriveProjectSlug(name)).toBe(slug);
  });

  it.each(['\u65e5\u672c\u8a9e', '!!!', '', '   ', '\u{1F680}\u{1F680}', '---'])(
    'falls back deterministically for %j, which has no ASCII letters or digits',
    (name) => {
      expect(deriveProjectSlug(name)).toBe(PROJECT_SLUG_FALLBACK);
    },
  );

  it('truncates to the maximum length without leaving a trailing hyphen', () => {
    const name = `${'a'.repeat(MAX_PROJECT_SLUG_LENGTH - 1)} tail`;

    const slug = deriveProjectSlug(name);

    expect(slug).toBe('a'.repeat(MAX_PROJECT_SLUG_LENGTH - 1));
    expect(deriveProjectSlug('b'.repeat(200))).toHaveLength(MAX_PROJECT_SLUG_LENGTH);
  });

  it.each(RESERVED_PROJECT_SLUGS.map((word) => [word]))(
    'suffixes the reserved word %s deterministically',
    (word) => {
      expect(deriveProjectSlug(word.toUpperCase())).toBe(`${word}-project`);
    },
  );

  it('always produces a slug that validateProjectSlug accepts', () => {
    const names = [
      'My App',
      '\u65e5\u672c\u8a9e',
      'new',
      'x'.repeat(500),
      `${'y'.repeat(62)}-z`,
      'a\u0000b',
      '../../etc/passwd',
      '-rf /',
      '$(reboot)',
    ];

    for (const name of names) {
      expect(validateProjectSlug(deriveProjectSlug(name)).ok, name).toBe(true);
    }
  });

  it('is deterministic', () => {
    expect(deriveProjectSlug('Acme Storefront')).toBe(deriveProjectSlug('Acme Storefront'));
  });

  it('returns a branded ProjectSlug', () => {
    expectTypeOf(deriveProjectSlug('x')).toEqualTypeOf<ProjectSlug>();
  });
});

describe('validateProjectSlug', () => {
  it.each(['my-app', 'a', '0', 'a-2', 'x'.repeat(MAX_PROJECT_SLUG_LENGTH), PROJECT_SLUG_FALLBACK])(
    'accepts %j',
    (slug) => {
      expect(validateProjectSlug(slug)).toEqual({ ok: true, value: slug });
    },
  );

  it.each([
    '',
    'My-App',
    '-a',
    'a-',
    'a--b',
    'a_b',
    'a b',
    'a/b',
    'x'.repeat(MAX_PROJECT_SLUG_LENGTH + 1),
    'new',
    'api',
    42,
    null,
  ])('rejects %j with PROJECT_SLUG_INVALID', (slug) => {
    expect(codeOf(validateProjectSlug(slug))).toBe('PROJECT_SLUG_INVALID');
  });
});

describe('projectSlugWithSuffix', () => {
  it('appends the collision counter chosen by the caller', () => {
    expect(projectSlugWithSuffix(deriveProjectSlug('My App'), 2)).toBe('my-app-2');
  });

  it('truncates the base so the result stays within the maximum length', () => {
    const base = deriveProjectSlug('c'.repeat(MAX_PROJECT_SLUG_LENGTH));

    const slug = projectSlugWithSuffix(base, 12);

    expect(slug).toHaveLength(MAX_PROJECT_SLUG_LENGTH);
    expect(slug.endsWith('-12')).toBe(true);
    expect(validateProjectSlug(slug).ok).toBe(true);
  });

  it('never leaves a double hyphen when truncation lands on a hyphen', () => {
    const base = deriveProjectSlug(`${'d'.repeat(MAX_PROJECT_SLUG_LENGTH - 3)} ee`);

    const slug = projectSlugWithSuffix(base, 7);

    expect(slug).toBe(`${'d'.repeat(MAX_PROJECT_SLUG_LENGTH - 3)}-7`);
    expect(validateProjectSlug(slug).ok).toBe(true);
  });

  it.each([0, 1, -3, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'throws a RangeError for the invalid counter %s (programmer error)',
    (counter) => {
      expect(() => projectSlugWithSuffix(deriveProjectSlug('x'), counter)).toThrow(RangeError);
    },
  );
});

describe('validateProjectDescription', () => {
  it.each([undefined, null, '', '   \n '])('maps %j to null', (input) => {
    expect(validateProjectDescription(input)).toEqual({
      ok: true,
      value: null,
    });
  });

  it('trims and keeps newlines and tabs', () => {
    const result = validateProjectDescription('  Storefront API\n\tand worker  ');

    expect(result).toEqual({ ok: true, value: 'Storefront API\n\tand worker' });
  });

  it('accepts exactly the maximum length in code points', () => {
    const description = '\u00e9'.repeat(MAX_PROJECT_DESCRIPTION_LENGTH);

    expect(validateProjectDescription(description).ok).toBe(true);
    expect(codeOf(validateProjectDescription(`${description}x`))).toBe(
      'PROJECT_DESCRIPTION_INVALID',
    );
  });

  it.each(['nul\u0000', 'esc\u001b[2J', 'del\u007f', 'bidi\u202e', 42, {}, ['x']])(
    'rejects %j with PROJECT_DESCRIPTION_INVALID',
    (input) => {
      expect(codeOf(validateProjectDescription(input))).toBe('PROJECT_DESCRIPTION_INVALID');
    },
  );
});

describe('validateProjectCreateInput', () => {
  it('validates the name, derives the slug and defaults the description to null', () => {
    expect(validateProjectCreateInput({ name: ' My App ' })).toEqual({
      ok: true,
      value: { name: 'My App', slug: 'my-app', description: null },
    });
  });

  it('keeps a valid description', () => {
    const result = validateProjectCreateInput({
      name: 'Shop',
      description: 'Storefront',
    });

    expect(result.ok && result.value.description).toBe('Storefront');
  });

  it.each([null, 'name', 42, [], [{ name: 'x' }]])(
    'rejects %j with PROJECT_INPUT_INVALID',
    (input) => {
      expect(codeOf(validateProjectCreateInput(input))).toBe('PROJECT_INPUT_INVALID');
    },
  );

  it.each(['slug', 'id', 'archivedAt', 'env'])(
    'rejects the unsupported field %s by name',
    (key) => {
      const result = validateProjectCreateInput({ name: 'Shop', [key]: 'x' });

      expect(codeOf(result)).toBe('PROJECT_INPUT_UNSUPPORTED_FIELD');
      expect(!result.ok && result.message).toContain(key);
    },
  );

  it('passes field validator codes through unchanged', () => {
    expect(codeOf(validateProjectCreateInput({}))).toBe('PROJECT_NAME_INVALID');
    expect(codeOf(validateProjectCreateInput({ name: 'x', description: 7 }))).toBe(
      'PROJECT_DESCRIPTION_INVALID',
    );
  });

  it('types the name as a branded ProjectName', () => {
    const result = validateProjectCreateInput({ name: 'x' });

    if (result.ok) expectTypeOf(result.value.name).toEqualTypeOf<ProjectName>();
  });
});

describe('validateProjectUpdateInput', () => {
  it('returns only the fields present', () => {
    expect(validateProjectUpdateInput({ name: 'Renamed' })).toEqual({
      ok: true,
      value: { name: 'Renamed' },
    });
  });

  it('clears the description with an explicit null', () => {
    expect(validateProjectUpdateInput({ description: null })).toEqual({
      ok: true,
      value: { description: null },
    });
  });

  it('accepts both fields together', () => {
    const result = validateProjectUpdateInput({ name: 'N', description: 'D' });

    expect(result).toEqual({
      ok: true,
      value: { name: 'N', description: 'D' },
    });
  });

  it('rejects an empty edit', () => {
    expect(codeOf(validateProjectUpdateInput({}))).toBe('PROJECT_INPUT_EMPTY_EDIT');
  });

  it('rejects a slug edit: the slug is derived once and stays stable', () => {
    expect(codeOf(validateProjectUpdateInput({ slug: 'other' }))).toBe(
      'PROJECT_INPUT_UNSUPPORTED_FIELD',
    );
  });

  it('rejects a non-object and invalid fields', () => {
    expect(codeOf(validateProjectUpdateInput('x'))).toBe('PROJECT_INPUT_INVALID');
    expect(codeOf(validateProjectUpdateInput({ name: '' }))).toBe('PROJECT_NAME_INVALID');
    expect(codeOf(validateProjectUpdateInput({ description: 1 }))).toBe(
      'PROJECT_DESCRIPTION_INVALID',
    );
  });
});
