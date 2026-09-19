// Task 2 RED (05-15-PLAN.md): `ActivityRow.tsx` does not exist yet -- the import below fails to
// resolve, the right reason for this file to fail before implementation exists.
import { describe, expect, it } from 'vitest';
import { ActivityRow } from './ActivityRow';
import { renderUi, screen, within } from '@noodara/ui/testing';
import { sentenceFor, type ActivityItem, type ServerLookup } from '../lib/activity-copy';

const NOW = new Date('2026-09-19T12:00:00.000Z');

function buildItem(overrides: Partial<ActivityItem> & Pick<ActivityItem, 'action'>): ActivityItem {
  return {
    id: 'evt-1',
    occurredAt: '2026-09-19T10:00:00.000Z',
    actorType: 'user',
    actorId: 'admin-1',
    entityType: 'server',
    entityId: 'srv-1',
    outcome: 'success',
    errorCode: null,
    metadata: {},
    ...overrides,
  };
}

const notFoundLookup: ServerLookup = () => null;
const foundLookup: ServerLookup = (entityId) => ({ name: 'db-primary', href: `/servers/${entityId}` });

function fullText(sentence: { before: string; server: { label: string } | null; after: string }): string {
  return sentence.before + (sentence.server?.label ?? '') + sentence.after;
}

describe('ActivityRow -- renders exactly what sentenceFor returns', () => {
  it('never composes its own prose -- the visible text matches sentenceFor(item, lookupServer) verbatim', () => {
    const item = buildItem({ action: 'server.fingerprint_trusted' });

    renderUi(<ActivityRow item={item} now={NOW} lookupServer={foundLookup} />);

    const expected = fullText(sentenceFor(item, foundLookup));
    const row = screen.getByTestId('activity-row');
    expect(row).toHaveTextContent(expected);
  });
});

describe('ActivityRow -- curated detail vs. an unknown metadata key', () => {
  it('shows only the curated pairs on expansion; an unknown key never appears anywhere in the row', async () => {
    const item = buildItem({
      action: 'server.created',
      metadata: { host: 'db.internal', sshPort: 22, sshUser: 'root', credentialType: 'ssh_private_key', privateKey: 'super-secret-value' },
    });

    const { container } = renderUi(<ActivityRow item={item} now={NOW} lookupServer={foundLookup} />);

    const trigger = screen.getByRole('button');
    trigger.click();

    expect(await screen.findByText('db.internal:22')).toBeInTheDocument();
    expect(screen.getByText('root')).toBeInTheDocument();
    expect(screen.getByText('Private key')).toBeInTheDocument();
    expect(container.textContent).not.toContain('privateKey');
    expect(container.textContent).not.toContain('super-secret-value');
  });

  it('renders no expand control at all for an action with no curated keys (auth.logout)', () => {
    const item = buildItem({ action: 'auth.logout', entityType: 'session', entityId: null, metadata: { email: 'admin@example.test' } });

    renderUi(<ActivityRow item={item} now={NOW} lookupServer={notFoundLookup} />);

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('ActivityRow -- error code rendering', () => {
  it('renders the errorCode in a data-mono element for a failure', () => {
    const item = buildItem({
      action: 'server.connection_attempted',
      outcome: 'failure',
      errorCode: 'CONNECT_TIMEOUT',
      metadata: { attempts: 1, durationMs: 500 },
    });

    renderUi(<ActivityRow item={item} now={NOW} lookupServer={foundLookup} />);

    const row = screen.getByTestId('activity-row');
    const monoEl = within(row).getByText('CONNECT_TIMEOUT');
    expect(monoEl).toHaveAttribute('data-mono', 'true');
  });

  it('renders no error code element for a success item', () => {
    const item = buildItem({ action: 'server.connection_attempted', outcome: 'success', metadata: { attempts: 1, durationMs: 500 } });

    renderUi(<ActivityRow item={item} now={NOW} lookupServer={foundLookup} />);

    expect(screen.queryByText(/^[A-Z_]+$/)).not.toBeInTheDocument();
  });
});

describe('ActivityRow -- server name link vs. plain text', () => {
  it('renders the server name as a link when the resolver supplies a target', () => {
    const item = buildItem({ action: 'server.fingerprint_trusted' });

    renderUi(<ActivityRow item={item} now={NOW} lookupServer={foundLookup} />);

    const link = screen.getByRole('link', { name: 'db-primary' });
    expect(link).toHaveAttribute('href', '/servers/srv-1');
  });

  it('renders the server name as plain text with no link for a deleted server (metadata fallback)', () => {
    const item = buildItem({ action: 'server.deleted', metadata: { name: 'gone-server', host: 'gone.example.test' } });

    renderUi(<ActivityRow item={item} now={NOW} lookupServer={foundLookup} />);

    expect(screen.getByText('gone-server')).toBeInTheDocument();
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });
});

describe('ActivityRow -- no raw JSON ever reaches the DOM', () => {
  it('never renders a "{" immediately followed by a double-quote, in any case above', () => {
    const cases: ActivityItem[] = [
      buildItem({ action: 'server.created', metadata: { host: 'h', sshPort: 22, sshUser: 'root', credentialType: 'ssh_password' } }),
      buildItem({ action: 'auth.logout' }),
      buildItem({ action: 'server.connection_attempted', outcome: 'failure', errorCode: 'AUTH_FAILED', metadata: { attempts: 1, durationMs: 10 } }),
      buildItem({ action: 'server.deleted', metadata: { name: 'gone', host: 'gone.example.test' } }),
    ];

    for (const item of cases) {
      const { container, unmount } = renderUi(<ActivityRow item={item} now={NOW} lookupServer={foundLookup} />);
      expect(container.textContent).not.toMatch(/\{"/);
      unmount();
    }
  });
});
