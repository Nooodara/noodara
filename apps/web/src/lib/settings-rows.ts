// SET-01 (05-UI-SPEC.md SS2.7, D-16) -- the settings screen's own pure mapping from `GET
// /api/config`'s response to the two read-only groups' rows. `SettingsRow`'s own shape carries no
// field that could ever express a writable-control affordance -- D-16's "no edit affordance
// anywhere" rule made structural (a future change would have to touch this type, not quietly add
// a prop to a component) rather than a styling convention this module could accidentally drift
// away from.
import { PLACEHOLDER } from '@noodara/ui';

/** Hand-copied from `apps/control-plane/src/routes/config.ts`'s `ConfigResponseSchema` -- apps/web
 *  must never depend on a control-plane-internal module in the browser bundle (the same rule
 *  api-client.ts/error-copy.ts already document for `ServerView`/`ApiErrorCode`). Each
 *  `sshTimeouts` field is optional here even though the real backend always sends all three, so a
 *  malformed or defensively partial response degrades one row to the shared placeholder rather
 *  than this module assuming a field it was never actually given. */
export interface SettingsSshTimeouts {
  readonly connectMs?: number;
  readonly commandMs?: number;
  readonly discoveryMs?: number;
}

export interface ConfigResponse {
  readonly version: string;
  readonly publicUrl: string;
  readonly masterKeyFingerprint: string;
  readonly sshTimeouts: SettingsSshTimeouts;
  readonly workerConcurrency: number;
}

/** A single Settings row. Every value on this screen is plain text -- this type deliberately has
 *  no property that could carry a change handler or a writable-control affordance of any kind. */
export interface SettingsRow {
  readonly label: string;
  readonly value: string;
  readonly mono: true;
  readonly copyable?: true;
  readonly caption?: string;
}

export const ENV_VAR_CAPTION = 'Set by an environment variable';

/**
 * Converts a millisecond duration to a seconds string with at most one decimal place ("10s",
 * "2.5s") -- never a raw millisecond count. An `undefined`, non-finite or negative value renders
 * the shared placeholder rather than throwing. A genuinely non-zero duration is never
 * misrepresented as "0s": a sub-50ms value that would otherwise round to zero at one decimal
 * place falls back to three decimal places instead.
 */
function formatTimeoutSeconds(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) {
    return PLACEHOLDER;
  }

  const seconds = ms / 1000;
  const roundedToTenth = Math.round(seconds * 10) / 10;

  if (roundedToTenth === 0 && seconds > 0) {
    const roundedToThousandth = Math.round(seconds * 1000) / 1000;
    return `${roundedToThousandth.toString(10)}s`;
  }

  const text = Number.isInteger(roundedToTenth) ? roundedToTenth.toString(10) : roundedToTenth.toFixed(1);
  return `${text}s`;
}

/**
 * The Instance group (05-UI-SPEC.md SS2.7): always exactly two rows, version and public URL, both
 * mono, the public URL flagged copyable. Neither row carries the environment-variable caption --
 * that caption belongs to Advanced alone.
 */
export function instanceRows(config: ConfigResponse): readonly SettingsRow[] {
  return [
    { label: 'Version', value: config.version, mono: true },
    { label: 'Public URL', value: config.publicUrl, mono: true, copyable: true },
  ];
}

/**
 * The Advanced group (05-UI-SPEC.md SS2.7, D-16): always exactly five rows -- the master key
 * fingerprint, the three SSH timeouts (converted to seconds) and the worker concurrency -- every
 * one mono and every one carrying the exact `ENV_VAR_CAPTION` string.
 */
export function advancedRows(config: ConfigResponse): readonly SettingsRow[] {
  return [
    { label: 'Master key fingerprint', value: config.masterKeyFingerprint, mono: true, caption: ENV_VAR_CAPTION },
    {
      label: 'Connect timeout',
      value: formatTimeoutSeconds(config.sshTimeouts.connectMs),
      mono: true,
      caption: ENV_VAR_CAPTION,
    },
    {
      label: 'Command timeout',
      value: formatTimeoutSeconds(config.sshTimeouts.commandMs),
      mono: true,
      caption: ENV_VAR_CAPTION,
    },
    {
      label: 'Discovery timeout',
      value: formatTimeoutSeconds(config.sshTimeouts.discoveryMs),
      mono: true,
      caption: ENV_VAR_CAPTION,
    },
    {
      label: 'Worker concurrency',
      value: config.workerConcurrency.toString(10),
      mono: true,
      caption: ENV_VAR_CAPTION,
    },
  ];
}
