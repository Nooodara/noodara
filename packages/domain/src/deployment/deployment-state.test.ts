import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DeploymentLogChunkViewSchema,
  DeploymentViewSchema,
} from '../api-contract/deployment-schemas.js';
import { DomainViewSchema, EnvScopeSchema, ProxyViewSchema } from '../api-contract/v04-schemas.js';
import { CERT_STATUSES, DNS_OUTCOMES } from '../domain/index.js';
import { ENV_SCOPES } from '../env/index.js';
import { PROXY_STATUSES } from '../proxy/index.js';
import { DEPLOYMENT_ERROR_CODES } from './deployment-error.js';
import {
  DEPLOYMENT_LOG_PHASES,
  DEPLOYMENT_STATUSES,
  DEPLOYMENT_TRIGGERS,
  InvalidDeploymentTransitionError,
  NON_TERMINAL_DEPLOYMENT_STATUSES,
  TERMINAL_DEPLOYMENT_STATUSES,
  type DeploymentStatus,
  type DeploymentTrigger,
  applyDeploymentTransition,
  canTransitionDeployment,
  deploymentCancelRejection,
  isTerminalDeploymentStatus,
  transitionDeployment,
} from './deployment-state.js';

// Allowed edges, hand-written as the test's independent expectation (ADR 0010 A4). The
// cross-product below is generated from DEPLOYMENT_STATUSES, so adding a state or widening the
// table without updating this list fails the suite.
const UNGATED_EDGES: readonly (readonly [DeploymentStatus, DeploymentStatus])[] = [
  ['QUEUED', 'PREPARING'],
  // 14-08: a QUEUED row whose job never reached the queue ends FAILED/ENQUEUE_FAILED.
  ['QUEUED', 'FAILED'],
  ['QUEUED', 'CANCELLED'],
  ['PREPARING', 'BUILDING'],
  ['PREPARING', 'FAILED'],
  ['PREPARING', 'CANCELLED'],
  ['BUILDING', 'DEPLOYING'],
  ['BUILDING', 'FAILED'],
  ['BUILDING', 'CANCELLED'],
  ['DEPLOYING', 'HEALTHCHECK'],
  ['DEPLOYING', 'ROLLING_BACK'],
  ['DEPLOYING', 'FAILED'],
  ['DEPLOYING', 'CANCELLED'],
  ['HEALTHCHECK', 'SUCCESS'],
  ['HEALTHCHECK', 'ROLLING_BACK'],
  ['HEALTHCHECK', 'FAILED'],
  ['HEALTHCHECK', 'CANCELLED'],
  ['ROLLING_BACK', 'ROLLED_BACK'],
  ['ROLLING_BACK', 'FAILED'],
];

/** ADR 0010 A4: a manual rollback row skips BUILDING (it reuses the known image). */
const ROLLBACK_ONLY_EDGE = ['PREPARING', 'DEPLOYING'] as const;

const isUngated = (from: DeploymentStatus, to: DeploymentStatus): boolean =>
  UNGATED_EDGES.some(([f, t]) => f === from && t === to);

const isRollbackOnly = (from: DeploymentStatus, to: DeploymentStatus): boolean =>
  from === ROLLBACK_ONLY_EDGE[0] && to === ROLLBACK_ONLY_EDGE[1];

const isAllowed = (
  from: DeploymentStatus,
  to: DeploymentStatus,
  trigger: DeploymentTrigger | undefined,
): boolean => isUngated(from, to) || (isRollbackOnly(from, to) && trigger === 'rollback');

const ALL_PAIRS: readonly (readonly [DeploymentStatus, DeploymentStatus])[] =
  DEPLOYMENT_STATUSES.flatMap((from) => DEPLOYMENT_STATUSES.map((to) => [from, to] as const));

const TRIGGERS_OR_NONE: readonly (DeploymentTrigger | undefined)[] = [
  undefined,
  ...DEPLOYMENT_TRIGGERS,
];

const TERMINALS = ['SUCCESS', 'FAILED', 'ROLLED_BACK', 'CANCELLED'] as const;

function caughtFrom(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectInvalid(fn: () => unknown, from: DeploymentStatus, to: DeploymentStatus): void {
  const caught = caughtFrom(fn);
  expect(caught).toBeInstanceOf(InvalidDeploymentTransitionError);
  const error = caught as InvalidDeploymentTransitionError;
  expect(error.from).toBe(from);
  expect(error.to).toBe(to);
  expect(error.name).toBe('InvalidDeploymentTransitionError');
  expect(error.message).toBe(`Invalid deployment transition: ${from} -> ${to}`);
}

describe('DEPLOYMENT_STATUSES', () => {
  it('has exactly the ten roadmap states, in roadmap order (§8.2)', () => {
    expect([...DEPLOYMENT_STATUSES]).toEqual([
      'QUEUED',
      'PREPARING',
      'BUILDING',
      'DEPLOYING',
      'HEALTHCHECK',
      'SUCCESS',
      'FAILED',
      'ROLLING_BACK',
      'ROLLED_BACK',
      'CANCELLED',
    ]);
  });

  it('produces a 100-pair cross-product', () => {
    expect(ALL_PAIRS.length).toBe(100);
    expect(new Set(ALL_PAIRS.map(([f, t]) => `${f}>${t}`)).size).toBe(100);
  });

  it('splits into disjoint non-terminal and terminal sets covering every state', () => {
    const nonTerminal: readonly string[] = NON_TERMINAL_DEPLOYMENT_STATUSES;
    const terminal: readonly string[] = TERMINAL_DEPLOYMENT_STATUSES;

    expect([...nonTerminal]).toEqual([
      'QUEUED',
      'PREPARING',
      'BUILDING',
      'DEPLOYING',
      'HEALTHCHECK',
      'ROLLING_BACK',
    ]);
    expect([...terminal]).toEqual([...TERMINALS]);
    expect(nonTerminal.filter((s) => terminal.includes(s))).toEqual([]);
    expect([...nonTerminal, ...terminal].sort()).toEqual([...DEPLOYMENT_STATUSES].sort());
  });

  it('every tuple is frozen', () => {
    for (const tuple of [
      DEPLOYMENT_STATUSES,
      NON_TERMINAL_DEPLOYMENT_STATUSES,
      TERMINAL_DEPLOYMENT_STATUSES,
      DEPLOYMENT_TRIGGERS,
      DEPLOYMENT_LOG_PHASES,
    ]) {
      expect(Object.isFrozen(tuple)).toBe(true);
    }
  });
});

describe('DEPLOYMENT_TRIGGERS / DEPLOYMENT_LOG_PHASES', () => {
  it('adds webhook and rollback triggers in v0.3', () => {
    expect([...DEPLOYMENT_TRIGGERS]).toEqual(['manual', 'redeploy', 'webhook', 'rollback']);
  });

  it('adds the healthcheck and rollback log phases in v0.3', () => {
    expect([...DEPLOYMENT_LOG_PHASES]).toEqual([
      'prepare',
      'build',
      'deploy',
      'healthcheck',
      'rollback',
    ]);
  });
});

describe('canTransitionDeployment (all 100 ordered pairs, every trigger)', () => {
  it.each(ALL_PAIRS)('from %s to %s matches the allowed-edge table', (from, to) => {
    for (const trigger of TRIGGERS_OR_NONE) {
      expect(canTransitionDeployment(from, to, trigger)).toBe(isAllowed(from, to, trigger));
    }
  });

  it('allows exactly 19 ungated pairs plus the rollback-only edge', () => {
    expect(UNGATED_EDGES.length).toBe(19);
    expect(ALL_PAIRS.filter(([f, t]) => canTransitionDeployment(f, t, 'manual')).length).toBe(19);
    expect(ALL_PAIRS.filter(([f, t]) => canTransitionDeployment(f, t, 'rollback')).length).toBe(
      20,
    );
  });

  it('PREPARING -> DEPLOYING is allowed only for trigger rollback', () => {
    expect(canTransitionDeployment('PREPARING', 'DEPLOYING', 'rollback')).toBe(true);
    for (const trigger of [undefined, 'manual', 'redeploy', 'webhook'] as const) {
      expect(canTransitionDeployment('PREPARING', 'DEPLOYING', trigger)).toBe(false);
      expectInvalid(
        () => transitionDeployment('PREPARING', 'DEPLOYING', trigger),
        'PREPARING',
        'DEPLOYING',
      );
    }
    expect(transitionDeployment('PREPARING', 'DEPLOYING', 'rollback')).toBe('DEPLOYING');
  });

  it('DEPLOYING -> SUCCESS is removed: success always passes HEALTHCHECK (ADR 0010 A4)', () => {
    for (const trigger of TRIGGERS_OR_NONE) {
      expect(canTransitionDeployment('DEPLOYING', 'SUCCESS', trigger)).toBe(false);
    }
  });

  it('rejects self-transitions for all ten states', () => {
    for (const status of DEPLOYMENT_STATUSES) {
      for (const trigger of TRIGGERS_OR_NONE) {
        expect(canTransitionDeployment(status, status, trigger)).toBe(false);
      }
    }
  });
});

describe('transitionDeployment (exhaustive cross-product, every trigger)', () => {
  it.each(ALL_PAIRS)('from %s to %s', (from, to) => {
    for (const trigger of TRIGGERS_OR_NONE) {
      if (isAllowed(from, to, trigger)) {
        expect(transitionDeployment(from, to, trigger)).toBe(to);
      } else {
        expectInvalid(() => transitionDeployment(from, to, trigger), from, to);
      }
    }
  });
});

describe('roadmap §8.7 named transitions', () => {
  it('valid: the healthy path QUEUED -> PREPARING -> BUILDING -> DEPLOYING -> HEALTHCHECK -> SUCCESS', () => {
    const path: DeploymentStatus[] = ['PREPARING', 'BUILDING', 'DEPLOYING', 'HEALTHCHECK', 'SUCCESS'];
    let status: DeploymentStatus = 'QUEUED';
    for (const next of path) status = transitionDeployment(status, next, 'manual');
    expect(status).toBe('SUCCESS');
  });

  it('invalid: BUILDING -> SUCCESS', () => {
    expectInvalid(() => transitionDeployment('BUILDING', 'SUCCESS', 'manual'), 'BUILDING', 'SUCCESS');
  });

  it('invalid: FAILED -> SUCCESS', () => {
    expectInvalid(() => transitionDeployment('FAILED', 'SUCCESS', 'manual'), 'FAILED', 'SUCCESS');
  });

  it('invalid: CANCELLED -> DEPLOYING', () => {
    for (const trigger of TRIGGERS_OR_NONE) {
      expectInvalid(
        () => transitionDeployment('CANCELLED', 'DEPLOYING', trigger),
        'CANCELLED',
        'DEPLOYING',
      );
    }
  });

  it('invalid: QUEUED -> SUCCESS and DEPLOYING -> SUCCESS', () => {
    expectInvalid(() => transitionDeployment('QUEUED', 'SUCCESS'), 'QUEUED', 'SUCCESS');
    expectInvalid(() => transitionDeployment('DEPLOYING', 'SUCCESS'), 'DEPLOYING', 'SUCCESS');
  });

  describe('terminal states', () => {
    it.each(TERMINALS)('%s is terminal and has no outgoing edge for any trigger', (terminal) => {
      expect(isTerminalDeploymentStatus(terminal)).toBe(true);
      for (const to of DEPLOYMENT_STATUSES) {
        for (const trigger of TRIGGERS_OR_NONE) {
          expect(canTransitionDeployment(terminal, to, trigger)).toBe(false);
        }
      }
    });

    it.each(DEPLOYMENT_STATUSES)('isTerminalDeploymentStatus(%s)', (status) => {
      expect(isTerminalDeploymentStatus(status)).toBe(
        (TERMINALS as readonly string[]).includes(status),
      );
    });
  });

  describe('cancellation', () => {
    it.each(['QUEUED', 'PREPARING', 'BUILDING', 'DEPLOYING', 'HEALTHCHECK'] as const)(
      '%s -> CANCELLED is allowed',
      (from) => {
        expect(transitionDeployment(from, 'CANCELLED', 'manual')).toBe('CANCELLED');
        expect(deploymentCancelRejection(from)).toBeNull();
      },
    );

    it('ROLLING_BACK is not cancellable: 409 ROLLBACK_IN_PROGRESS (ADR 0010 A4)', () => {
      expectInvalid(
        () => transitionDeployment('ROLLING_BACK', 'CANCELLED', 'rollback'),
        'ROLLING_BACK',
        'CANCELLED',
      );
      expect(deploymentCancelRejection('ROLLING_BACK')).toBe('ROLLBACK_IN_PROGRESS');
    });

    it.each(TERMINALS)('a %s deployment is no longer cancellable', (terminal) => {
      expect(deploymentCancelRejection(terminal)).toBe('DEPLOYMENT_NOT_CANCELLABLE');
    });
  });

  describe('rollback transitions', () => {
    it('auto-rollback after a failed healthcheck ends ROLLED_BACK', () => {
      let status: DeploymentStatus = 'HEALTHCHECK';
      status = transitionDeployment(status, 'ROLLING_BACK', 'webhook');
      expect(transitionDeployment(status, 'ROLLED_BACK', 'webhook')).toBe('ROLLED_BACK');
    });

    it('auto-rollback from DEPLOYING (the new container never started)', () => {
      expect(transitionDeployment('DEPLOYING', 'ROLLING_BACK', 'manual')).toBe('ROLLING_BACK');
    });

    it('a failed restore ends FAILED', () => {
      expect(transitionDeployment('ROLLING_BACK', 'FAILED', 'manual')).toBe('FAILED');
    });

    it('ROLLED_BACK is reachable only from ROLLING_BACK', () => {
      for (const from of DEPLOYMENT_STATUSES) {
        for (const trigger of TRIGGERS_OR_NONE) {
          expect(canTransitionDeployment(from, 'ROLLED_BACK', trigger)).toBe(
            from === 'ROLLING_BACK',
          );
        }
      }
    });

    it('a manual rollback row skips BUILDING and still passes HEALTHCHECK', () => {
      const path: DeploymentStatus[] = ['PREPARING', 'DEPLOYING', 'HEALTHCHECK', 'SUCCESS'];
      let status: DeploymentStatus = 'QUEUED';
      for (const next of path) status = transitionDeployment(status, next, 'rollback');
      expect(status).toBe('SUCCESS');
    });
  });

  describe('retry: applyDeploymentTransition', () => {
    it('applies a valid edge from its source status as a new transition', () => {
      expect(
        applyDeploymentTransition('BUILDING', { from: 'BUILDING', to: 'DEPLOYING' }, 'manual'),
      ).toEqual({ kind: 'transitioned', from: 'BUILDING', to: 'DEPLOYING' });
    });

    it('re-applying an already applied edge is reported as such, not as a new transition', () => {
      expect(
        applyDeploymentTransition('DEPLOYING', { from: 'BUILDING', to: 'DEPLOYING' }, 'manual'),
      ).toEqual({ kind: 'already-applied', status: 'DEPLOYING' });
      expect(
        applyDeploymentTransition('DEPLOYING', { from: 'PREPARING', to: 'DEPLOYING' }, 'rollback'),
      ).toEqual({ kind: 'already-applied', status: 'DEPLOYING' });
    });

    it('re-applying an edge that is not in the table is still invalid', () => {
      expectInvalid(
        () => applyDeploymentTransition('SUCCESS', { from: 'DEPLOYING', to: 'SUCCESS' }, 'manual'),
        'DEPLOYING',
        'SUCCESS',
      );
      expectInvalid(
        () =>
          applyDeploymentTransition('DEPLOYING', { from: 'PREPARING', to: 'DEPLOYING' }, 'manual'),
        'PREPARING',
        'DEPLOYING',
      );
    });

    it('an edge whose source is not the current status is invalid from the current status', () => {
      expectInvalid(
        () => applyDeploymentTransition('FAILED', { from: 'HEALTHCHECK', to: 'SUCCESS' }, 'manual'),
        'FAILED',
        'SUCCESS',
      );
      // Even when current -> to happens to be valid, a foreign edge is not applied.
      expectInvalid(
        () => applyDeploymentTransition('BUILDING', { from: 'PREPARING', to: 'FAILED' }, 'manual'),
        'BUILDING',
        'FAILED',
      );
    });

    it.each(ALL_PAIRS)('agrees with the table for edge %s -> %s', (from, to) => {
      for (const trigger of TRIGGERS_OR_NONE) {
        if (isAllowed(from, to, trigger)) {
          expect(applyDeploymentTransition(from, { from, to }, trigger).kind).toBe('transitioned');
          expect(applyDeploymentTransition(to, { from, to }, trigger).kind).toBe('already-applied');
        } else {
          expectInvalid(() => applyDeploymentTransition(from, { from, to }, trigger), from, to);
        }
      }
    });
  });
});

// H1: deterministic property walk. A fixed-seed PRNG (mulberry32) keeps failures reproducible:
// the seed is in the test title.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(items: readonly T[], random: () => number): T {
  const item = items[Math.floor(random() * items.length)];
  if (item === undefined) throw new Error('pick from an empty list');
  return item;
}

describe('H1: random transition sequences (property walk)', () => {
  const SEEDS = Array.from({ length: 40 }, (_, i) => 0x9e3779b9 ^ (i * 7919));

  it.each(SEEDS)('seed %i: no sequence escapes the invariants', (seed) => {
    const random = mulberry32(seed);
    let reachedTerminal = 0;
    for (let walk = 0; walk < 50; walk += 1) {
      const trigger = pick(DEPLOYMENT_TRIGGERS, random);
      let status: DeploymentStatus = 'QUEUED';
      const history: DeploymentStatus[] = [status];
      for (let step = 0; step < 30; step += 1) {
        const to = pick(DEPLOYMENT_STATUSES, random);
        const wasTerminal = isTerminalDeploymentStatus(status);
        let next: DeploymentStatus | undefined;
        try {
          next = transitionDeployment(status, to, trigger);
        } catch (error) {
          expect(error).toBeInstanceOf(InvalidDeploymentTransitionError);
        }
        if (next === undefined) continue;
        // No sequence leaves a terminal state.
        expect(wasTerminal).toBe(false);
        status = next;
        history.push(status);
        if (status === 'ROLLED_BACK') {
          expect(history.at(-2)).toBe('ROLLING_BACK');
        }
        if (status === 'SUCCESS') {
          // Every success (rollback trigger included) passes its own HEALTHCHECK just before.
          expect(history.at(-2)).toBe('HEALTHCHECK');
          expect(history).not.toContain('ROLLING_BACK');
        }
        if (status === 'DEPLOYING' && !history.includes('BUILDING')) {
          expect(trigger).toBe('rollback');
        }
      }
      if (isTerminalDeploymentStatus(status)) reachedTerminal += 1;
    }
    // The walk is meaningful: most walks actually reach a terminal state.
    expect(reachedTerminal).toBeGreaterThan(0);
  });

  it('the walk covers every edge of the table at least once across all seeds', () => {
    const seen = new Set<string>();
    for (const seed of SEEDS) {
      const random = mulberry32(seed);
      for (let walk = 0; walk < 50; walk += 1) {
        const trigger = pick(DEPLOYMENT_TRIGGERS, random);
        let status: DeploymentStatus = 'QUEUED';
        for (let step = 0; step < 30; step += 1) {
          const to = pick(DEPLOYMENT_STATUSES, random);
          if (canTransitionDeployment(status, to, trigger)) {
            seen.add(`${status}>${to}`);
            status = transitionDeployment(status, to, trigger);
          }
        }
      }
    }
    expect(seen.size).toBe(UNGATED_EDGES.length + 1);
  });
});

// H2: no drift between the domain tuples, the api-contract enums and the DB enums. The DB enum
// list is the cumulative result of the versioned migrations (CREATE TYPE + ADD VALUE).
const MIGRATIONS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../apps/control-plane/src/db/migrations',
);

function dbEnumValues(typeName: string): Set<string> {
  const values = new Set<string>();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort();
  const create = new RegExp(`CREATE TYPE "public"\\."${typeName}" AS ENUM\\(([^)]*)\\)`, 'g');
  const add = new RegExp(
    `ALTER TYPE "public"\\."${typeName}" ADD VALUE (?:IF NOT EXISTS )?'([^']+)'`,
    'g',
  );
  for (const file of files) {
    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    for (const match of sql.matchAll(create)) {
      for (const literal of (match[1] ?? '').matchAll(/'([^']+)'/g)) {
        if (literal[1] !== undefined) values.add(literal[1]);
      }
    }
    for (const match of sql.matchAll(add)) {
      if (match[1] !== undefined) values.add(match[1]);
    }
  }
  return values;
}

describe('H2: no drift between domain, api-contract and DB enums', () => {
  const statusShape = DeploymentViewSchema.shape;
  const tuples = [
    ['deployment_status', DEPLOYMENT_STATUSES, statusShape.status.options],
    ['deployment_trigger', DEPLOYMENT_TRIGGERS, statusShape.trigger.options],
    ['deployment_log_phase', DEPLOYMENT_LOG_PHASES, DeploymentLogChunkViewSchema.shape.phase.options],
    [
      'deployment_error_code',
      DEPLOYMENT_ERROR_CODES,
      statusShape.errorCode.unwrap().options,
    ],
    // v0.4 (21-06, migration 0014): domain, proxy and env scope enums.
    ['domain_cert_status', CERT_STATUSES, DomainViewSchema.shape.certStatus.options],
    ['domain_dns_status', DNS_OUTCOMES, DomainViewSchema.shape.dnsStatus.unwrap().options],
    ['proxy_status', PROXY_STATUSES, ProxyViewSchema.shape.status.options],
    ['env_scope', ENV_SCOPES, EnvScopeSchema.options],
  ] as const;

  it.each(tuples)('%s: the api-contract enum is exactly the domain tuple', (_, domain, api) => {
    expect([...api]).toEqual([...domain]);
  });

  it.each(tuples)(
    '%s: the DB enum holds exactly the domain values',
    (typeName, domain) => {
      const db = dbEnumValues(typeName);
      expect(db.size).toBeGreaterThan(0);
      const missing = domain.filter((value: string) => !db.has(value));
      expect(missing).toEqual([]);
      const domainSet: ReadonlySet<string> = new Set(domain);
      expect([...db].filter((value) => !domainSet.has(value))).toEqual([]);
    },
  );

  it('deployment_error_code carries the v0.4 secret, env and route codes (migration 0014)', () => {
    const db = dbEnumValues('deployment_error_code');
    for (const code of ['SECRET_UNRESOLVED', 'ENV_INJECTION_FAILED', 'PROXY_ROUTE_FAILED']) {
      expect(db.has(code), code).toBe(true);
      expect(DEPLOYMENT_ERROR_CODES as readonly string[]).toContain(code);
    }
  });
});
