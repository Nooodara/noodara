import { describe, expect, it } from 'vitest';
import { ADVERSARIAL_VALUES, shellWords } from '../testing/shell-round-trip.js';
import { DEPLOY_COMMAND_NAMES, type DeployCommandName } from './deploy-allowlist.js';
import { createRemoteCommand, renderRemoteCommand, type RemoteCommand } from './remote-command.js';
import { SHELL_SCRIPTS } from './shell-scripts.js';

// Exactness guard for the deploy allowlist (SVC-08, ROADMAP criterion 4). Hand-written on purpose:
// adding a template without updating this list fails the suite.
const EXPECTED_DEPLOY_COMMAND_NAMES: readonly DeployCommandName[] = [
  'git.clone',
  'git.checkout',
  'git.head_sha',
  'git.probe_features',
  'fs.prepare_workspace',
  'fs.remove_deploy_dir',
  'secrets.write_file',
  'secrets.write_askpass',
  'process.supervise',
  'process.kill_group',
  'process.group_alive',
  'docker.login',
  'docker.logout',
  'docker.pull',
  'docker.build',
  'docker.image_remove',
  'docker.network_create',
  'docker.network_remove',
  'docker.create',
  'docker.start',
  'docker.stop',
  'docker.restart',
  'docker.remove',
  'docker.inspect',
  'docker.logs',
  'docker.ps',
  'docker.kill',
];

// ADR 0008 text, copied by hand. G1: secret file and workspace; G2: launcher and group kill.
const ADR_0008_SCRIPTS = {
  writeSecretFromStdin: 'umask 077 && cat > "$0"',
  prepareWorkspace: 'umask 077 && mkdir -p "$0/secrets" "$0/run"',
  supervise: 'echo $$ > "$0"; exec "$@"',
  killGroup: 'read -r pgid < "$0" && kill -s TERM -- "-$pgid"',
} as const;

const DOLLAR = String.fromCharCode(36);
const BACKTICK = String.fromCharCode(96);
const INTERPOLATION_MARKER = DOLLAR + String.fromCharCode(123);
const COMMAND_SUBSTITUTION_MARKER = DOLLAR + String.fromCharCode(40);
const ALLOWED_PARAMETERS = new Set(['0', '@', DOLLAR, 'pgid', 'submodules', 'lfs']);

describe('DEPLOY_COMMAND_NAMES', () => {
  it('is exactly the 27 expected names, in order', () => {
    expect(DEPLOY_COMMAND_NAMES).toEqual(EXPECTED_DEPLOY_COMMAND_NAMES);
    expect(DEPLOY_COMMAND_NAMES).toHaveLength(27);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(DEPLOY_COMMAND_NAMES)).toBe(true);
  });
});

describe('SHELL_SCRIPTS', () => {
  const entries = Object.entries(SHELL_SCRIPTS);

  it('is frozen and holds exactly the known scripts', () => {
    expect(Object.isFrozen(SHELL_SCRIPTS)).toBe(true);
    expect(Object.keys(SHELL_SCRIPTS).sort()).toEqual(
      [
        'groupAlive',
        'killGroup',
        'prepareWorkspace',
        'probeFeatures',
        'supervise',
        'writeAskpassFromStdin',
        'writeSecretFromStdin',
      ].sort(),
    );
  });

  it.each(Object.entries(ADR_0008_SCRIPTS))('%s equals the ADR 0008 text', (key, text) => {
    expect(SHELL_SCRIPTS[key as keyof typeof ADR_0008_SCRIPTS]).toBe(text);
  });

  it('killGroup uses `kill -s TERM`, never the form dash rejects (ADR 0008 G2)', () => {
    expect(SHELL_SCRIPTS.killGroup).not.toContain('kill -TERM');
  });

  it('groupAlive reads the pgid from the pidfile and asks pgrep for the group', () => {
    expect(SHELL_SCRIPTS.groupAlive).toBe('read -r pgid < "$0" && pgrep -g "$pgid" > /dev/null');
  });

  it('writeAskpassFromStdin writes 0600 under umask 077, then makes it executable by the owner only', () => {
    expect(SHELL_SCRIPTS.writeAskpassFromStdin).toBe('umask 077 && cat > "$0" && chmod 0700 "$0"');
  });

  it.each(entries)(
    '%s contains no interpolation marker, backtick or command substitution',
    (_, script) => {
      expect(script.includes(INTERPOLATION_MARKER)).toBe(false);
      expect(script.includes(BACKTICK)).toBe(false);
      expect(script.includes(COMMAND_SUBSTITUTION_MARKER)).toBe(false);
    },
  );

  it.each(entries)(
    '%s references only positional parameters, $$ or its own locals',
    (_, script) => {
      const dollars = script.split(DOLLAR).length - 1;
      const references = [...script.matchAll(/[$]([0-9@$]|[A-Za-z_][A-Za-z0-9_]*)/g)];
      const names = references.map((match) => match[1] ?? '');

      // `$$` is one reference made of two dollar characters.
      const consumed = names.reduce((total, name) => total + (name === DOLLAR ? 2 : 1), 0);
      expect(consumed).toBe(dollars);
      for (const name of names) expect(ALLOWED_PARAMETERS.has(name), name).toBe(true);
    },
  );

  it('probeFeatures prints exactly the submodules and lfs lines', () => {
    expect(SHELL_SCRIPTS.probeFeatures).toContain('echo "submodules=$submodules"');
    expect(SHELL_SCRIPTS.probeFeatures).toContain('echo "lfs=$lfs"');
    expect(SHELL_SCRIPTS.probeFeatures).toContain('.gitmodules');
    expect(SHELL_SCRIPTS.probeFeatures).toContain('160000');
    expect(SHELL_SCRIPTS.probeFeatures).toContain('filter=lfs');
    expect(SHELL_SCRIPTS.probeFeatures).toContain('version https://git-lfs.github.com/spec/v1');
  });
});

describe('renderRemoteCommand', () => {
  it('quotes every argv token and joins them with one space', () => {
    const command = createRemoteCommand({
      name: 'docker.ps',
      argv: ['docker', 'ps'],
      stdin: 'none',
      supervisable: false,
    });

    expect(renderRemoteCommand(command)).toBe("'docker' 'ps'");
  });

  it('round-trips adversarial tokens through a real POSIX shell as literal words', () => {
    const argv: [string, ...string[]] = ['echo', ...ADVERSARIAL_VALUES];
    const command = createRemoteCommand({
      name: 'docker.logs',
      argv,
      stdin: 'none',
      supervisable: false,
    });

    expect(shellWords(renderRemoteCommand(command))).toEqual(argv);
  });
});

describe('RemoteCommand', () => {
  it('is frozen, argv included', () => {
    const command = createRemoteCommand({
      name: 'docker.ps',
      argv: ['docker', 'ps'],
      stdin: 'none',
      supervisable: false,
    });

    expect(Object.isFrozen(command)).toBe(true);
    expect(Object.isFrozen(command.argv)).toBe(true);
  });

  it('copies argv, so a caller cannot mutate the command after creation', () => {
    const argv: [string, ...string[]] = ['docker', 'ps'];
    const command = createRemoteCommand({
      name: 'docker.ps',
      argv,
      stdin: 'none',
      supervisable: false,
    });

    argv.push('--privileged');

    expect(command.argv).toEqual(['docker', 'ps']);
  });

  it('cannot be forged as an object literal outside the commands module', () => {
    // @ts-expect-error the RemoteCommand brand is module-private (T-11-34)
    const forged: RemoteCommand = {
      name: 'docker.ps',
      argv: ['docker', 'ps'],
      stdin: 'none',
      supervisable: false,
    };

    expect(forged.name).toBe('docker.ps');
  });
});
