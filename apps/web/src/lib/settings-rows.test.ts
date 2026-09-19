import { describe, expect, it } from 'vitest';
import { PLACEHOLDER } from '@noodara/ui';
import { advancedRows, ENV_VAR_CAPTION, instanceRows, type ConfigResponse } from './settings-rows';

function buildConfig(overrides: Partial<ConfigResponse> = {}): ConfigResponse {
  return {
    version: '0.4.2',
    publicUrl: 'https://noodara.example.test',
    masterKeyFingerprint: 'a1b2c3d4e5f6a7b8',
    sshTimeouts: { connectMs: 10000, commandMs: 30000, discoveryMs: 60000 },
    workerConcurrency: 5,
    ...overrides,
  };
}

describe('instanceRows', () => {
  it('returns exactly two rows -- version and public URL -- both mono, only the URL flagged copyable', () => {
    const rows = instanceRows(buildConfig());

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ label: 'Version', value: '0.4.2', mono: true });
    expect(rows[0]?.copyable).toBeUndefined();
    expect(rows[1]).toMatchObject({
      label: 'Public URL',
      value: 'https://noodara.example.test',
      mono: true,
      copyable: true,
    });
  });

  it('carries no caption on either Instance row -- the environment-variable caption is Advanced-only', () => {
    const rows = instanceRows(buildConfig());

    for (const row of rows) {
      expect(row.caption).toBeUndefined();
    }
  });
});

describe('advancedRows', () => {
  it('returns exactly five rows, every one mono and carrying the exact environment-variable caption', () => {
    const rows = advancedRows(buildConfig());

    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.mono).toBe(true);
      expect(row.caption).toBe(ENV_VAR_CAPTION);
    }
    expect(rows.map((row) => row.label)).toEqual([
      'Master key fingerprint',
      'Connect timeout',
      'Command timeout',
      'Discovery timeout',
      'Worker concurrency',
    ]);
  });

  it('converts millisecond timeouts to a seconds string with at most one decimal place, never a raw millisecond count', () => {
    const rows = advancedRows(buildConfig({ sshTimeouts: { connectMs: 2500, commandMs: 10000, discoveryMs: 60000 } }));

    expect(rows[1]?.value).toBe('2.5s');
    expect(rows[2]?.value).toBe('10s');
    expect(rows[3]?.value).toBe('60s');
    for (const row of rows.slice(1, 4)) {
      expect(row.value).not.toBe('2500');
      expect(row.value).not.toBe('10000');
      expect(row.value).not.toBe('60000');
    }
  });

  it('never rounds a genuinely non-zero timeout down to 0s', () => {
    const rows = advancedRows(buildConfig({ sshTimeouts: { connectMs: 5, commandMs: 30000, discoveryMs: 60000 } }));

    expect(rows[1]?.value).not.toBe('0s');
    expect(rows[1]?.value).toContain('s');
  });

  it('yields the shared placeholder for a timeout field missing from a defensively partial config, rather than throwing', () => {
    const rows = advancedRows(buildConfig({ sshTimeouts: { connectMs: 10000 } }));

    expect(() => rows).not.toThrow();
    expect(rows[2]?.value).toBe(PLACEHOLDER);
    expect(rows[3]?.value).toBe(PLACEHOLDER);
  });

  it('renders the worker concurrency as a plain mono integer string', () => {
    const rows = advancedRows(buildConfig({ workerConcurrency: 8 }));

    expect(rows[4]).toMatchObject({ label: 'Worker concurrency', value: '8', mono: true, caption: ENV_VAR_CAPTION });
  });
});

describe('SettingsRow shape', () => {
  it('never exposes a field that could carry a writable-control affordance on any row from either group', () => {
    const rows = [...instanceRows(buildConfig()), ...advancedRows(buildConfig())];

    for (const row of rows) {
      const keys = Object.keys(row);
      expect(keys).not.toContain('editable');
      expect(keys).not.toContain('onChange');
      expect(keys).not.toContain('writable');
    }
  });
});
