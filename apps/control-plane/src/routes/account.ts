// SET-02 (D-02/D-03/D-08): `PATCH /api/account/profile`, the first of this phase's
// `/api/account/*` routes. Same thin-route discipline as `servers.ts` — read `request.actor`,
// call exactly one service, map a `{ ok: false }` result through `mapServiceCodeToStatus`/
// `toErrorBody`/`toValidationErrorBody`, never a hand-written status literal and never any
// business logic of its own. Registered inside `api-scope.ts`'s `requireSession` scope (T-09-07:
// CSRF-lite origin guard runs first) so `request.actor` is always non-null here.
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';
import { z } from 'zod';
import { auth } from '../auth/auth.js';
import type { DnsChecker } from '../auth/dns-checker.js';
import { createReauthGuard } from '../auth/reauth-guard.js';
import { toFetchHeaders } from '../auth/fetch-headers.js';
import { getDb } from '../db/client.js';
import { env } from '../env.js';
import { readAccountPreferences, updateAccountPreferences } from '../services/account-preferences.js';
import { changeAccountPassword, type ChangePasswordDelegate } from '../services/change-account-password.js';
import { updateAccountProfile } from '../services/update-account-profile.js';
import type { ServiceActor } from '../services/server-service-deps.js';
import {
  AccountProfileResponseSchema,
  ChangePasswordBodySchema,
  ChangePasswordResponseSchema,
  PreferencesResponseSchema,
  UpdatePreferencesBodySchema,
  UpdateProfileBodySchema,
} from './account-schemas.js';
import {
  ErrorBodySchema,
  FieldErrorBodySchema,
  mapServiceCodeToStatus,
  toErrorBody,
  toValidationErrorBody,
  ValidationErrorBodySchema,
} from './http-errors.js';
import { buildPreferencesSetCookie } from './preferences-cookie.js';

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

/** `POST /api/account/password` is registered inside the same `requireSession` scope, so
 *  `request.sessionId` is always non-null here — same wiring-bug assertion as `requireActor`. */
function requireSessionId(sessionId: string | null): string {
  if (sessionId === null) {
    throw new Error('account password route reached with no sessionId — requireSession guard is not registered');
  }
  return sessionId;
}

/** The route's real `ChangePasswordDelegate` — calls the actual Better Auth endpoint and
 *  immediately drops everything except the rotated session's headers (D-05/T-09-05): the
 *  service itself never even receives Better Auth's own response body (new session credential
 *  plus `user`). */
const realChangePassword: ChangePasswordDelegate = async (args) => {
  const result = await auth.api.changePassword(args);
  return { headers: result.headers };
};

/** Preferences never accept a `system` actor (there is no `/api/account/preferences` caller other
 *  than an authenticated admin session) — `require-session.ts` only ever sets `request.actor` to
 *  `{ type: 'user', id }`, so this narrowing mirrors `update-account-profile.ts`'s own
 *  `input.actor.type === 'user'` check rather than introducing a new pattern. */
function requireUserActorId(actor: ServiceActor): string {
  if (actor.type !== 'user') {
    throw new Error('account preferences route reached with a non-user actor');
  }
  return actor.id;
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

// D-16: `PATCH /api/account/preferences`'s only possible 400 is a Zod schema-validation failure
// (empty patch, invalid enum, an extra key) -- the global schema-validation handler in `app.ts`
// always returns `ValidationErrorBodySchema`'s shape (`issues` included), never the plain
// `ErrorBodySchema`, matching `servers.ts`'s own `CreateOrEditErrorSchema` precedent.
const PreferencesPatchErrorSchema = ValidationErrorBodySchema;

// SET-03/D-16: `POST /api/account/password`'s only field-tagged 400s are `INVALID_CREDENTIAL`
// (currentPassword) and `VALIDATION_FAILED` (newPassword) — `REAUTH_LOCKED` (429) carries no
// field, same split as the profile route's own error schema above.
const ChangePasswordErrorSchema = z.union([FieldErrorBodySchema, ErrorBodySchema]);

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

  // SET-03/D-05/D-06/D-07/D-08: the only `/api/account/*` route that mutates the session set
  // itself — a real Better Auth `Set-Cookie` must reach the browser (D-05), so this handler
  // forwards each header individually via `reply.header('set-cookie', ...)` rather than relying
  // on Fastify's response schema, which never sees credential headers.
  app.route({
    method: 'POST',
    url: '/api/account/password',
    schema: {
      body: ChangePasswordBodySchema,
      response: {
        200: ChangePasswordResponseSchema,
        400: ChangePasswordErrorSchema,
        401: ErrorBodySchema,
        403: ErrorBodySchema,
        429: ErrorBodySchema,
      },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const sessionId = requireSessionId(request.sessionId);
      const db = await getDb();
      const reauthGuard = createReauthGuard({ db });

      const result = await changeAccountPassword(
        { db, reauthGuard, changePassword: realChangePassword, now: () => new Date() },
        {
          actor,
          sessionId,
          headers: toFetchHeaders(request.headers),
          currentPassword: request.body.currentPassword,
          newPassword: request.body.newPassword,
        },
      );

      if (result.ok) {
        for (const setCookie of result.value.setCookies) {
          void reply.header('set-cookie', setCookie);
        }
        await reply.send({ sessionsRevoked: result.value.sessionsRevoked });
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

  // SET-04/SET-05/D-09: both routes below always refresh the `noodara-prefs` mirror cookie
  // (`reply.header('set-cookie', ...)` appends rather than overwrites a same-name header already
  // present, per Fastify's own documented set-cookie behaviour), so the browser's next SSR first
  // paint reflects whatever the server just read or wrote (D-10).
  app.route({
    method: 'GET',
    url: '/api/account/preferences',
    schema: {
      response: {
        200: PreferencesResponseSchema,
        401: ErrorBodySchema,
      },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const actorId = requireUserActorId(actor);
      const db = await getDb();
      const preferences = await readAccountPreferences({ db }, actorId);
      reply.header('set-cookie', buildPreferencesSetCookie(preferences, { secure: !env.NOODARA_COOKIE_INSECURE }));
      await reply.send(preferences);
    },
  });

  app.route({
    method: 'PATCH',
    url: '/api/account/preferences',
    schema: {
      body: UpdatePreferencesBodySchema,
      response: {
        200: PreferencesResponseSchema,
        400: PreferencesPatchErrorSchema,
        401: ErrorBodySchema,
        403: ErrorBodySchema,
      },
    },
    handler: async (request, reply) => {
      const actor = requireActor(request.actor);
      const actorId = requireUserActorId(actor);
      const db = await getDb();
      const preferences = await updateAccountPreferences({ db }, actorId, request.body);
      reply.header('set-cookie', buildPreferencesSetCookie(preferences, { secure: !env.NOODARA_COOKIE_INSECURE }));
      await reply.send(preferences);
    },
  });

  done();
};

export default accountRoutes;
