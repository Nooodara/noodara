// 10-06-PLAN.md Task 1 (D-10): pure wording/markup rules for site content. Shared by
// content-rules.test.ts's fixtures and tests/unit/site/forbidden-words.test.ts's repo-wide
// scan, so a forbidden phrase, a date, an internal planning id, or unsafe markup cannot land
// in apps/site/content or apps/site/src/content without failing CI (D-10, T-10-04, T-10-06,
// T-10-20). No I/O in this module -- the repo scan owns reading files from disk.

export interface WordingFinding {
  rule: 'coming-soon' | 'soon' | 'roadmap' | 'date-year' | 'date-iso' | 'date-month-day' | 'planning-id';
  match: string;
  index: number;
}

export interface MarkupFinding {
  rule: 'script-tag' | 'iframe-tag' | 'javascript-url' | 'dangerously-set-inner-html';
  match: string;
  index: number;
}

// Full and common abbreviated English month names. Matched only when followed by a 1-2 digit
// day number, so prose like "May I" or "March forward" never trips this rule.
const MONTH_NAMES =
  'January|February|March|April|May|June|July|August|September|October|November|December|' +
  'Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sept|Sep|Oct|Nov|Dec';

const WORDING_RULES: ReadonlyArray<{ rule: WordingFinding['rule']; pattern: RegExp }> = [
  { rule: 'coming-soon', pattern: /\bcoming soon\b/gi },
  { rule: 'soon', pattern: /\bsoon\b/gi },
  { rule: 'roadmap', pattern: /\broadmap\b/gi },
  { rule: 'date-year', pattern: /\b(19|20)\d{2}\b/g },
  { rule: 'date-iso', pattern: /\b\d{4}-\d{2}-\d{2}\b/g },
  { rule: 'date-month-day', pattern: new RegExp(`\\b(?:${MONTH_NAMES})\\.?\\s+\\d{1,2}\\b`, 'g') },
  { rule: 'planning-id', pattern: /\bD-\d{2}\b/g },
  { rule: 'planning-id', pattern: /\bT-\d{2}-\d+\b/g },
  { rule: 'planning-id', pattern: /\b\d{2}-\d{2}-PLAN\b/g },
];

/**
 * Scans free text for D-10's forbidden vocabulary: "coming soon"/"soon"/"roadmap", literal
 * dates (year, ISO, "Month day"), and internal planning ids (D-NN, T-NN-N, NN-NN-PLAN) that
 * must never leak into public copy. Applies everywhere in the text, including inside fenced
 * code blocks -- a date is still a date if it is quoted in a code sample.
 */
export function findForbiddenWording(text: string): WordingFinding[] {
  const findings: WordingFinding[] = [];
  for (const { rule, pattern } of WORDING_RULES) {
    for (const match of text.matchAll(pattern)) {
      findings.push({ rule, match: match[0], index: match.index ?? 0 });
    }
  }
  return findings.sort((a, b) => a.index - b.index);
}

const MARKUP_RULES: ReadonlyArray<{ rule: MarkupFinding['rule']; pattern: RegExp }> = [
  { rule: 'script-tag', pattern: /<script\b/gi },
  { rule: 'iframe-tag', pattern: /<iframe\b/gi },
  { rule: 'javascript-url', pattern: /javascript:/gi },
  { rule: 'dangerously-set-inner-html', pattern: /dangerouslySetInnerHTML/g },
];

// Fenced code blocks (```...```) commonly show install one-liners piped to a shell -- those are
// documentation, not injectable markup, so findUnsafeMarkup alone skips them. Blank lines are
// substituted in place of the block's content so match indexes of text after the block are
// unaffected.
function stripFencedCodeBlocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, (block) => '\n'.repeat((block.match(/\n/g) ?? []).length));
}

/**
 * Scans text for unsafe embedded markup: raw <script>/<iframe> tags, javascript: URLs, and
 * dangerouslySetInnerHTML. Fenced code blocks are excluded (a documented `curl ... | sh` isn't
 * unsafe markup); wording rules apply everywhere, but markup rules do not need to since MDX
 * content is never expected to demonstrate real script tags in a code sample either.
 */
export function findUnsafeMarkup(text: string): MarkupFinding[] {
  const scanned = stripFencedCodeBlocks(text);
  const findings: MarkupFinding[] = [];
  for (const { rule, pattern } of MARKUP_RULES) {
    for (const match of scanned.matchAll(pattern)) {
      findings.push({ rule, match: match[0], index: match.index ?? 0 });
    }
  }
  return findings.sort((a, b) => a.index - b.index);
}
