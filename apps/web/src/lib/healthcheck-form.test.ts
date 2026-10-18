import { describe, expect, it } from 'vitest';
import { validateHealthcheckConfig } from '@noodara/domain';
import {
  buildSettingsBody,
  checkHealthcheck,
  emptyHealthcheckForm,
  healthcheckFormFromView,
  mapHealthcheckFailure,
} from './healthcheck-form';

const form = emptyHealthcheckForm();

describe('healthcheck-form (19-02)', () => {
  it('defaults to the container check with auto-rollback on and sends nothing on create', () => {
    expect(form.kind).toBe('container');
    expect(form.autoRollback).toBe(true);
    expect(buildSettingsBody(null, form, 3000)).toEqual({ ok: true, body: {}, changed: false });
  });

  it('builds an HTTP config that the domain validator accepts, port defaulting to the container port', () => {
    const check = checkHealthcheck({ ...form, kind: 'http', path: '/health', statuses: '200, 204, 300-301' }, 8080);
    expect(check.ok).toBe(true);
    if (!check.ok || check.config === null) return;
    expect(check.config).toMatchObject({ type: 'http', path: '/health', port: 8080, expectedStatuses: [200, 204, 300, 301] });
    expect(validateHealthcheckConfig(check.config).ok).toBe(true);
  });

  it('shows the same named error as the API for the same bad input', () => {
    const check = checkHealthcheck({ ...form, kind: 'http', path: 'health' }, 3000);
    const api = validateHealthcheckConfig({ type: 'http', path: 'health', port: 3000, expectedStatuses: undefined, ...form.timing });
    expect(check.ok).toBe(false);
    expect(api.ok).toBe(false);
    if (check.ok || api.ok) return;
    expect(check.errors.path).toBe(`${api.message}.`);
  });

  it('routes port and status errors to their fields', () => {
    const port = checkHealthcheck({ ...form, kind: 'tcp', port: 'abc' }, 3000);
    expect(!port.ok && port.errors.port).toMatch(/port/);
    const statuses = checkHealthcheck({ ...form, kind: 'http', statuses: '99' }, 3000);
    expect(!statuses.ok && statuses.errors.statuses).toMatch(/expectedStatuses/);
    const range = checkHealthcheck({ ...form, kind: 'http', statuses: '300-200' }, 3000);
    expect(range.ok).toBe(false);
  });

  it('create sends only non-default choices', () => {
    const plan = buildSettingsBody(null, { ...form, kind: 'tcp', port: '5432', autoRollback: false }, 3000);
    expect(plan).toMatchObject({ ok: true, changed: true, body: { autoRollback: false, healthcheck: { type: 'tcp', port: 5432 } } });
  });

  it('edit sends only what changed and reads the stored values back into the form', () => {
    const stored = checkHealthcheck({ ...form, kind: 'http', path: '/up', port: '9000' }, 3000);
    if (!stored.ok || stored.config === null) throw new Error('setup');
    const view = { healthcheck: stored.config, autoRollback: false };
    const back = healthcheckFormFromView(view);
    expect(back).toMatchObject({ kind: 'http', path: '/up', port: '9000', statuses: '', autoRollback: false });
    expect(buildSettingsBody(view, back, 3000)).toMatchObject({ ok: true, changed: false, body: {} });
    expect(buildSettingsBody(view, { ...back, autoRollback: true }, 3000)).toMatchObject({ body: { autoRollback: true } });
    expect(buildSettingsBody(view, { ...back, kind: 'container' }, 3000)).toMatchObject({ body: { healthcheck: null } });
  });

  it('maps the real 400 VALIDATION_FAILED shape to the named field', () => {
    const failure = {
      ok: false,
      code: 'VALIDATION_FAILED',
      message: 'Request does not match the schema',
      issues: [{ path: '/healthcheck', message: 'Healthcheck path must start with /' }],
      unauthorized: false,
    } as never;
    expect(mapHealthcheckFailure(failure)).toEqual({ path: 'Healthcheck path must start with /.' });
    expect(
      mapHealthcheckFailure({ ok: false, code: 'VALIDATION_FAILED', message: 'x', issues: [{ path: '/name', message: 'Required' }], unauthorized: false } as never),
    ).toBeNull();
  });

  it('maps a server healthcheck rejection and ignores other failures', () => {
    const failure = { ok: false, code: 'SERVICE_INPUT_INVALID', reason: 'HEALTHCHECK_BUDGET_EXCEEDED', message: 'Healthcheck needs up to 700 s' } as never;
    expect(mapHealthcheckFailure(failure)).toEqual({ healthcheck: 'Healthcheck needs up to 700 s.' });
    expect(mapHealthcheckFailure({ ok: false, code: 'SERVICE_INPUT_INVALID', reason: 'SERVICE_NAME', message: 'x' } as never)).toBeNull();
  });
});
