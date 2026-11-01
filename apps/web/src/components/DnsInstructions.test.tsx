import { describe, expect, it } from 'vitest';
import { renderUi, screen, within } from '@noodara/ui/testing';
import { DNS_NO_RECORDS_COPY, DnsInstructions } from './DnsInstructions';

const MARKUP = ['<', 'img src=x onerror=alert(1)', '>'].join('');

describe('DnsInstructions', () => {
  it('shows each record type, name and value with copy buttons', () => {
    renderUi(
      <DnsInstructions
        instructions={{
          hostname: 'app.example.com',
          records: [
            { type: 'A', name: 'app.example.com', value: '203.0.113.7' },
            { type: 'AAAA', name: 'app.example.com', value: '2001:db8::7' },
          ],
          cnameAlternative: { name: 'app.example.com', target: 'edge.example.net' },
        }}
      />,
    );
    const rows = screen.getAllByTestId('dns-record');
    expect(rows).toHaveLength(2);
    const [row0] = rows as [HTMLElement, ...HTMLElement[]];
    const first = within(row0);
    expect(first.getByTestId('dns-record-type')).toHaveTextContent('A');
    expect(first.getByTestId('dns-record-name')).toHaveTextContent('app.example.com');
    expect(first.getByTestId('dns-record-value')).toHaveTextContent('203.0.113.7');
    expect(screen.getByRole('button', { name: 'Copy A record value' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Copy AAAA record name' })).toBeInTheDocument();
    expect(screen.getByTestId('dns-cname')).toHaveTextContent('edge.example.net');
  });

  it('says the address is unknown when there are no records, and hides a CNAME without target', () => {
    renderUi(
      <DnsInstructions instructions={{ hostname: 'a.example.com', records: [], cnameAlternative: { name: 'a.example.com', target: null } }} />,
    );
    expect(screen.getByTestId('dns-no-records')).toHaveTextContent(DNS_NO_RECORDS_COPY);
    expect(screen.queryByTestId('dns-cname')).toBeNull();
  });

  it('renders values as text only', () => {
    const { container } = renderUi(
      <DnsInstructions instructions={{ hostname: 'a.example.com', records: [{ type: 'A', name: MARKUP, value: MARKUP }], cnameAlternative: null }} />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByTestId('dns-record-value')).toHaveTextContent(MARKUP);
  });
});
