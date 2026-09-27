// SET-02 (D-02/D-03/D-08): `PATCH /api/account/profile`, the first of this phase's
// `/api/account/*` routes. Same thin-route discipline as `servers.ts` — read `request.actor`,
// call exactly one service, map a `{ ok: false }` result through `mapServiceCodeToStatus`/
// `toErrorBody`/`toValidationErrorBody`, never a hand-written status literal and never any
// business logic of its own. Registered inside `api-scope.ts`'s `requireSession` scope (T-09-07:
// CSRF-lite origin guard runs first) so `request.actor` is always non-null here.
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { DnsChecker } from '../auth/dns-checker.js';
import { createReauthGuard } from '../auth/reauth-guard.js';
import { getDb } from '../db/client.js';
import { updateAccountProfile } from '../services/update-account-profile.js';
import type { ServiceActor } from '../services/server-service-deps.js';
import { AccountProfileResponseSchema, UpdateProfileBodySchema } from './account-schemas.js';
import { ErrorBodySchema, FieldErrorBodySchema, mapServiceCodeToStatus, toErrorBody, toValidationErrorBody } from './http-errors.js';

export interface AccountRoutesOptions {
  readonly dnsChecker: DnsChecker;
}

/** Same assertion as `servers.ts`'s own `requireActor` — a `null` actor reaching this point is a
 *  wiring bug (the route was registered outside `requireSession`), never an expected runtime
 *  state. */
function requireActor(actor: ServiceActor | null): ServiceActor {
  if (actor === null) {
    throw new Error('account route reached with no actor — requireSession guard is not registered');
  }
  return actor;
}

async function sendServiceError(reply: FastifyReply, code: string, message: string): Promise<void> {
  await reply.code(mapServiceCodeToStatus(code)).send(toErrorBody(code, message));
}

/** Same reasoning as `sendServiceError` above (and `servers.ts`'s own copy of it): `reply`'s
 *  declared type here is the bare, non-route-generic `FastifyReply` so a runtime-computed status
 *  number can be passed to `.code()` without fighting the route's own Zod-narrowed literal status
 *  union. */
async function sendFieldError(reply: FastifyReply, code: string, field: string, message: string): Promise<void> {
  // `toValidationErrorBody`'s `normalizeIssuePath` reads `instancePath` for a plain string path
  // (its `path` key is only ever an AJV-style array segment list) — passing `field` as
  // `instancePath` is what makes `issues[0].path` come out as `field` itself, not `''`.
  await reply
    .code(mapServiceCodeToStatus(code))
    .send(toValidationErrorBody([{ instancePath: field, message }], code));
}

// D-16: a service-level 400/503 for this route is always field-tagged (name/email/
// currentPassword) except REAUTH_LOCKED (429, no field) — `FieldErrorBodySchema` covers the
// former, `ErrorBodySchema` the latter, exactly like `servers.ts`'s own `CreateOrEditErrorSchema`
// union covers a schema-validation 400 alongside a plain service-level one.
const AccountProfileErrorSchema = z.union([FieldErrorBodySchema, ErrorBodySchema]);

const accountRoutes: FastifyPluginCallback<AccountRoutesOptions> = (fastify, opts, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.route({
    method: 'PATCH',
    url: '/api/account/profile',
    schema: {
      body: UpdateProfileBodySchema,
      response: {
        200: AccountProfileResponseSchema,
        400: AccountProfileErrorSchema,
        401: ErrorBodySchema,
        403: ErrorBodySchema,
        429: ErrorBodySchema,
        503: AccountProfileErrorSchema,
      },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      // T-09-01: one ReauthGuard per request, over the same db handle every other route in this
      // scope resolves lazily (login-guard.ts's own `await getDb()` per-call pattern) — never a
      // module-level singleton, so a test rebuilding the app against a fresh container never
      // reuses a guard bound to an already-stopped one.
      const db = await getDb();
      const reauthGuard = createReauthGuard({ db });

      const result = await updateAccountProfile(
        { db, dnsChecker: opts.dnsChecker, reauthGuard, now: () => new Date() },
        {
          actor,
          ...(request.body.name !== undefined ? { name: request.body.name } : {}),
          ...(request.body.email !== undefined ? { email: request.body.email } : {}),
          currentPassword: request.body.currentPassword,
        },
      );

      if (result.ok) {
        await reply.send(result.value);
        return;
      }

      if (result.code === 'REAUTH_LOCKED') {
        if (result.retryAfterSeconds !== undefined) {
          void reply.header('Retry-After', String(result.retryAfterSeconds));
        }
        await sendServiceError(reply, result.code, result.message);
        return;
      }

      if (result.field !== undefined) {
        await sendFieldError(reply, result.code, result.field, result.message);
        return;
      }

      await sendServiceError(reply, result.code, result.message);
    },
  });

  done();
};

export default accountRoutes;
