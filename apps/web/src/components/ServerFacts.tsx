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
import type { ServerErrorCode } from '@noodara/domain/server';
import { LabelValue, StatTile, formatDiskUsage, formatMb, formatRelativeTime, formatUptime } from '@noodara/ui';
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
    <div className="flex flex-col gap-8">
      <div data-testid="server-facts-tiles" className="grid grid-cols-2 gap-4 sm:grid-cols-4">
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

      <div data-testid="server-facts-system" className="flex flex-col gap-1">
        <h3 className="text-label uppercase text-ink-secondary">System</h3>
        <LabelValue label="Hostname" value={server.hostname} mono dimmed={dimmed} caption={asOfCaption} />
        <div className="flex flex-col">
          <LabelValue label="OS" value={osLine(server.osDistribution, server.osVersion)} dimmed={dimmed} caption={asOfCaption} />
          {hasUnsupportedOsWarning ? (
            <p data-testid="server-fact-warning-unsupported-os" className="text-caption text-status-warn">
              {UNSUPPORTED_OS_WARNING_COPY}
            </p>
          ) : null}
        </div>
        <LabelValue label="Architecture" value={server.arch} mono dimmed={dimmed} caption={asOfCaption} />
      </div>

      <div data-testid="server-facts-docker" className="flex flex-col gap-1">
        <h3 className="text-label uppercase text-ink-secondary">Docker</h3>
        <div className="flex flex-col">
          <LabelValue label="Engine version" value={server.dockerVersion} mono dimmed={dimmed} caption={asOfCaption} />
          {hasDockerAbsentWarning ? (
            <p data-testid="server-fact-warning-docker-absent" className="text-caption text-status-warn">
              {DOCKER_ABSENT_WARNING_COPY}
            </p>
          ) : null}
        </div>
        <LabelValue label="Compose version" value={server.dockerComposeVersion} mono dimmed={dimmed} caption={asOfCaption} />
      </div>

      <div data-testid="server-facts-connection" className="flex flex-col gap-1">
        <h3 className="text-label uppercase text-ink-secondary">Connection</h3>
        <LabelValue label="Host" value={server.host} mono dimmed={dimmed} caption={asOfCaption} />
        <LabelValue label="Port" value={String(server.sshPort)} mono dimmed={dimmed} caption={asOfCaption} />
        <LabelValue label="SSH user" value={server.sshUser} mono dimmed={dimmed} caption={asOfCaption} />
        <LabelValue label="Credential" value={CREDENTIAL_TYPE_LABEL[server.credentialType]} dimmed={dimmed} caption={asOfCaption} />
        <LabelValue
          label="Host fingerprint"
          value={server.hostFingerprint}
          mono
          copyable
          dimmed={dimmed}
          {...(fingerprintCaption !== undefined ? { caption: fingerprintCaption } : {})}
        />
        <LabelValue label="Last seen" value={formatRelativeTime(server.lastSeenAt, now)} dimmed={dimmed} caption={asOfCaption} />
      </div>
    </div>
  );
}
