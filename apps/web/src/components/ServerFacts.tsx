// The server detail screen's facts (DETL-01, 05-UI-SPEC.md SS2.5/D-11): four stat tiles (CPU
// cores, RAM, disk used-of-total with its 1px meter, uptime), each "as of" the discovery's own
// `lastSeenAt`, and three label/value groups -- System, Docker, Connection. Every group value also
// carries the same "as of" caption -- these are point-in-time facts from the last discovery run,
// never a live-updating metric (D-11/T-5-61). Never renders a credential value: `ServerView`
// structurally cannot carry one (SEC-02), so only `credentialType` appears here.
//
// `dimmed` forwards to every tile/row for DETL-02's "facts from the last good discovery stay
// visible, attenuated" treatment when a newer discovery run has since failed.
//
// `warnings` carries only `UNSUPPORTED_OS` in this plan -- the only ServerView-derivable warning
// code (`lastErrorCode` can be `'UNSUPPORTED_OS'` while `status` stays `CONNECTED`, per
// packages/domain/src/server/connection-result.ts's `statusForErrorCode`). The Docker-absent
// warning is derived directly from `dockerInstalled === false`, a real ServerView field. The
// no-passwordless-sudo and not-in-docker-group warnings from 05-UI-SPEC.md SS5.5 are NOT rendered
// here: `ServerView`/`DiscoveryFacts` carry no `sudo`/`docker_group` field at all -- that state
// only exists inside a discovery run's own `DiscoveryCheck` records, reachable only through the
// discovery read endpoint Plan 05-18's Discovery section owns. Rendering them here would mean
// inventing data this component was never given, which D-05's "never invent progress" rule
// (05-CONTEXT.md) forbids in spirit even outside the Discovery section itself.
import type { CSSProperties } from 'react';
import type { ServerErrorCode } from '@noodara/domain/server';
import {
  Fingerprint,
  InsetGroup,
  LabelValue,
  PLACEHOLDER,
  StatTile,
  formatDiskUsage,
  formatMb,
  formatRelativeTime,
  formatUptime,
} from '@noodara/ui';
import type { ServerView } from '../lib/api-client';

const CREDENTIAL_TYPE_LABEL: Record<ServerView['credentialType'], string> = {
  ssh_private_key: 'Private key',
  ssh_password: 'Password',
};

const UNSUPPORTED_OS_WARNING_COPY =
  'Outside the supported matrix (Ubuntu 22.04/24.04). Some features may not work as expected.';
const DOCKER_ABSENT_WARNING_COPY =
  'Docker is not installed on this server. Install Docker to prepare it for future deployments.';

export interface ServerFactsProps {
  readonly server: ServerView;
  /** The caller's own clock, explicit -- matches `format.ts`/`RelativeTime`'s own no-platform-
   *  clock discipline so every "as of" caption here is deterministic in tests. */
  readonly now: Date;
  readonly dimmed?: boolean;
  readonly warnings?: readonly ServerErrorCode[];
}

function osLine(osDistribution: string | null, osVersion: string | null): string | null {
  const parts = [osDistribution, osVersion].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(' ');
}

export function ServerFacts({ server, now, dimmed = false, warnings = [] }: ServerFactsProps) {
  const asOfCaption = `as of ${formatRelativeTime(server.lastSeenAt, now)}`;
  const fingerprintCaption =
    server.hostFingerprint === null ? undefined : `captured ${formatRelativeTime(server.hostFingerprintCapturedAt, now)}`;
  const disk = formatDiskUsage(server.diskUsedMb, server.diskTotalMb);
  const hasUnsupportedOsWarning = warnings.includes('UNSUPPORTED_OS');
  const hasDockerAbsentWarning = server.dockerInstalled === false;

  return (
    <div className="flex flex-col gap-6">
      {/* 08-11-PLAN.md Task 3 round 1 (deferred-items.md, server-detail-light-375.png): a fixed
          two-column grid left each tile too narrow at 375px for the widest mono value ("176.3 GB
          of 910.7 GB" for Disk), wrapping it across three lines. Below 480px the tiles stack to a
          single column so each one gets the full container width; `min-[480px]:grid-cols-2` keeps
          the two-column layout on the wider small-phone/tablet range, and `sm:grid-cols-4` (the
          desktop four-across layout) is unchanged. */}
      <div data-testid="server-facts-tiles" className="grid grid-cols-1 gap-4 min-[480px]:grid-cols-2 sm:grid-cols-4">
        <StatTile data-testid="server-fact-cpu-cores" label="CPU cores" value={server.cpuCores} caption={asOfCaption} dimmed={dimmed} />
        <StatTile
          data-testid="server-fact-ram"
          label="RAM"
          value={formatMb(server.ramMb)}
          caption={asOfCaption}
          dimmed={dimmed}
        />
        <StatTile
          data-testid="server-fact-disk"
          label="Disk"
          value={disk.text}
          caption={asOfCaption}
          meterFraction={disk.fraction}
          dimmed={dimmed}
        />
        <StatTile
          data-testid="server-fact-uptime"
          label="Uptime"
          value={formatUptime(server.uptimeSeconds)}
          caption={asOfCaption}
          dimmed={dimmed}
        />
      </div>

      {/* 08-19-PLAN.md Task 3 (G3 adjustment round 1, item 1): InsetGroup's own row wrapper
          (packages/ui/src/InsetGroup.tsx) carries only the hairline separator, never a horizontal
          inset -- ServerList's rows get theirs from ListRow's own `px-4`, which these plain
          label/value rows never had. Every row here (and its warning line) now wraps in an
          explicit `px-4` div rather than changing `LabelValue` itself, which stays the shared
          primitive `ActivityRow`'s own (differently-inset) disclosure rows also render through. */}
      <InsetGroup title="System" data-testid="server-facts-system">
        <div className="px-4">
          <LabelValue label="Hostname" value={server.hostname} mono dimmed={dimmed} caption={asOfCaption} />
        </div>
        <div className="flex flex-col px-4">
          <LabelValue label="OS" value={osLine(server.osDistribution, server.osVersion)} dimmed={dimmed} caption={asOfCaption} />
          {hasUnsupportedOsWarning ? (
            <p data-testid="server-fact-warning-unsupported-os" className="text-caption text-status-warn">
              {UNSUPPORTED_OS_WARNING_COPY}
            </p>
          ) : null}
        </div>
        <div className="px-4">
          <LabelValue label="Architecture" value={server.arch} mono dimmed={dimmed} caption={asOfCaption} />
        </div>
      </InsetGroup>

      <InsetGroup title="Docker" data-testid="server-facts-docker">
        <div className="flex flex-col px-4">
          <LabelValue label="Engine version" value={server.dockerVersion} mono dimmed={dimmed} caption={asOfCaption} />
          {hasDockerAbsentWarning ? (
            <p data-testid="server-fact-warning-docker-absent" className="text-caption text-status-warn">
              {DOCKER_ABSENT_WARNING_COPY}
            </p>
          ) : null}
        </div>
        <div className="px-4">
          <LabelValue label="Compose version" value={server.dockerComposeVersion} mono dimmed={dimmed} caption={asOfCaption} />
        </div>
      </InsetGroup>

      <InsetGroup title="Connection" data-testid="server-facts-connection">
        <div className="px-4">
          <LabelValue label="Host" value={server.host} mono dimmed={dimmed} caption={asOfCaption} />
        </div>
        <div className="px-4">
          <LabelValue label="Port" value={String(server.sshPort)} mono dimmed={dimmed} caption={asOfCaption} />
        </div>
        <div className="px-4">
          <LabelValue label="SSH user" value={server.sshUser} mono dimmed={dimmed} caption={asOfCaption} />
        </div>
        <div className="px-4">
          <LabelValue label="Credential" value={CREDENTIAL_TYPE_LABEL[server.credentialType]} dimmed={dimmed} caption={asOfCaption} />
        </div>
        {/* 08-17-PLAN.md Task 2 (D-10): the "Host fingerprint" row swaps `LabelValue mono copyable`
            for the shared `Fingerprint` component -- only this row, every other row above/below
            keeps `LabelValue` unchanged. Reproduces `LabelValue`'s own row layout (label at
            `text-caption text-ink-secondary`, caption + value on the trailing side) since
            `LabelValue` itself has no slot for a custom value renderer. `dimmed` is applied by
            locally overriding the `--color-ink` custom property Tailwind's `text-ink` utility
            reads (Fingerprint's own single-mode blocks render `text-ink`) -- CSS custom
            properties inherit down the DOM tree, so this affects only Fingerprint's block spans,
            never the label/caption (`text-ink-secondary`/`text-ink-tertiary`, untouched). */}
        <div data-dimmed={dimmed ? 'true' : 'false'} className="flex items-center justify-between gap-4 px-4 py-2">
          <span className="text-caption text-ink-secondary">Host fingerprint</span>
          <div className="flex items-center gap-2">
            {fingerprintCaption !== undefined ? <span className="text-caption text-ink-tertiary">{fingerprintCaption}</span> : null}
            {server.hostFingerprint === null ? (
              <span data-mono="true" className="text-callout text-ink-tertiary">
                {PLACEHOLDER}
              </span>
            ) : (
              <div style={dimmed ? ({ '--color-ink': 'var(--ink-tertiary)' } as CSSProperties) : undefined}>
                <Fingerprint value={server.hostFingerprint} copyLabel="Copy Host fingerprint" />
              </div>
            )}
          </div>
        </div>
        <div className="px-4">
          <LabelValue label="Last seen" value={formatRelativeTime(server.lastSeenAt, now)} dimmed={dimmed} caption={asOfCaption} />
        </div>
      </InsetGroup>
    </div>
  );
}
