// 31-11 (A1): every field list the AI read tools send to the model, kept free of I/O and env so the
// adversarial suite can derive the threat model from it. Server and service rows are these column
// maps; deployments are the API view; health, metrics, logs and graph data are the strict schemas
// their routes validate. tests/integration/ai/tools.test.ts pins each one to what the tools answer;
// docs/security/v0.5-review.md has one row per field (tests/ai/evals/adversarial/channels.test.ts).
import {
  DeploymentViewSchema,
  LogEntryViewSchema,
  MetricSeriesResponseSchema,
  ServiceStatusSummarySchema,
} from '@noodara/domain/api-contract';
import { servers, services } from '../../db/schema/index.js';
import { GraphResponseSchema } from '../../routes/graph-schemas.js';
import { ServerMetricsResponseSchema } from '../../routes/metrics-schemas.js';

// The AI projection of a server: no host, SSH user or port, credential, fingerprints or ACME email.
export const SERVER_COLUMNS = {
  id: servers.id,
  name: servers.name,
  status: servers.status,
  hostname: servers.hostname,
  osDistribution: servers.osDistribution,
  osVersion: servers.osVersion,
  arch: servers.arch,
  cpuCores: servers.cpuCores,
  ramMb: servers.ramMb,
  diskTotalMb: servers.diskTotalMb,
  diskUsedMb: servers.diskUsedMb,
  uptimeSeconds: servers.uptimeSeconds,
  dockerInstalled: servers.dockerInstalled,
  dockerVersion: servers.dockerVersion,
  dockerComposeVersion: servers.dockerComposeVersion,
  dockerBuildkitAvailable: servers.dockerBuildkitAvailable,
  proxyStatus: servers.proxyStatus,
  proxyErrorCode: servers.proxyErrorCode,
  lastSeenAt: servers.lastSeenAt,
  createdAt: servers.createdAt,
} as const;

// The AI projection of a service: no credential ids, git host keys, webhook ids or pending triggers.
export const SERVICE_COLUMNS = {
  id: services.id,
  projectId: services.projectId,
  environmentId: services.environmentId,
  serverId: services.serverId,
  name: services.name,
  sourceType: services.sourceType,
  repositoryUrl: services.repositoryUrl,
  branch: services.branch,
  buildContext: services.buildContext,
  dockerfilePath: services.dockerfilePath,
  buildTarget: services.buildTarget,
  imageRef: services.imageRef,
  internalPort: services.internalPort,
  publishedPort: services.publishedPort,
  healthcheck: services.healthcheck,
  autoRollback: services.autoRollback,
  imageRetention: services.imageRetention,
  status: services.status,
  createdAt: services.createdAt,
  updatedAt: services.updatedAt,
} as const;

export const AI_READ_PROJECTIONS = Object.freeze({
  server: SERVER_COLUMNS,
  service: SERVICE_COLUMNS,
  deployment: DeploymentViewSchema,
  health: ServiceStatusSummarySchema,
  serverMetrics: ServerMetricsResponseSchema,
  serviceMetrics: MetricSeriesResponseSchema,
  log: LogEntryViewSchema,
  graph: GraphResponseSchema,
});
