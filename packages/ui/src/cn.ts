// Hand-rolled alternative to `clsx` -- 05-RESEARCH.md's Supporting table leaves this choice
// open, and a ~10-line function is simpler than a new dependency for string concatenation.
export function cn(...parts: readonly (string | false | null | undefined)[]): string {
  return parts
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .trim()
    .replace(/\s+/g, ' ');
}
