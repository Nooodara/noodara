import { z } from 'zod';
import type { ServiceActor } from '../services/server-service-deps.js';

// 12-10 (D16): the `deploy-service` job payload carries ids only. The worker re-reads the
// deployment, its source snapshot and the service's credentials itself, so no URL, host,
// credential or token ever sits in Redis. `.strict()` on the object and on each actor arm makes a
// tampered job fail closed instead of smuggling extra fields into the worker.
export const DeployServiceJobPayloadSchema = z
  .object({
    deploymentId: z.uuid(),
    serviceId: z.uuid(),
    actor: z.discriminatedUnion('type', [
      z.object({ type: z.literal('user'), id: z.uuid() }).strict(),
      z.object({ type: z.literal('system') }).strict(),
    ]),
    requestedAt: z.iso.datetime(),
  })
  .strict();

export type DeployServiceJobPayload = z.infer<typeof DeployServiceJobPayloadSchema>;

// Compile-time proof that the payload's actor never drifts from the shared `ServiceActor`.
function _assertActorAssignableToServiceActor(actor: DeployServiceJobPayload['actor']): ServiceActor {
  return actor;
}

/** Never throws. The failure message names field paths only, never the received value. */
export function parseDeployServiceJobPayload(
  data: unknown,
): { ok: true; payload: DeployServiceJobPayload } | { ok: false; message: string } {
  const result = DeployServiceJobPayloadSchema.safeParse(data);
  if (result.success) return { ok: true, payload: result.data };
  const paths = result.error.issues.map((issue) => issue.path.join('.') || '(root)');
  return { ok: false, message: `Invalid deploy-service job payload: ${paths.join(', ')}` };
}
