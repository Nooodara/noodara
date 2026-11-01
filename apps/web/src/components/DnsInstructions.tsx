'use client';

// 24-01: the records the user creates at their DNS provider for one domain: type, name and value
// in mono, each with a copy button. Values come from the API's dnsInstructions (server IPs and
// the CNAME target); they render as text only. The CNAME alternative is shown only when the
// server has a hostname of its own.
import { CopyButton } from '@noodara/ui';
import type { DnsInstructionsView } from '../lib/domain-api';

export const DNS_INSTRUCTIONS_INTRO_COPY = 'Create this record at your DNS provider, then run the DNS check.';
export const DNS_NO_RECORDS_COPY =
  'The server address is not known yet. Reconnect the server so Noodara can read its IP, then check again.';

export interface DnsInstructionsProps {
  readonly instructions: DnsInstructionsView;
}

function RecordRow({ type, name, value }: { readonly type: string; readonly name: string; readonly value: string }) {
  return (
    <tr data-testid="dns-record" className="align-middle">
      <td className="py-1 pr-3 font-mono text-caption text-ink" data-testid="dns-record-type">
        {type}
      </td>
      <td className="py-1 pr-3">
        <span className="flex items-center gap-1">
          <code className="break-all font-mono text-caption text-ink" data-testid="dns-record-name">
            {name}
          </code>
          <CopyButton value={name} label={`Copy ${type} record name`} />
        </span>
      </td>
      <td className="py-1">
        <span className="flex items-center gap-1">
          <code className="break-all font-mono text-caption text-ink" data-testid="dns-record-value">
            {value}
          </code>
          <CopyButton value={value} label={`Copy ${type} record value`} />
        </span>
      </td>
    </tr>
  );
}

export function DnsInstructions({ instructions }: DnsInstructionsProps) {
  const cname = instructions.cnameAlternative;
  return (
    <div data-testid="dns-instructions" className="flex flex-col gap-2">
      <p className="text-caption text-ink-secondary">{DNS_INSTRUCTIONS_INTRO_COPY}</p>
      {instructions.records.length === 0 ? (
        <p data-testid="dns-no-records" className="text-caption text-ink-secondary">
          {DNS_NO_RECORDS_COPY}
        </p>
      ) : (
        <table className="w-full text-left">
          <thead>
            <tr className="text-caption text-ink-secondary">
              <th scope="col" className="py-1 pr-3 font-normal">
                Type
              </th>
              <th scope="col" className="py-1 pr-3 font-normal">
                Name
              </th>
              <th scope="col" className="py-1 font-normal">
                Value
              </th>
            </tr>
          </thead>
          <tbody>
            {instructions.records.map((record) => (
              <RecordRow key={`${record.type}-${record.value}`} type={record.type} name={record.name} value={record.value} />
            ))}
          </tbody>
        </table>
      )}
      {cname?.target == null ? null : (
        <p data-testid="dns-cname" className="text-caption text-ink-secondary">
          Or create a <span className="font-mono">CNAME</span> record for{' '}
          <span className="font-mono text-ink">{cname.name}</span> pointing at{' '}
          <span className="font-mono text-ink">{cname.target}</span>.
        </p>
      )}
    </div>
  );
}
