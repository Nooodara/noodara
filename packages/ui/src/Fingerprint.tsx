import { CopyButton } from './CopyButton.js';
import { cn } from './cn.js';

export interface FingerprintProps {
  /** The full `SHA256:<hex>` string (or, defensively, any string -- see the shape guard below).
   *  This is the ONLY server-derived text this component ever renders; there is no prop through
   *  which a credential, private key or arbitrary server text can reach it (T-08-01). */
  readonly value: string;
  /** When present, turns on diff mode (D-10, 08-UI-SPEC.md §8.2): `value`'s own blocks are
   *  compared pairwise against `compareTo`'s blocks. A matching block stays secondary ink at
   *  weight 400; a differing block (including one with no counterpart) renders full-strength ink
   *  at weight 600 -- never a colour change (§9 #14). */
  readonly compareTo?: string;
  /** An optional caption rendered above the blocks -- "Trusted"/"New" in `TrustFingerprintDialog`'s
   *  diff mode (never "old", ambiguous with a stale/bad value). */
  readonly label?: string;
  readonly copyLabel?: string;
  readonly 'data-testid'?: string;
}

const SHAPE_RE = /^(SHA256:)(.+)$/;
const BLOCK_SIZE = 4;

const PREFIX_CLASSES = 'font-mono text-caption text-ink-tertiary';
const BLOCKS_CLASSES = 'flex flex-wrap items-baseline gap-2';
const BLOCK_BASE_CLASSES = 'font-mono text-body tabular-nums';
const BLOCK_PLAIN_CLASSES = cn(BLOCK_BASE_CLASSES, 'text-ink');
const BLOCK_MATCH_CLASSES = cn(BLOCK_BASE_CLASSES, 'text-ink-secondary font-normal');
const BLOCK_DIFF_CLASSES = cn(BLOCK_BASE_CLASSES, 'text-ink font-semibold');
const LABEL_CLASSES = 'text-caption text-ink-secondary';
const FALLBACK_CLASSES = 'break-all font-mono text-mono text-ink';

/** Splits a hash body into 4-character blocks -- the way a person actually compares a fingerprint
 *  by eye, in short runs rather than the whole hex string at once (D-10). */
function chunk(body: string): string[] {
  const blocks: string[] = [];
  for (let i = 0; i < body.length; i += BLOCK_SIZE) {
    blocks.push(body.slice(i, i + BLOCK_SIZE));
  }
  return blocks;
}

/** Parses `"SHA256:<hex>"` into its prefix and body; returns `null` for any value that does not
 *  match the expected shape, so the caller can fall back to an as-is, unblocked rendering rather
 *  than crash or silently mangle an unexpected string. */
function parse(value: string): { prefix: string; body: string } | null {
  const match = SHAPE_RE.exec(value);
  if (match === null) {
    return null;
  }
  const prefix = match[1];
  const body = match[2];
  if (prefix === undefined || body === undefined) {
    return null;
  }
  return { prefix, body };
}

// Fingerprint (D-10, 08-UI-SPEC.md §8.2) -- the single TOFU rendering shared by FirstTrustNotice,
// ServerFacts' Connection group and TrustFingerprintDialog's old/new diff. `CopyButton` (existing
// component, reused as-is -- never a second clipboard implementation) copies the full, unblocked
// `value` string exactly as given, prefix included. No randomart, no ASCII art (§9 #7): this
// component renders text only, through React's own escaping -- no raw/unescaped HTML injection.
export function Fingerprint({
  value,
  compareTo,
  label,
  copyLabel = 'Copy fingerprint',
  'data-testid': testId,
}: FingerprintProps) {
  const parsed = parse(value);

  if (parsed === null) {
    // A value that does not match the expected `SHA256:` shape renders as-is -- no blocking, no
    // crash, no invented structure.
    return (
      <div data-testid={testId} className="flex flex-col gap-1">
        {label !== undefined ? <span className={LABEL_CLASSES}>{label}</span> : null}
        <div className="flex items-center gap-2">
          <span data-mono="true" className={FALLBACK_CLASSES}>
            {value}
          </span>
          <CopyButton value={value} label={copyLabel} />
        </div>
      </div>
    );
  }

  const blocks = chunk(parsed.body);
  const compareBlocks = compareTo !== undefined ? chunk(parse(compareTo)?.body ?? compareTo) : undefined;
  const diffMode = compareBlocks !== undefined;

  return (
    <div data-testid={testId} className="flex flex-col gap-1">
      {label !== undefined ? <span className={LABEL_CLASSES}>{label}</span> : null}
      <div className="flex items-center gap-2">
        <span className={PREFIX_CLASSES}>{parsed.prefix}</span>
        <span data-testid="fingerprint-blocks" data-mono="true" className={BLOCKS_CLASSES}>
          {blocks.map((block, index) => {
            const compareBlock = compareBlocks?.[index];
            const isDiffing = diffMode && compareBlock !== block;
            const blockClasses = diffMode ? (isDiffing ? BLOCK_DIFF_CLASSES : BLOCK_MATCH_CLASSES) : BLOCK_PLAIN_CLASSES;
            return (
              <span key={`${String(index)}-${block}`} className={blockClasses}>
                {block}
              </span>
            );
          })}
        </span>
        <CopyButton value={value} label={copyLabel} />
      </div>
    </div>
  );
}
