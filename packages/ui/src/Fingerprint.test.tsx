// RED for 08-17-PLAN.md Task 1 (D-10, 08-UI-SPEC.md §8.2) -- Fingerprint.tsx doesn't exist yet.
// Covers the shared TOFU block: prefix/body parsing, 4-character blocking, the reused CopyButton,
// diff-mode weight-only marking (never colour) and the credential-shaped-prop guard (T-08-01).
import { describe, expect, it, vi } from 'vitest';
import { renderUi, screen, userEvent } from './testing/render.js';
import { Fingerprint } from './Fingerprint.js';

function stubClipboard(): ReturnType<typeof vi.fn> {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true,
  });
  return writeText;
}

const VALUE = 'SHA256:abcd1234efgh5678ijkl';

describe('Fingerprint', () => {
  it('renders the SHA256: prefix dimmed and mono, and the hash body split into 4-character blocks', () => {
    renderUi(<Fingerprint value={VALUE} />);

    expect(screen.getByText('SHA256:')).toBeInTheDocument();
    for (const block of ['abcd', '1234', 'efgh', '5678', 'ijkl']) {
      expect(screen.getByText(block)).toBeInTheDocument();
    }
  });

  it('the prefix element carries text-caption mono ink-tertiary treatment', () => {
    renderUi(<Fingerprint value={VALUE} />);

    const prefix = screen.getByText('SHA256:');
    expect(prefix.className).toMatch(/font-mono/);
    expect(prefix.className).toMatch(/text-caption/);
    expect(prefix.className).toMatch(/text-ink-tertiary/);
  });

  it('the hash blocks carry the mono-grande (text-body/15px) treatment, marked data-mono', () => {
    renderUi(<Fingerprint value={VALUE} />);

    const block = screen.getByText('abcd');
    expect(block.className).toMatch(/font-mono/);
    expect(block.className).toMatch(/text-body/);
    expect(screen.getByTestId('fingerprint-blocks')).toHaveAttribute('data-mono', 'true');
  });

  it('copies the full unblocked original string, prefix included', async () => {
    const writeText = stubClipboard();
    const user = userEvent.setup();
    renderUi(<Fingerprint value={VALUE} />);

    await user.click(screen.getByRole('button', { name: 'Copy fingerprint' }));

    expect(writeText).toHaveBeenCalledWith(VALUE);
  });

  it('accepts a custom copyLabel for the CopyButton accessible name', () => {
    stubClipboard();
    renderUi(<Fingerprint value={VALUE} copyLabel="Copy Host fingerprint" />);

    expect(screen.getByRole('button', { name: 'Copy Host fingerprint' })).toBeInTheDocument();
  });

  it('renders an optional caption label above the blocks', () => {
    renderUi(<Fingerprint value={VALUE} label="Trusted" />);

    expect(screen.getByText('Trusted')).toBeInTheDocument();
  });

  describe('diff mode', () => {
    const TRUSTED = 'SHA256:aaaabbbbccccdddd';
    const NEW_SAME_TAIL = 'SHA256:XXXXbbbbccccdddd';

    it('renders matching blocks at text-ink-secondary font-normal and differing blocks at text-ink font-semibold', () => {
      renderUi(<Fingerprint value={TRUSTED} compareTo={NEW_SAME_TAIL} />);

      const differingBlock = screen.getByText('aaaa');
      expect(differingBlock.className).toMatch(/text-ink\b/);
      expect(differingBlock.className).toMatch(/font-semibold/);

      const matchingBlock = screen.getByText('bbbb');
      expect(matchingBlock.className).toMatch(/text-ink-secondary/);
      expect(matchingBlock.className).toMatch(/font-normal/);
    });

    it('uses no colour utility of any kind to mark a difference', () => {
      const { container } = renderUi(<Fingerprint value={TRUSTED} compareTo={NEW_SAME_TAIL} />);

      expect(container.innerHTML).not.toMatch(/text-status|bg-status|text-accent|bg-accent|text-red|text-green/);
    });

    it('aligns blocks of unequal length pairwise, marking every block of the longer value as differing when its counterpart is missing', () => {
      renderUi(<Fingerprint value="SHA256:aaaabbbbcccc" compareTo="SHA256:aaaabbbb" />);

      const extraBlock = screen.getByText('cccc');
      expect(extraBlock.className).toMatch(/font-semibold/);
      expect(extraBlock.className).toMatch(/text-ink\b/);
    });
  });

  it('renders a non-SHA256-shaped value as-is, with no blocking and no crash', () => {
    renderUi(<Fingerprint value="not-a-fingerprint" />);

    expect(screen.getByText('not-a-fingerprint')).toBeInTheDocument();
  });

  it('exposes no prop through which a credential, private key or arbitrary server text can be passed', () => {
    // Compile-time guard: FingerprintProps carries exactly value/compareTo/label/copyLabel/testId.
    // No `secret`/`credential`/`privateKey` field exists on the type at all -- this test's own
    // existence (and its type-check under `pnpm typecheck`) is the assertion.
    renderUi(<Fingerprint value={VALUE} />);
    expect(screen.queryByText(/BEGIN.*PRIVATE KEY/i)).not.toBeInTheDocument();
  });
});
