import { execFileSync } from 'node:child_process';
import { DISCOVERY_CHECK_IDS } from '@noodara/domain/discovery';
import { describe, expect, it } from 'vitest';
import { COMMAND_NAMES, COMMAND_TEMPLATES, commandFor, escapeShellArg, type CommandName } from './allowlist.js';

// The exactness guard SEC-04 requires (02-CONTEXT.md, Pitfall 9 / Dokploy GHSA-fcgq-jjfg-hrhj).
// Hand-written once here as this test's independent expectation of the allowlist, mirroring the
// "table generated mechanically from the frozen tuple" style of
// packages/domain/src/server/server-state.test.ts — adding a 12th template without updating this
// list fails the suite.
const EXPECTED_COMMAND_NAMES: readonly CommandName[] = [
  'discovery.hostname',
  'discovery.os_release',
  'discovery.arch',
  'discovery.cpu',
  'discovery.memory',
  'discovery.disk',
  'discovery.uptime',
  'docker.version',
  'docker.compose_version',
  'access.sudo',
  'access.docker_group',
];

describe('COMMAND_NAMES', () => {
  it('is exactly the 11 expected names, in order', () => {
    expect(COMMAND_NAMES).toEqual(EXPECTED_COMMAND_NAMES);
  });

  it('has exactly 11 entries', () => {
    expect(COMMAND_NAMES.length).toBe(11);
  });

  it('matches the keys of COMMAND_TEMPLATES exactly', () => {
    expect(Object.keys(COMMAND_TEMPLATES).sort()).toEqual([...COMMAND_NAMES].sort());
  });
});

describe('COMMAND_TEMPLATES', () => {
  it('contains no interpolation marker (`${`) in any template', () => {
    for (const template of Object.values(COMMAND_TEMPLATES)) {
      expect(template.includes('${'), `template "${template}" contains an interpolation marker`).toBe(
        false,
      );
    }
  });

  it('contains no backtick in any template', () => {
    for (const template of Object.values(COMMAND_TEMPLATES)) {
      expect(template.includes('`'), `template "${template}" contains a backtick`).toBe(false);
    }
  });

  it('contains no command substitution marker (`$(`) in any template', () => {
    for (const template of Object.values(COMMAND_TEMPLATES)) {
      expect(template.includes('$('), `template "${template}" contains a $( marker`).toBe(false);
    }
  });
});

describe('commandFor', () => {
  it.each(EXPECTED_COMMAND_NAMES)('returns the fixed template for %s', (name) => {
    expect(commandFor(name)).toBe(COMMAND_TEMPLATES[name]);
  });

  it('has arity 1 (no argument parameter — no v0.1 template takes one)', () => {
    expect(commandFor.length).toBe(1);
  });
});

describe('access.sudo', () => {
  it('is exactly "sudo -n true", never a bare sudo (Pitfall 3: bare sudo hangs on a missing TTY)', () => {
    expect(commandFor('access.sudo')).toBe('sudo -n true');
  });
});

describe('docker.version', () => {
  it('uses --format \'{{json .}}\' (structured output only, Pitfall 6: no free-text parsing)', () => {
    expect(commandFor('docker.version')).toBe("docker version --format '{{json .}}'");
  });
});

describe('docker.compose_version', () => {
  it('uses the v2 `docker compose` plugin subcommand, never the v1 `docker-compose` binary', () => {
    expect(commandFor('docker.compose_version')).toBe('docker compose version --short');
  });
});

describe('CommandName <-> DiscoveryCheckId correspondence', () => {
  it('has exactly one DiscoveryCheckId for every CommandName and vice versa', () => {
    expect(COMMAND_NAMES.length).toBe(DISCOVERY_CHECK_IDS.length);
    expect(DISCOVERY_CHECK_IDS.length).toBe(11);
  });
});

describe('escapeShellArg', () => {
  it('wraps a plain value in single quotes', () => {
    expect(escapeShellArg('a b')).toBe("'a b'");
  });

  it('round-trips a value containing a single quote through a POSIX shell', () => {
    const original = "it's a test";
    const escaped = escapeShellArg(original);
    const output = execFileSync('/bin/sh', ['-c', `printf '%s' ${escaped}`], { encoding: 'utf8' });
    expect(output).toBe(original);
  });

  it('round-trips a value with spaces, quotes and shell metacharacters through a POSIX shell', () => {
    const original = "a b'c $(echo pwned) `echo pwned` ${HOME} & | ; > <";
    const escaped = escapeShellArg(original);
    const output = execFileSync('/bin/sh', ['-c', `printf '%s' ${escaped}`], { encoding: 'utf8' });
    expect(output).toBe(original);
  });

  it('rejects nothing and applies no blocklist — every character is quoted through unchanged except the quote itself', () => {
    const original = 'rm -rf / --no-preserve-root';
    const escaped = escapeShellArg(original);
    expect(escaped).toBe("'rm -rf / --no-preserve-root'");
  });
});
