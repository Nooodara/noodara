// D-02/D-03/D-16 (phase 9): strict Zod request/response contracts for `/api/account/*`. Every
// request schema is `.strict()` so an extra key (notably `userId`) is a 400, never a silently
// ignored no-op — this is what makes T-09-08's "mutate only request.actor.id" true at the schema
// level, before a route or service ever runs. Every string carries an explicit max length,
// protecting argon2 (`currentPassword`/`newPassword`) and the DB (`name`/`email`) — the domain
// validators (`validateName`/`validateAccountEmail`, `@noodara/domain/validators`) still own the
// product-level rules (1-80 chars, control characters, email shape); these bounds are a coarser,
// wire-level safety net only.
import { z } from 'zod';
import { PreferencesPatchSchema, PreferencesSchema } from '@noodara/domain/preferences';

const MAX_NAME_WIRE_LENGTH = 200;
const MAX_EMAIL_WIRE_LENGTH = 320;
const MAX_PASSWORD_WIRE_LENGTH = 256;

/** `PATCH /api/account/profile` body: `name` and/or `email`, always with the current password
 *  (D-02). Never `userId` — the mutation target is always `request.actor.id`. */
export const UpdateProfileBodySchema = z
  .object({
    name: z.string().min(1).max(MAX_NAME_WIRE_LENGTH).optional(),
    email: z.string().min(1).max(MAX_EMAIL_WIRE_LENGTH).optional(),
    currentPassword: z.string().min(1).max(MAX_PASSWORD_WIRE_LENGTH),
  })
  .strict()
  .refine((body) => body.name !== undefined || body.email !== undefined, {
    message: 'At least one of name or email is required',
    path: ['name'],
  });

export type UpdateProfileBody = z.infer<typeof UpdateProfileBodySchema>;

/** `POST /api/account/password` body. No `revokeOtherSessions` key — the server always revokes
 *  other sessions itself (D-05); a caller can never opt out. */
export const ChangePasswordBodySchema = z
  .object({
    currentPassword: z.string().min(1).max(MAX_PASSWORD_WIRE_LENGTH),
    newPassword: z.string().min(1).max(MAX_PASSWORD_WIRE_LENGTH),
  })
  .strict();

export type ChangePasswordBody = z.infer<typeof ChangePasswordBodySchema>;

/** `PATCH /api/account/preferences` body — the domain's own strict, >=1-key patch schema
 *  (D-16), reused rather than re-declared here. */
export const UpdatePreferencesBodySchema = PreferencesPatchSchema;

export type UpdatePreferencesBody = z.infer<typeof UpdatePreferencesBodySchema>;

export const AccountProfileResponseSchema = z.object({
  name: z.string(),
  email: z.string(),
});

/** No credential field of any kind, ever (D-05/D-06): a password change never returns a new
 *  session identifier on this wire — only the count of other sessions Better Auth's
 *  `revokeOtherSessions` closed. */
export const ChangePasswordResponseSchema = z.object({
  sessionsRevoked: z.number().int().min(0),
});

export const PreferencesResponseSchema = PreferencesSchema;
