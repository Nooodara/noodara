// 19-02: pure state for the healthcheck and auto-rollback part of the service sheet. Validation is
// the control plane's own validateHealthcheckConfig, so the named errors match the API's.
// Default is "Container is running" (config null: the v0.2 post-start check); HTTP and TCP add
// their fields. Timing is not edited here: it keeps the stored value, or the domain default.
import {
  DEFAULT_CONTAINER_HEALTHCHECK,
  validateHealthcheckConfig,
  type HealthcheckConfig,
  type HealthcheckTiming,
} from '@noodara/domain';
import type { ApiFailure, DeployApiErrorCode } from './api-client';
import type { ServiceView } from './deploy-api';

export type HealthcheckKind = 'container' | 'http' | 'tcp';

export const HEALTHCHECK_KIND_OPTIONS = [
  { value: 'container', label: 'Container is running', help: 'The default. The deploy passes once the container stays up.' },
  { value: 'http', label: 'HTTP request', help: 'The deploy passes when a path answers with an expected status.' },
  { value: 'tcp', label: 'TCP connection', help: 'The deploy passes when a port accepts connections.' },
] as const satisfies readonly { value: HealthcheckKind; label: string; help: string }[];

export const SETTINGS_NEXT_DEPLOY_COPY = 'Healthcheck and rollback changes apply on the next deploy.';
export const AUTO_ROLLBACK_LABEL = 'Roll back automatically';
export const AUTO_ROLLBACK_HELP =
  'If a new deploy fails its healthcheck, restore the previous version. Turn it off to leave the failed deploy for you to inspect.';

export interface HealthcheckFormValues {
  readonly kind: HealthcheckKind;
  readonly path: string;
  /** Empty = the container port. */
  readonly port: string;
  /** Empty = any 2xx or 3xx; otherwise codes and ranges such as "200, 204, 300-399". */
  readonly statuses: string;
  readonly autoRollback: boolean;
  readonly timing: HealthcheckTiming;
}

export type HealthcheckFormField = 'kind' | 'path' | 'port' | 'statuses' | 'healthcheck';
export type HealthcheckFormErrors = Partial<Record<HealthcheckFormField, string>>;

function timingOf(config: HealthcheckConfig): HealthcheckTiming {
  return {
    probeTimeoutS: config.probeTimeoutS,
    intervalS: config.intervalS,
    retries: config.retries,
    startPeriodS: config.startPeriodS,
  };
}

export function emptyHealthcheckForm(): HealthcheckFormValues {
  return {
    kind: 'container',
    path: '/',
    port: '',
    statuses: '',
    autoRollback: true,
    timing: timingOf(DEFAULT_CONTAINER_HEALTHCHECK),
  };
}

/** Collapse a status list back to the compact "200-399" form the user typed. */
function formatStatuses(statuses: readonly number[]): string {
  const sorted = [...statuses].sort((a, b) => a - b);
  const parts: string[] = [];
  let index = 0;
  while (index < sorted.length) {
    const start = sorted[index] ?? 0;
    let end = start;
    while (sorted[index + 1] === end + 1) {
      index += 1;
      end += 1;
    }
    parts.push(end === start ? String(start) : `${String(start)}-${String(end)}`);
    index += 1;
  }
  return parts.join(', ');
}

export function healthcheckFormFromView(view: Pick<ServiceView, 'healthcheck' | 'autoRollback'>): HealthcheckFormValues {
  const base = emptyHealthcheckForm();
  const autoRollback = view.autoRollback ?? true;
  const config = view.healthcheck ?? null;
  if (config === null) return { ...base, autoRollback };
  if (config.type === 'container') return { ...base, autoRollback, timing: timingOf(config) };
  if (config.type === 'tcp') return { ...base, kind: 'tcp', port: String(config.port), autoRollback, timing: timingOf(config) };
  const isDefault = config.expectedStatuses.length === 200 && formatStatuses(config.expectedStatuses) === '200-399';
  return {
    ...base,
    kind: 'http',
    path: config.path,
    port: String(config.port),
    statuses: isDefault ? '' : formatStatuses(config.expectedStatuses),
    autoRollback,
    timing: timingOf(config),
  };
}

function sentence(message: string): string {
  return message.endsWith('.') ? message : `${message}.`;
}

function parsePort(text: string, fallback: number): number {
  const trimmed = text.trim();
  if (trimmed === '') return fallback;
  return /^\d{1,5}$/.test(trimmed) ? Number(trimmed) : Number.NaN;
}

/** undefined = the domain default; NaN entries make the domain validator reject the list. */
function parseStatuses(text: string): number[] | undefined {
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  const result: number[] = [];
  for (const token of trimmed.split(/[\s,]+/).filter((part) => part !== '')) {
    const range = /^(\d{3})-(\d{3})$/.exec(token);
    if (range !== null) {
      const low = Number(range[1]);
      const high = Number(range[2]);
      if (high < low || high - low > 500) {
        result.push(Number.NaN);
        continue;
      }
      for (let code = low; code <= high; code += 1) result.push(code);
    } else {
      result.push(/^\d{3}$/.test(token) ? Number(token) : Number.NaN);
    }
  }
  return result;
}

function fieldOf(message: string): HealthcheckFormField {
  if (message.includes('expectedStatuses')) return 'statuses';
  if (message.includes('path')) return 'path';
  if (message.includes('port')) return 'port';
  return 'healthcheck';
}

export type HealthcheckCheck =
  | { readonly ok: true; readonly config: HealthcheckConfig | null }
  | { readonly ok: false; readonly errors: HealthcheckFormErrors };

/** null config = the default container check. */
export function checkHealthcheck(form: HealthcheckFormValues, containerPort: number): HealthcheckCheck {
  if (form.kind === 'container') return { ok: true, config: null };
  const common = { ...form.timing, port: parsePort(form.port, containerPort) };
  const raw =
    form.kind === 'tcp'
      ? { type: 'tcp', ...common }
      : { type: 'http', path: form.path.trim(), expectedStatuses: parseStatuses(form.statuses), ...common };
  const result = validateHealthcheckConfig(raw);
  if (!result.ok) return { ok: false, errors: { [fieldOf(result.message)]: sentence(result.message) } };
  return { ok: true, config: result.value };
}

export interface ServiceSettingsBody {
  readonly healthcheck?: HealthcheckConfig | null;
  readonly autoRollback?: boolean;
}

export type SettingsPlan =
  | { readonly ok: true; readonly body: ServiceSettingsBody; readonly changed: boolean }
  | { readonly ok: false; readonly errors: HealthcheckFormErrors };

/** Create (current null): only non-default choices are sent. Edit: only what changed. */
export function buildSettingsBody(
  current: Pick<ServiceView, 'healthcheck' | 'autoRollback'> | null,
  form: HealthcheckFormValues,
  containerPort: number,
): SettingsPlan {
  const check = checkHealthcheck(form, containerPort);
  if (!check.ok) return check;
  const body: { healthcheck?: HealthcheckConfig | null; autoRollback?: boolean } = {};
  if (current === null) {
    if (check.config !== null) body.healthcheck = check.config;
    if (!form.autoRollback) body.autoRollback = false;
    return { ok: true, body, changed: Object.keys(body).length > 0 };
  }
  const stored = current.healthcheck ?? null;
  // A stored container config with custom timing stays as it is while the kind is "container".
  const wanted = check.config === null && stored?.type === 'container' ? stored : check.config;
  if (JSON.stringify(wanted) !== JSON.stringify(stored)) body.healthcheck = wanted;
  if (form.autoRollback !== (current.autoRollback ?? true)) body.autoRollback = form.autoRollback;
  return { ok: true, body, changed: Object.keys(body).length > 0 };
}

/** Field errors for a server rejection of the healthcheck; null when it is about something else.
 *  The route schema answers 400 VALIDATION_FAILED with an issue at `/healthcheck`; the service's
 *  own 422 SERVICE_INPUT_INVALID with a HEALTHCHECK_ reason is mapped the same way. */
export function mapHealthcheckFailure(failure: ApiFailure<DeployApiErrorCode>): HealthcheckFormErrors | null {
  if (failure.code === 'VALIDATION_FAILED') {
    const issue = (failure.issues ?? []).find((entry) => entry.path === '/healthcheck' || entry.path.startsWith('/healthcheck/'));
    if (issue === undefined) return null;
    const message = issue.message.trim() === '' ? 'The server rejected this healthcheck.' : sentence(issue.message);
    return { [fieldOf(message)]: message };
  }
  if (failure.code !== 'SERVICE_INPUT_INVALID' || !(failure.reason ?? '').startsWith('HEALTHCHECK_')) return null;
  const message = failure.message.trim() === '' ? 'The server rejected this healthcheck.' : sentence(failure.message);
  return { [fieldOf(message)]: message };
}
