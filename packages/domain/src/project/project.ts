// Project inputs (PRJ, ROADMAP phase 12): a free display name, a slug derived from it once at
// creation, and an optional description. Uniqueness is the caller's job: on a slug collision it
// asks `projectSlugWithSuffix` for `<slug>-2`, `<slug>-3`, ... until one is free.

import type { Brand } from '../validators/branded.js';
import { type ValidationResult, fail, ok } from '../validators/network.js';
import {
  ENTITY_SLUG_PATTERN,
  type InputRecord,
  UNSAFE_TEXT_CHARACTERS,
  hasKey,
  parseInputRecord,
} from './input.js';

export type ProjectName = Brand<string, 'ProjectName'>;
export type ProjectSlug = Brand<string, 'ProjectSlug'>;
export type ProjectDescription = Brand<string, 'ProjectDescription'>;

export const MAX_PROJECT_NAME_LENGTH = 64;
export const MAX_PROJECT_SLUG_LENGTH = 63;
export const MAX_PROJECT_DESCRIPTION_LENGTH = 500;
/** The slug of a name with no ASCII letter or digit left after normalization. */
export const PROJECT_SLUG_FALLBACK = 'project';
/** Slugs that collide with fixed routes or read as sentinels; derivation suffixes them. */
export const RESERVED_PROJECT_SLUGS = [
  'admin',
  'api',
  'archive',
  'archived',
  'create',
  'delete',
  'edit',
  'new',
  'null',
  'settings',
  'undefined',
] as const;
const RESERVED_SUFFIX = '-project';

export interface ProjectCreateInput {
  readonly name: ProjectName;
  readonly slug: ProjectSlug;
  readonly description: ProjectDescription | null;
}

/** The slug is not editable: links keep working after a rename. */
export interface ProjectUpdateInput {
  readonly name?: ProjectName;
  readonly description?: ProjectDescription | null;
}

// Description text may span lines; every other control character is still rejected.
/* eslint-disable no-control-regex -- deliberately matching control characters */
const UNSAFE_DESCRIPTION_CHARACTERS =
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/;
/* eslint-enable no-control-regex */
// Latin letters that NFKD does not decompose into an ASCII base letter.
const LETTER_FOLDS: readonly (readonly [RegExp, string])[] = [
  [/\u00df/g, 'ss'],
  [/\u00e6/g, 'ae'],
  [/\u0153/g, 'oe'],
  [/\u00f8/g, 'o'],
  [/\u0142/g, 'l'],
  [/[\u0111\u00f0]/g, 'd'],
  [/\u00fe/g, 'th'],
];

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function isReserved(slug: string): boolean {
  return (RESERVED_PROJECT_SLUGS as readonly string[]).includes(slug);
}

function trimHyphens(value: string): string {
  return value.replace(/^-+|-+$/g, '');
}

/** Trimmed, NFC-normalized, 1-64 code points, no control or bidi characters. */
export function validateProjectName(input: unknown): ValidationResult<ProjectName> {
  const invalid = fail<ProjectName>(
    'PROJECT_NAME_INVALID',
    `Project name must be 1-${MAX_PROJECT_NAME_LENGTH.toString()} characters without control characters`,
  );
  if (typeof input !== 'string') return invalid;
  const name = input.normalize('NFC').trim();
  const length = codePointLength(name);
  if (length < 1 || length > MAX_PROJECT_NAME_LENGTH || UNSAFE_TEXT_CHARACTERS.test(name)) {
    return invalid;
  }
  return ok(name as ProjectName);
}

/**
 * Deterministic slug: lowercase, accents stripped (NFKD), common Latin letters folded to ASCII,
 * every other run collapsed to one "-", trimmed and cut to 63 characters. A name with nothing
 * left becomes `project`; a reserved word gets `-project` appended.
 */
export function deriveProjectSlug(name: string): ProjectSlug {
  const folded = LETTER_FOLDS.reduce(
    (text, [letter, ascii]) => text.replace(letter, ascii),
    name.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, ''),
  );
  const slug = trimHyphens(
    trimHyphens(folded.replace(/[^a-z0-9]+/g, '-')).slice(0, MAX_PROJECT_SLUG_LENGTH),
  );
  if (slug === '') return PROJECT_SLUG_FALLBACK as ProjectSlug;
  return (isReserved(slug) ? `${slug}${RESERVED_SUFFIX}` : slug) as ProjectSlug;
}

/** Validates a stored or routed slug in canonical form (no "--", not reserved). */
export function validateProjectSlug(input: unknown): ValidationResult<ProjectSlug> {
  if (
    typeof input !== 'string' ||
    !ENTITY_SLUG_PATTERN.test(input) ||
    input.includes('--') ||
    isReserved(input)
  ) {
    return fail(
      'PROJECT_SLUG_INVALID',
      'Project slug must be 1-63 characters of [a-z0-9-], start and end alphanumeric, have no "--" and not be a reserved word',
    );
  }
  return ok(input as ProjectSlug);
}

/** `<slug>-<counter>` within 63 characters; the counter starts at 2. Throws on a bad counter. */
export function projectSlugWithSuffix(slug: ProjectSlug, counter: number): ProjectSlug {
  if (!Number.isSafeInteger(counter) || counter < 2) {
    throw new RangeError('Slug collision counter must be an integer of at least 2');
  }
  const suffix = `-${counter.toString()}`;
  const base = trimHyphens(slug.slice(0, MAX_PROJECT_SLUG_LENGTH - suffix.length));
  return `${base}${suffix}` as ProjectSlug;
}

/** `undefined`, `null` and blank text all mean "no description". */
export function validateProjectDescription(
  input: unknown,
): ValidationResult<ProjectDescription | null> {
  if (input === undefined || input === null) return ok(null);
  const invalid = fail<ProjectDescription | null>(
    'PROJECT_DESCRIPTION_INVALID',
    `Project description must be text of at most ${MAX_PROJECT_DESCRIPTION_LENGTH.toString()} characters without control characters`,
  );
  if (typeof input !== 'string') return invalid;
  const description = input.normalize('NFC').trim();
  if (description === '') return ok(null);
  if (
    codePointLength(description) > MAX_PROJECT_DESCRIPTION_LENGTH ||
    UNSAFE_DESCRIPTION_CHARACTERS.test(description)
  ) {
    return invalid;
  }
  return ok(description as ProjectDescription);
}

const PROJECT_FIELDS = ['name', 'description'] as const;

function parseProjectRecord(input: unknown): ValidationResult<InputRecord> {
  return parseInputRecord(input, PROJECT_FIELDS, 'PROJECT_INPUT', 'Project');
}

export function validateProjectCreateInput(input: unknown): ValidationResult<ProjectCreateInput> {
  const parsed = parseProjectRecord(input);
  if (!parsed.ok) return parsed;
  const record = parsed.value;
  const name = validateProjectName(record.name);
  if (!name.ok) return name;
  const description = validateProjectDescription(record.description);
  if (!description.ok) return description;
  return ok({
    name: name.value,
    slug: deriveProjectSlug(name.value),
    description: description.value,
  });
}

export function validateProjectUpdateInput(input: unknown): ValidationResult<ProjectUpdateInput> {
  const parsed = parseProjectRecord(input);
  if (!parsed.ok) return parsed;
  const record = parsed.value;
  if (Object.keys(record).length === 0) {
    return fail('PROJECT_INPUT_EMPTY_EDIT', 'Project edit must change at least one field');
  }
  let update: ProjectUpdateInput = {};
  if (hasKey(record, 'name')) {
    const name = validateProjectName(record.name);
    if (!name.ok) return name;
    update = { ...update, name: name.value };
  }
  if (hasKey(record, 'description')) {
    const description = validateProjectDescription(record.description);
    if (!description.ok) return description;
    update = { ...update, description: description.value };
  }
  return ok(update);
}
