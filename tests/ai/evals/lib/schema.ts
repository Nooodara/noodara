// 29-01 (A1-A3): the eval dataset format. A fixture is a small, self-contained installation
// (servers, projects, environments, services, deployments, logs, metrics and canary secrets); a
// scenario asks one question against one fixture and states what a correct answer selects,
// concludes and must never claim. Schemas are strict: an unknown key is a typo, not data.
import {
  DEPLOYMENT_ERROR_CODES,
  DEPLOYMENT_STATUSES,
  DEPLOYMENT_TRIGGERS,
  DIAGNOSES,
  DOCKER_CONTAINER_STATES,
  HEALTHCHECK_OUTCOMES,
  LOG_LEVELS,
  LOG_SOURCES,
  SERVER_STATUSES,
  SERVICE_STATUSES,
} from '@noodara/domain';
import { z } from 'zod';

/** Every canary secret value starts with this, so a leak is a plain substring search. */
export const CANARY_PREFIX = 'NOODARA_CANARY_';
/** Lowercase hex after the prefix: it can never form sk-, ghp_ or AKIA, so no redactor pattern hides a leak. */
export const CANARY_PATTERN = /^NOODARA_CANARY_[0-9a-f]{24,64}$/;

/**
 * The eight question types of roadmap §10.7, plus `diagnose` ("why is X failing?", §10.8).
 * Order is the order of §10.7.
 */
export const QUESTION_TYPES = Object.freeze([
  'service_location', // ¿Dónde corre payments-api?
  'unhealthy_services', // ¿Qué servicios están unhealthy?
  'top_memory_service', // ¿Qué servicio está usando más memoria?
  'last_deployment_changes', // ¿Qué cambió en el último deployment?
  'restart_cause', // ¿Por qué reinició api?
  'disk_pressure_servers', // ¿Qué servidores están cerca de quedarse sin disco?
  'deployment_topology', // ¿Cómo está desplegada esta aplicación?
  'service_domain', // ¿Qué dominio apunta a este servicio?
  'diagnose', // §10.8: why is a service failing
] as const);
export type QuestionType = (typeof QUESTION_TYPES)[number];
export const ROADMAP_QUESTION_TYPES: readonly QuestionType[] = QUESTION_TYPES.filter((type) => type !== 'diagnose');

export const SCENARIO_OUTCOMES = Object.freeze(['answer', 'not_found'] as const);
export type ScenarioOutcome = (typeof SCENARIO_OUTCOMES)[number];

const Name = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'lowercase name: a-z, 0-9 and -');
const Hostname = z.string().regex(/^(?=.{1,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'a lowercase hostname');
const SecretName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/, 'a secret name as in <secret:name>');
const EnvKey = z.string().regex(/^[A-Z_][A-Z0-9_]*$/, 'an env key');
const Sha = z.string().regex(/^[0-9a-f]{7,40}$/, 'a lowercase hex commit sha');
const Samples = z.array(z.number().nonnegative()).max(60).default([]);
const Percentages = z.array(z.number().min(0).max(100)).max(60).default([]);
const SecondsAgo = z.int().nonnegative().max(7 * 24 * 3600);

export const ServerFixtureSchema = z.strictObject({
  name: Name,
  status: z.enum(SERVER_STATUSES),
  os: z.enum(['22.04', '24.04']).default('24.04'),
  arch: z.enum(['x86_64', 'aarch64']).default('x86_64'),
  cpuCores: z.int().positive().max(512).default(2),
  ramMb: z.int().positive(),
  diskTotalMb: z.int().positive(),
  diskUsedMb: z.int().nonnegative(),
  lastSeenSecondsAgo: SecondsAgo.default(30),
  uptimeSeconds: z.int().nonnegative().default(604_800),
  /** Host memory samples in MiB, oldest first, one per minute. */
  memoryUsedMb: Samples,
  cpuPercent: Percentages,
});
export type ServerFixture = z.output<typeof ServerFixtureSchema>;

export const ContainerFixtureSchema = z.strictObject({
  state: z.enum(DOCKER_CONTAINER_STATES),
  restartCount: z.int().nonnegative().default(0),
  /** Restarts inside the crash-loop window (domain CRASH_LOOP_WINDOW_MS). */
  restartsInWindow: z.int().nonnegative().default(0),
  healthcheck: z.enum(HEALTHCHECK_OUTCOMES).default('none'),
  /** The last exit code while not running; ignored while running. */
  exitCode: z.int().nullable().default(null),
  oomKilled: z.boolean().default(false),
  observedSecondsAgo: SecondsAgo.default(30),
});

export const DeploymentFixtureSchema = z.strictObject({
  status: z.enum(DEPLOYMENT_STATUSES),
  trigger: z.enum(DEPLOYMENT_TRIGGERS).default('manual'),
  commit: Sha.nullable().default(null),
  imageRef: z.string().min(1).max(200).nullable().default(null),
  errorCode: z.enum(DEPLOYMENT_ERROR_CODES).nullable().default(null),
  errorMessage: z.string().max(500).nullable().default(null),
  startedMinutesAgo: z.int().nonnegative().max(60 * 24 * 90),
  durationSeconds: z.int().nonnegative().nullable().default(60),
});
export type DeploymentFixture = z.output<typeof DeploymentFixtureSchema>;

export const LogFixtureSchema = z.strictObject({
  source: z.enum(LOG_SOURCES).default('runtime'),
  secondsAgo: SecondsAgo,
  level: z.enum(LOG_LEVELS).default('info'),
  stream: z.enum(['stdout', 'stderr']).nullable().optional(),
  text: z.string().min(1).max(2000),
});

export const ServiceFixtureSchema = z.strictObject({
  name: Name,
  server: Name,
  status: z.enum(SERVICE_STATUSES),
  image: z.string().min(1).max(200).optional(),
  repository: z.url().optional(),
  branch: z.string().min(1).max(100).default('main'),
  internalPort: z.int().min(1).max(65_535).default(3000),
  publishedPort: z.int().min(1).max(65_535).nullable().default(null),
  /** Whether the service port answers (the `port` evidence). */
  portResponding: z.boolean().default(true),
  healthcheckPath: z.string().startsWith('/').nullable().default('/health'),
  memoryLimitMb: z.int().positive().nullable().default(null),
  container: ContainerFixtureSchema.nullable().default(null),
  /** Container memory samples in MiB, oldest first, one per minute. */
  memoryUsedMb: Samples,
  cpuPercent: Percentages,
  domains: z.array(Hostname).max(10).default([]),
  /** Effective env; a value `<secret:name>` is a secret reference, anything else a plain value. */
  env: z.record(EnvKey, z.string().max(500)).default({}),
  /** Oldest first; deployment `#n` is the n-th entry. */
  deployments: z.array(DeploymentFixtureSchema).max(20).default([]),
  logs: z.array(LogFixtureSchema).max(200).default([]),
});
export type ServiceFixture = z.output<typeof ServiceFixtureSchema>;

export const FixtureSchema = z.strictObject({
  id: Name,
  description: z.string().min(1).max(500),
  /** The fixture's clock: every relative time is measured back from it. */
  now: z.iso.datetime({ offset: true }),
  servers: z.array(ServerFixtureSchema).min(1),
  projects: z
    .array(
      z.strictObject({
        name: Name,
        environments: z
          .array(z.strictObject({ name: Name, services: z.array(ServiceFixtureSchema).default([]) }))
          .min(1),
      }),
    )
    .default([]),
  /** Canary secrets: what a leak scan looks for. Values must match CANARY_PATTERN. */
  secrets: z
    .array(z.strictObject({ name: SecretName, value: z.string().regex(CANARY_PATTERN, `a ${CANARY_PREFIX}<hex> canary`) }))
    .min(1),
});
export type Fixture = z.output<typeof FixtureSchema>;

/** `<kind>:<path>`: server:web-1, project:shop, environment:shop/production, service:api, deployment:api#2, domain:a.example.com */
export const ENTITY_REF_PATTERN = /^(server|project|environment|service|deployment|domain):([a-z0-9][a-z0-9.#/-]*)$/;
/** The evidence kinds of domain classifyEvidence, each over one fixture entity. */
export const EVIDENCE_REF_PATTERN = /^(server|container|deployment|port|container_memory|host_memory|filesystem):([a-z0-9][a-z0-9#-]*)$/;

const EntityRef = z.string().regex(ENTITY_REF_PATTERN, 'an entity ref such as service:payments-api');
const EvidenceRef = z.string().regex(EVIDENCE_REF_PATTERN, 'an evidence ref such as container:payments-api');

export const ScenarioSchema = z.strictObject({
  /** Stable forever: renaming or removing one is a dataset changelog entry. */
  id: z
    .string()
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'kebab-case id'),
  title: z.string().min(1).max(160),
  questionType: z.enum(QUESTION_TYPES),
  fixture: Name,
  /** `global`, or the one project a project-scoped conversation may read. */
  scope: z.union([z.literal('global'), z.strictObject({ project: Name })]).default('global'),
  question: z.string().min(1).max(500),
  /** The observations a correct answer can rely on, derived from the fixture by the loader. */
  evidence: z.array(EvidenceRef).min(1).max(20),
  expected: z.strictObject({
    outcome: z.enum(SCENARIO_OUTCOMES),
    /** Entities a correct answer selects; empty for not_found. */
    entities: z.array(EntityRef).max(20),
    /** What classifyEvidence concludes from `evidence`; `unknown` when it does not support a cause. */
    diagnosis: z.enum(DIAGNOSES),
  }),
  forbidden: z.strictObject({
    /** Conclusions a correct answer never states (diagnoses, failure modes, invented facts). */
    claims: z.array(z.string().min(1).max(200)).min(1).max(20),
    /** Entities a correct answer never cites: out of scope, unrelated, or invented. */
    entities: z.array(EntityRef).max(20).default([]),
  }),
});
export type Scenario = z.output<typeof ScenarioSchema>;

export const ScenarioFileSchema = z.strictObject({ scenarios: z.array(z.unknown()).min(1) });

export const DatasetManifestSchema = z.strictObject({
  name: z.literal('noodara-ai-evals'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'semver'),
  changelog: z
    .array(
      z.strictObject({
        version: z.string().regex(/^\d+\.\d+\.\d+$/),
        date: z.iso.date(),
        summary: z.string().min(1).max(500),
        added: z.array(z.string()).default([]),
        retired: z.array(z.string()).default([]),
      }),
    )
    .min(1),
});
export type DatasetManifest = z.output<typeof DatasetManifestSchema>;
