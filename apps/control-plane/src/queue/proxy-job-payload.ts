import { z } from 'zod';

// 22-02 (H3): the `proxy-install` job carries the server id, the resolved ACME email and its own
// deterministic job id only. The worker re-reads the server and decrypts its credential itself, so
// no host, credential or key ever sits in Redis. `.strict()` makes a tampered job fail closed.

/** `proxy-install-<serverId>`: concurrent installs for one server collapse into one job (H1). */
export function jobIdForProxyInstall(serverId: string): string {
  return `proxy-install-${serverId}`;
}

const ACME_EMAIL = /^[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/;

export const ProxyInstallJobPayloadSchema = z
  .object({
    serverId: z.uuid(),
    acmeEmail: z.string().max(254).regex(ACME_EMAIL),
    jobId: z.string().max(64),
  })
  .strict()
  .refine((payload) => payload.jobId === jobIdForProxyInstall(payload.serverId), { path: ['jobId'] });

export type ProxyInstallJobPayload = z.infer<typeof ProxyInstallJobPayloadSchema>;

/** Never throws. The failure message names field paths only, never the received value. */
export function parseProxyInstallJobPayload(
  data: unknown,
): { ok: true; payload: ProxyInstallJobPayload } | { ok: false; message: string } {
  const result = ProxyInstallJobPayloadSchema.safeParse(data);
  if (result.success) return { ok: true, payload: result.data };
  const paths = result.error.issues.map((issue) => issue.path.join('.') || '(root)');
  return { ok: false, message: `Invalid proxy-install job payload: ${[...new Set(paths)].join(', ')}` };
}
