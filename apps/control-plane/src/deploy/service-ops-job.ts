// 12-14: the `service-operation` job (stop / restart / remove). It shares the `deployments` queue
// (and so the single deploy worker) with `deploy-service` jobs, so an operation never runs beside
// a deploy of the same server's workload. Producer: one pending job per service (jobId
// `service-op-<serviceId>`), never retried (a retry would re-run remote commands), removed once
// done so the next request can enqueue. Handler: re-checks the target (a deploy may have started
// meanwhile), connects, runs, then records the outcome (activity + status cache, via the injected
// services helper) and publishes `service.updated`. The payload carries ids only. Nothing here
// throws; only error class names are logged.
import { Queue, type JobsOptions } from 'bullmq';
import type { Redactor } from '@noodara/domain/security';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { buildServiceUpdatedEvent } from '../events/deploy-engine-events.js';
import { publishServerEvent, type ServerEventPublisher } from '../events/server-event-publisher.js';
import { BULLMQ_PREFIX } from '../queue/connect-server-queue.js';
import { DEPLOY_QUEUE_NAME } from '../queue/deploy-queue.js';
import type { ServiceActor } from '../services/server-service-deps.js';
import type { ServiceView } from '../services/service-view.js';
import type { DeployJobDeps, DeployJobLogger } from './deploy-worker.js';
import {
  runServiceOperation,
  SERVICE_OPERATIONS,
  SERVICE_OPS_MESSAGES,
  type RunServiceOperationInput,
  type ServiceOperation,
  type ServiceOperationResult,
  type ServiceOpsLimits,
} from './service-ops.js';

export const SERVICE_OPERATION_JOB_NAME = 'service-operation';

export const ServiceOperationJobPayloadSchema = z.strictObject({
  serviceId: z.uuid(),
  operation: z.enum(SERVICE_OPERATIONS),
  /** `null` for a system-initiated operation. */
  actorId: z.uuid().nullable(),
});

export type ServiceOperationJobPayload = z.infer<typeof ServiceOperationJobPayloadSchema>;

/** Never throws. The failure message names field paths only, never the received value. */
export function parseServiceOperationJobPayload(
  data: unknown,
): { ok: true; payload: ServiceOperationJobPayload } | { ok: false; message: string } {
  const parsed = ServiceOperationJobPayloadSchema.safeParse(data);
  if (parsed.success) return { ok: true, payload: parsed.data };
  const paths = parsed.error.issues.map((issue) => issue.path.join('.') || '(root)');
  return { ok: false, message: `Invalid service-operation payload: ${[...new Set(paths)].join(', ')}` };
}

/** `service-op-<serviceId>`: at most one pending operation per service. */
export function jobIdForServiceOperation(serviceId: string): string {
  return `service-op-${serviceId}`;
}

// ---------------------------------------------------------------------------------------------
// Producer
// ---------------------------------------------------------------------------------------------

export type ServiceOperationEnqueueResult =
  | { readonly ok: true; readonly jobId: string }
  | {
      readonly ok: false;
      readonly code: 'SERVICE_OPERATION_IN_PROGRESS' | 'QUEUE_UNAVAILABLE';
      readonly message: string;
    };

export interface ServiceOperationQueue {
  enqueue(payload: ServiceOperationJobPayload): Promise<ServiceOperationEnqueueResult>;
  close(): Promise<void>;
}

interface ServiceOperationBullJob {
  getState(): Promise<string>;
  remove(): Promise<void>;
}

/** The slice of BullMQ's `Queue` this module uses; a unit test passes a fake. */
export interface ServiceOperationBullQueue {
  add(
    name: string,
    data: ServiceOperationJobPayload,
    opts: JobsOptions & { jobId: string },
  ): Promise<{ id?: string | undefined }>;
  getJob(jobId: string): Promise<ServiceOperationBullJob | undefined>;
  close(): Promise<void>;
}

export type CreateServiceOperationQueueOptions = (
  | { readonly connection: Redis; readonly queue?: never }
  | { readonly queue: ServiceOperationBullQueue; readonly connection?: never }
) & {
  /** Bound on the route path; ioredis can hold a command in its offline queue indefinitely. */
  readonly enqueueTimeoutMs?: number;
};

const DEFAULT_ENQUEUE_TIMEOUT_MS = 2000;
const FINISHED_JOB_STATES = new Set(['completed', 'failed']);
const UNAVAILABLE = { ok: false, code: 'QUEUE_UNAVAILABLE', message: 'Job queue is unavailable' } as const;
const IN_PROGRESS = {
  ok: false,
  code: 'SERVICE_OPERATION_IN_PROGRESS',
  message: 'Another operation on this service is already queued or running',
} as const;

async function withTimeout<T>(work: Promise<T>, timeoutMs: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        handle = setTimeout(() => {
          reject(new Error('service-operation-queue: operation timed out'));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (handle !== undefined) clearTimeout(handle);
  }
}

export function createServiceOperationQueue(options: CreateServiceOperationQueueOptions): ServiceOperationQueue {
  const queue: ServiceOperationBullQueue =
    options.queue ??
    new Queue<ServiceOperationJobPayload>(DEPLOY_QUEUE_NAME, {
      connection: options.connection,
      prefix: BULLMQ_PREFIX,
    });
  const timeoutMs = options.enqueueTimeoutMs ?? DEFAULT_ENQUEUE_TIMEOUT_MS;

  async function enqueue(payload: ServiceOperationJobPayload): Promise<ServiceOperationEnqueueResult> {
    // Defence in depth: only an ids-only payload ever reaches Redis.
    const parsed = ServiceOperationJobPayloadSchema.safeParse(payload);
    if (!parsed.success) return UNAVAILABLE;
    const jobId = jobIdForServiceOperation(parsed.data.serviceId);
    try {
      return await withTimeout(
        (async (): Promise<ServiceOperationEnqueueResult> => {
          const existing = await queue.getJob(jobId);
          if (existing) {
            // A finished job still stored would make BullMQ ignore the add (same jobId).
            if (!FINISHED_JOB_STATES.has(await existing.getState())) return IN_PROGRESS;
            await existing.remove();
          }
          const job = await queue.add(SERVICE_OPERATION_JOB_NAME, parsed.data, {
            jobId,
            attempts: 1,
            removeOnComplete: true,
            removeOnFail: true,
          });
          return { ok: true, jobId: job.id ?? jobId };
        })(),
        timeoutMs,
      );
    } catch {
      // Fixed message: ioredis/BullMQ error text can embed the Redis host, port or password.
      return UNAVAILABLE;
    }
  }

  async function close(): Promise<void> {
    await queue.close();
  }

  return { enqueue, close };
}

// ---------------------------------------------------------------------------------------------
// Handler (worker side)
// ---------------------------------------------------------------------------------------------

export interface ServiceOperationTarget {
  readonly serverId: string;
  /** A non-terminal deployment exists: the deploy owns the container, the operation is skipped. */
  readonly activeDeployment: boolean;
}

export interface RecordServiceOperationInput {
  readonly serviceId: string;
  readonly serverId: string;
  readonly operation: ServiceOperation;
  readonly actor: ServiceActor;
  readonly result: ServiceOperationResult;
}

export interface ServiceOperationJobDeps {
  /** `null` when the service no longer exists. */
  readonly loadTarget: (serviceId: string) => Promise<ServiceOperationTarget | null>;
  /** Writes the activity event and the status cache; `null` when the service is gone. */
  readonly record: (input: RecordServiceOperationInput) => Promise<ServiceView | null>;
  readonly events: ServerEventPublisher;
  readonly connect: DeployJobDeps['connect'];
  readonly createRedactor: () => Redactor;
  readonly limits: ServiceOpsLimits;
  readonly run?: (input: RunServiceOperationInput) => Promise<ServiceOperationResult>;
  readonly logger: DeployJobLogger;
  readonly now?: () => number;
}

export type ServiceOperationJobOutcome =
  | 'succeeded'
  | 'failed'
  | 'skipped_missing'
  | 'skipped_active_deployment'
  | 'invalid_payload';

function errorKind(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

export function createServiceOperationJobHandler(
  deps: ServiceOperationJobDeps,
): (data: unknown) => Promise<ServiceOperationJobOutcome> {
  const run = deps.run ?? runServiceOperation;
  const now = deps.now ?? Date.now;

  async function execute(serverId: string, payload: ServiceOperationJobPayload): Promise<ServiceOperationResult> {
    const startedAt = now();
    const failed = (code: 'SERVER_UNREACHABLE' | 'SERVER_DOCKER_UNAVAILABLE'): ServiceOperationResult => ({
      ok: false,
      code,
      message: SERVICE_OPS_MESSAGES[code],
      durationMs: Math.max(0, now() - startedAt),
    });
    const redactor = deps.createRedactor();
    let close: (() => Promise<void>) | null = null;
    try {
      const connected = await deps.connect(serverId, redactor, undefined);
      if (!connected.ok) {
        return failed(connected.code === 'DOCKER_UNAVAILABLE' ? 'SERVER_DOCKER_UNAVAILABLE' : 'SERVER_UNREACHABLE');
      }
      close = connected.close;
      return await run({
        session: connected.session,
        redactor,
        serviceId: payload.serviceId,
        operation: payload.operation,
        limits: deps.limits,
        now,
      });
    } catch (error) {
      deps.logger.warn(
        { serviceId: payload.serviceId, error: errorKind(error) },
        'service operation could not reach the server',
      );
      return failed('SERVER_UNREACHABLE');
    } finally {
      if (close !== null) {
        try {
          await close();
        } catch {
          // A failed close never changes the outcome.
        }
      }
    }
  }

  return async (data) => {
    const parsed = parseServiceOperationJobPayload(data);
    if (!parsed.ok) {
      deps.logger.warn({ reason: parsed.message }, 'service operation job ignored: invalid payload');
      return 'invalid_payload';
    }
    const { payload } = parsed;
    const fields = { serviceId: payload.serviceId, operation: payload.operation };

    let target: ServiceOperationTarget | null;
    try {
      target = await deps.loadTarget(payload.serviceId);
    } catch (error) {
      deps.logger.error({ ...fields, error: errorKind(error) }, 'service operation could not load its target');
      return 'failed';
    }
    if (target === null) return 'skipped_missing';
    if (target.activeDeployment) {
      deps.logger.info(fields, 'service operation skipped: a deployment is in progress');
      return 'skipped_active_deployment';
    }

    const result = await execute(target.serverId, payload);
    const actor: ServiceActor = payload.actorId === null ? { type: 'system' } : { type: 'user', id: payload.actorId };
    try {
      const view = await deps.record({
        serviceId: payload.serviceId,
        serverId: target.serverId,
        operation: payload.operation,
        actor,
        result,
      });
      if (view !== null) await publishServerEvent(deps.events, buildServiceUpdatedEvent(view));
    } catch (error) {
      deps.logger.warn({ ...fields, error: errorKind(error) }, 'service operation outcome could not be recorded');
    }
    if (result.ok) {
      deps.logger.info({ ...fields, durationMs: result.durationMs }, 'service operation succeeded');
      return 'succeeded';
    }
    deps.logger.warn({ ...fields, code: result.code }, 'service operation failed');
    return 'failed';
  };
}
