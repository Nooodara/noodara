import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SERVICE_ERROR_STATUS } from '../../../apps/control-plane/src/routes/http-errors';

// Phase 11 appends one ERROR_VOCABULARIES entry per classification table (classifyGitError,
// classifyDockerError, deployment failure codes) with its own `##` heading; nothing else in this
// test changes.

const PAGE_PATH = 'apps/site/content/docs/reference/error-codes.mdx';

interface ErrorVocabulary {
  readonly heading: string;
  readonly source: string;
  readonly load: () => Readonly<Record<string, number | string>>;
}

// D-16: the single service-code-to-HTTP-status map every route uses today. A vocabulary entry
// pairs a `##` heading in the page with the real source it must equal exactly -- no missing, no
// extra, no mismatched value.
const ERROR_VOCABULARIES: readonly ErrorVocabulary[] = [
  {
    heading: 'HTTP API errors',
    source: 'apps/control-plane/src/routes/http-errors.ts',
    load: () => SERVICE_ERROR_STATUS,
  },
];

function readPage(): string {
  return readFileSync(PAGE_PATH, 'utf8');
}

/** Rows shaped `| \`CODE\` | <value> | ... |` -- code and first data column only. */
function tableRows(section: string): { code: string; value: string }[] {
  const rows: { code: string; value: string }[] = [];
  for (const match of section.matchAll(/^\|\s*`([A-Z_]+)`\s*\|\s*([^|]+?)\s*\|/gm)) {
    const code = match[1];
    const value = match[2];
    if (code !== undefined && value !== undefined) {
      rows.push({ code, value });
    }
  }
  return rows;
}

/** The page's `## <heading>` sections, keyed by heading, each containing the text up to the next
 *  `## ` heading or the end of the file. */
function sectionsByHeading(page: string): Map<string, string> {
  const sections = new Map<string, string>();
  const headingMatches = [...page.matchAll(/^## (.+)$/gm)];
  for (let i = 0; i < headingMatches.length; i += 1) {
    const match = headingMatches[i];
    if (match === undefined) continue;
    const heading = match[1];
    if (heading === undefined) continue;
    const start = (match.index ?? 0) + match[0].length;
    const next = headingMatches[i + 1];
    const end = next === undefined ? page.length : (next.index ?? page.length);
    sections.set(heading, page.slice(start, end));
  }
  return sections;
}

describe('reference/error-codes.mdx accuracy against the real error vocabulary', () => {
  const page = readPage();
  const sections = sectionsByHeading(page);

  it('has no heading beyond the registered ERROR_VOCABULARIES headings', () => {
    const registered = new Set(ERROR_VOCABULARIES.map((v) => v.heading));
    for (const heading of sections.keys()) {
      expect(registered.has(heading), `unregistered "## ${heading}" heading has no ERROR_VOCABULARIES source`).toBe(true);
    }
  });

  for (const vocabulary of ERROR_VOCABULARIES) {
    it(`"${vocabulary.heading}" table maps every code to its exact status, no missing/extra/mismatched row`, () => {
      const section = sections.get(vocabulary.heading);
      expect(section, `"## ${vocabulary.heading}" section not found in ${PAGE_PATH}`).toBeTruthy();

      const table = vocabulary.load();
      const expectedEntries = Object.entries(table);
      const rows = tableRows(section ?? '');

      expect(rows.length, `row count must equal key count for "${vocabulary.heading}"`).toBe(expectedEntries.length);

      const rowsByCode = new Map(rows.map((row) => [row.code, row.value]));
      for (const [code, value] of expectedEntries) {
        expect(rowsByCode.has(code), `"${code}" from ${vocabulary.source} is missing from the table`).toBe(true);
        expect(rowsByCode.get(code), `"${code}"'s documented status does not match ${vocabulary.source}`).toBe(String(value));
      }

      const expectedCodes = new Set(expectedEntries.map(([code]) => code));
      for (const row of rows) {
        expect(expectedCodes.has(row.code), `"${row.code}" is documented but not in ${vocabulary.source}`).toBe(true);
      }
    });
  }

  it('never shows an error body example with a stack trace or a "cause" field', () => {
    expect(page).not.toMatch(/\bstack\b/i);
    expect(page).not.toMatch(/"cause"/);
  });

  it('shows the error body shape as { "error": "<CODE>", "message": "..." } in a fenced block', () => {
    expect(page).toMatch(/```[\s\S]*"error"[\s\S]*"message"[\s\S]*```/);
  });
});
