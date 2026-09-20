import { describe, expect, it } from 'vitest';
import { SERVER_STATUSES } from '@noodara/domain/server';
import { serverStatusTone, STATUS_WORDS } from './tone.js';
import { StatusPill } from './StatusPill.js';
import { renderUi } from './testing/render.js';

// Every assertion below iterates the domain package's own frozen SERVER_STATUSES tuple, not a
// locally declared array, so a seventh ServerStatus added to packages/domain fails this suite
// instead of silently rendering without a word (05-22-PLAN.md Task 3 behaviour).

describe('StatusPill', () => {
  it.each(SERVER_STATUSES)('renders the STATUS_WORDS text for %s', (status) => {
    const { getByTestId } = renderUi(<StatusPill status={status} />);

    expect(getByTestId('status-pill')).toHaveTextContent(STATUS_WORDS[status]);
  });

  it.each(SERVER_STATUSES)('carries data-testid and data-status equal to the raw status for %s', (status) => {
    const { getByTestId } = renderUi(<StatusPill status={status} />);

    expect(getByTestId('status-pill')).toHaveAttribute('data-status', status);
  });

  it.each(SERVER_STATUSES)('carries data-tone equal to serverStatusTone(status) for %s', (status) => {
    const { getByTestId } = renderUi(<StatusPill status={status} />);

    expect(getByTestId('status-pill')).toHaveAttribute('data-tone', serverStatusTone(status));
  });

  it('marks the dot aria-hidden so only the word carries meaning to assistive tech', () => {
    const { container } = renderUi(<StatusPill status="CONNECTED" />);

    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  // Plan 05-33 continuation, decision D1 (2026-09-20): the dot keeps the full-saturation
  // `--status-{tone}` colour via its own explicit class -- it no longer reads `bg-current`, since
  // the pill word now uses the separately-tuned `--status-{tone}-text` colour and the two are no
  // longer guaranteed to match.
  it.each(SERVER_STATUSES)('gives the dot an explicit bg-status-{tone} class, not bg-current, for %s', (status) => {
    const { container } = renderUi(<StatusPill status={status} />);
    const dot = container.querySelector('[aria-hidden="true"]');
    const tone = serverStatusTone(status);

    expect(dot?.className).toContain(`bg-status-${tone}`);
    expect(dot?.className).not.toContain('bg-current');
  });

  it.each(SERVER_STATUSES)('sets data-pulsing correctly for %s', (status) => {
    const { getByTestId } = renderUi(<StatusPill status={status} />);
    const expected = status === 'CONNECTING' ? 'true' : 'false';

    expect(getByTestId('status-pill')).toHaveAttribute('data-pulsing', expected);
  });

  it('exposes no live-region role of its own', () => {
    const { getByTestId } = renderUi(<StatusPill status="CONNECTED" />);
    const pill = getByTestId('status-pill');

    expect(pill).not.toHaveAttribute('role');
    expect(pill.getAttribute('aria-live')).toBeNull();
  });
});
