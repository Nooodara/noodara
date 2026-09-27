# Phase 9: Settings editables - Pattern Map

**Mapped:** 2026-09-27
**Files analyzed:** 24
**Analogs found:** 21 / 24

## File Classification

| New/Modified File | Role | Data Flow | Closest Analog | Match Quality |
|---|---|---|---|---|
| `apps/control-plane/src/routes/account.ts` | route | request-response | `apps/control-plane/src/routes/servers.ts` | exact |
| `apps/control-plane/src/services/update-account-profile.ts` | service | CRUD (transactional update) | `apps/control-plane/src/services/edit-server.ts` | exact |
| `apps/control-plane/src/services/change-account-password.ts` | service | request-response (delegated) | `apps/control-plane/src/auth/login-guard.ts` (Better Auth `auth.api.*` + `APIError` catch) | role-match |
| `apps/control-plane/src/services/account-preferences.ts` | service | CRUD | `apps/control-plane/src/services/edit-server.ts` (partial-field update shape) | role-match |
| `apps/control-plane/src/auth/dns-checker.ts` | utility (injectable adapter) | event-driven/I-O with DI | `apps/control-plane/src/auth/require-session.ts` (`SessionResolver` narrow-interface injection pattern) | role-match |
| `apps/control-plane/src/db/schema/auth.ts` (add `preferences` column) | model | CRUD | same file, `users` table definition | exact |
| `apps/control-plane/src/db/migrations/0004_*.sql` | migration | batch | `apps/control-plane/src/db/migrations/0003_phase3_discovery_snapshots.sql` | exact |
| `packages/domain/src/validators/identity.ts` (add `validateName`) | utility (pure validator) | transform | same file, `validateEmail`/`validateServerName` | exact |
| `packages/domain/src/preferences/preferences.ts` | model (Zod schema) | transform | `packages/domain/src/activity/activity-event.ts` (typed union + guard pattern) | role-match |
| `packages/domain/src/activity/activity-event.ts` (extend `SERVER_ACTIONS`-style union with `account.*`) | model | transform | same file (existing `AUTH_ACTIONS`/`SERVER_ACTIONS` union pattern) | exact |
| `apps/web/src/app/layout.tsx` | provider (Server Component root) | request-response (SSR) | same file (current sync version) + Next 16 `cookies()` doc pattern | role-match |
| `apps/web/src/lib/settings-rows.ts` (add `EditableAccountRow`) | model/type | transform | same file, `SettingsRow` type | exact |
| `packages/domain/src/preferences/preferences.ts` (cookie codec, replaces the draft `apps/web/src/lib/preferences-cookie.ts`) | utility | transform | `apps/web/src/lib/theme-script.ts` (cookie/localStorage read-with-fallback pattern) | role-match |
| `apps/web/src/lib/session-user.ts` (add revalidation helper) | hook/utility | request-response | same file, `loadSessionUser`/`useSessionUser` | exact |
| `apps/web/src/components/SettingsGroups.tsx` | component | request-response | same file (current Instance/Advanced/Appearance rendering) | exact |
| `apps/web/src/components/AccountSheet*.tsx` (Name/Email/Password sheets) | component | request-response | `apps/web/src/components/ServerSheet.tsx` | exact |
| `apps/web/src/app/login/page.tsx` (add `?reason=password-changed` notice + generic-failure fallback) | component | request-response | same file, `setupSucceeded`/`genericFailureMessage` branches | exact |
| `packages/ui/src/ThemeToggle.tsx` (extend with explicit-value write function) | component/utility | event-driven (DOM write) | same file, `handleClick`/`applyTheme`-equivalent logic | exact |
| `packages/ui/src/tokens.css` (add `--row-height`, `--row-height-padding-y`) | config | transform | same file, existing token blocks | exact |
| `packages/ui/src/theme.css` (add `@custom-variant motion-safe/motion-reduce`) | config | transform | same file, existing `@theme`/variant bindings | role-match |
| `packages/ui/src/ListRow.tsx` (swap `ROW_HEIGHT_PX` for CSS var) | component | transform | same file, current hardcoded constant usage | exact |
| `apps/control-plane/src/services/update-account-profile.test.ts` | test | unit | `tests/integration/services/edit-server.test.ts` (RED discipline, dynamic import) | role-match |
| `apps/control-plane/src/auth/dns-checker.test.ts` | test | unit | `apps/control-plane/src/auth/require-session.ts`'s own unit test (`SessionResolver` fake injection) | role-match |
| `apps/web/src/lib/settings-rows.test.ts` (`@ts-expect-error` type test) | test | unit (type-level) | `apps/web/src/lib/settings-rows.ts`'s own doc comment describing `SettingsRow`'s structural guarantee | no direct test analog found — see below |

## Pattern Assignments

### `apps/control-plane/src/routes/account.ts` (route, request-response)

**Analog:** `apps/control-plane/src/routes/servers.ts`

**Imports pattern** (lines 1-22):
```typescript
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance, FastifyPluginCallback, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ErrorBodySchema, mapServiceCodeToStatus, toErrorBody, ValidationErrorBodySchema } from './http-errors.js';
```

**Actor guard pattern** (lines 40-46):
```typescript
function requireActor(actor: ServiceActor | null): ServiceActor {
  if (actor === null) {
    throw new Error('servers route reached with no actor — requireSession guard is not registered');
  }
  return actor;
}
```
Reuse verbatim shape for `account.ts` — `request.actor` is guaranteed non-null once the route is registered inside the same `requireSession`-guarded `api-scope.ts` scope.

**Error mapping pattern** (lines 48-59):
```typescript
async function sendServiceError(reply: FastifyReply, code: string, message: string): Promise<void> {
  await reply.code(mapServiceCodeToStatus(code)).send(toErrorBody(code, message));
}
```
Every `{ ok: false }` service result maps through this — never a hand-written status literal.

**Core pattern — thin route, one service call.** No business logic in the handler itself. `/api/account/profile` (PATCH), `/api/account/password` (POST), `/api/account/preferences` (PATCH) each: validate body via Zod schema (co-located `account-schemas.ts`, mirroring `server-schemas.ts`), call exactly one service, map result.

---

### `apps/control-plane/src/services/update-account-profile.ts` (service, CRUD)

**Analog:** `apps/control-plane/src/services/edit-server.ts`

**Imports pattern** (lines 1-27): domain validators + `writeActivityEvent` + schema tables + `ServiceActor` type — same import shape, swap `servers`/`credentials` schema imports for `users`/`accounts`.

**Transaction + row-lock pattern** (lines 94-107):
```typescript
const result: EditServerResult = await deps.db.transaction(async (tx) => {
  const [row] = await tx.select().from(servers).where(eq(servers.id, input.serverId)).for('update');
  if (!row) return { ok: false, code: 'NOT_FOUND', message: `Server "${input.serverId}" not found` };
  // ...
});
```
Apply the same `for('update')` row-lock discipline on the `users` row before mutating name/email, to prevent a concurrent profile edit from racing.

**Current-password verification pattern (NEW to this codebase — first precedent this phase establishes, modeled on the credential-decode-never-reread discipline in the same file, lines ~180-210):**
```typescript
// Source: apps/control-plane/src/auth/password-hasher.ts (existing, exported)
import { verifyPassword } from '../auth/password-hasher.js';

const [account] = await db
  .select({ password: accounts.password })
  .from(accounts)
  .where(eq(accounts.userId, actor.id))
  .limit(1);

if (!account?.password || !(await verifyPassword({ hash: account.password, password: currentPassword }))) {
  return { ok: false, code: 'INVALID_CREDENTIAL', message: 'Current password is incorrect' };
}
```

**Field validation pattern** (lines 118-136 of `edit-server.ts`):
```typescript
let name = row.name;
if (input.name !== undefined) {
  const result = validateServerName(input.name);
  if (!result.ok) return { ok: false, code: 'VALIDATION_FAILED', message: result.message };
  name = result.value;
}
```
Same shape for `validateName`/`validateEmail`, threading each domain validator's `ValidationResult`.

**Unique-violation catch pattern** (lines 300-318):
```typescript
} catch (error) {
  const constraint = uniqueViolationConstraint(error);
  if (constraint === NAME_UNIQUE_CONSTRAINT) { return { ok: false, code: 'NAME_TAKEN', message: '...' }; }
  throw error;
}
```
Not needed for name/email uniqueness (single-admin, no uniqueness constraint on name) but the `uniqueViolationConstraint` helper (lines 61-64) is directly reusable if email collision ever needs it.

**Activity event write pattern** (lines 268-278):
```typescript
const activityInput = {
  actorType: input.actor.type,
  actorId: input.actor.type === 'user' ? input.actor.id : null,
  entityType: 'server',
  entityId: row.id,
  action: 'server.updated',
  outcome: 'success',
  metadata: { changedFields, credentialReplaced },
} as const;
await writeActivityEvent(tx, activityInput, deps.now());
```
For `account.name_changed`/`account.email_changed`: `entityType: 'user'`, `entityId: actor.id`, metadata `{ name: newName }` / `{ email: newEmail }` — **never the old value**, per D-08.

**Never-reread-secret discipline (critical, D-02/D-08):** `edit-server.ts`'s own header comment ("the existing credential is never read back... only an in-place UPDATE") is the exact security posture to replicate for the password hash — read it once for verification, never log it, never include it in the activity metadata or the returned `ServerView`-equivalent response shape.

---

### `apps/control-plane/src/services/change-account-password.ts` (service, request-response delegated)

**Analog (delegation + error pattern):** `apps/control-plane/src/auth/login-guard.ts`

**Better Auth error-catch pattern** (line 1, 171):
```typescript
import { APIError, isAPIError, type createAuthMiddleware } from 'better-auth/api';
// ...
if (isAPIError(returned)) {
  // map returned.status / returned.body.code onto this repo's { ok:false, code, message }
}
```

**Header bridge + delegated call pattern:**
```typescript
// Source: apps/control-plane/src/auth/fetch-headers.ts (existing, reused verbatim)
import { toFetchHeaders } from '../auth/fetch-headers.js';
import { auth } from '../auth/auth.js';

const result = await auth.api.changePassword({
  body: { currentPassword, newPassword, revokeOtherSessions: true },
  headers: toFetchHeaders(request.headers),
});
```
After success, write `account.password_changed` activity event with `{ sessions_revoked: n }` only if the Better Auth response actually exposes a count (RESEARCH Open Question 1 — spike required before trusting a shape).

---

### `apps/control-plane/src/auth/dns-checker.ts` (utility, injectable I/O)

**Analog:** `apps/control-plane/src/auth/require-session.ts`

**Injectable-dependency interface pattern** (lines 1-27):
```typescript
export type SessionResolver = (
  headers: Headers,
) => Promise<{ session?: { id: string } | null; user?: { id: string } | null } | null>;

export interface RequireSessionDeps {
  readonly getSession: SessionResolver;
}

export function createRequireSession(deps: RequireSessionDeps): FastifyPluginCallback { /* ... */ }
```
Mirror this exact shape for `DnsChecker`:
```typescript
export interface DnsChecker {
  hasMxOrA(domain: string): Promise<boolean>;
}
export function createDnsChecker(resolver: dns.promises.Resolver = new dns.promises.Resolver()): DnsChecker { /* ... */ }
```
This is a **new precedent** in the codebase (no prior `node:dns` injection exists) — `require-session.ts`'s narrow structural-type-not-library-type approach is the closest and only real analog, per RESEARCH's own Pitfall 1.

**Timeout pattern** — see `apps/control-plane/src/auth/session-lookup.ts`'s `withSessionLookupTimeout` (referenced at `require-session.ts` line 33): apply the identical bounded-timeout wrapper shape around `resolveMx`/`resolve4` calls.

---

### `apps/control-plane/src/db/migrations/0004_*.sql` (migration, batch)

**Analog:** `apps/control-plane/src/db/migrations/0003_phase3_discovery_snapshots.sql`

```sql
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "docker_compose_version" text;--> statement-breakpoint
```
Same idempotent `ADD COLUMN IF NOT EXISTS` shape for `users.preferences`:
```sql
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "preferences" jsonb NOT NULL DEFAULT '{}'::jsonb;
```
Generate via `drizzle-kit generate` (never hand-write structure that diverges from the tool's own output — `drizzle.config.ts`'s comment bans `db:push`).

---

### `packages/domain/src/validators/identity.ts` (add `validateName`)

**Analog:** same file, `validateEmail`/`validateServerName` (lines 24-56)

```typescript
export function validateEmail(input: string): ValidationResult<string> {
  if (input.length > MAX_EMAIL_LENGTH) {
    return fail('EMAIL_INVALID', `Email must be at most ${MAX_EMAIL_LENGTH.toString()} characters`);
  }
  if (!EMAIL_PATTERN.test(input)) {
    return fail('EMAIL_INVALID', '...');
  }
  return ok(input.toLowerCase());
}
```
`validateName` follows the identical shape: length bound (1-80), a control-char rejection regex, returns `ok(trimmed)`. Reuses `ValidationResult`/`ok`/`fail` from `network.ts` — never a new result shape.

---

### `apps/web/src/components/ServerSheet.tsx` → analog for Account Name/Email/Password sheets

**Sheet open/close + form-state reset pattern** (lines 76-92):
```typescript
const [formState, setFormState] = useState<ServerFormState>(() => formStateFromServer(server));
useEffect(() => {
  if (open) {
    setFormState(formStateFromServer(server));
    setFieldErrors({});
  }
}, [open, server]);
```
Reuse for each Account sheet: local `open` state, reset fields on open, `Field`/`Input`/`Button`/`Sheet` from `@noodara/ui`.

**Error mapping pattern:** `apiSend<...>` result → `fieldErrorsFromIssues`/`fieldForErrorCode` from `apps/web/src/lib/error-copy.ts` (same file `ServerSheet.tsx` imports) for `INVALID_CREDENTIAL`, `VALIDATION_FAILED`, `EMAIL_DOMAIN_UNRESOLVABLE` field errors per the UI-SPEC's copy table.

**Post-save session revalidation (D-04):** call `apps/web/src/lib/session-user.ts`'s `loadSessionUser()` again after a successful profile save so `AccountMenu` re-renders — extend that file with an explicit `refreshSessionUser()`/re-invoke of the existing hook's fetch, not a second divergent fetch shape.

---

### `apps/web/src/app/login/page.tsx` (add password-changed notice + generic-failure fallback)

**Analog:** same file, existing `setupSucceeded` branch (lines 27-28, 79):
```typescript
const setupSucceeded = searchParams.get('setup') === 'success';
// ...
{setupSucceeded ? <Notice message={SETUP_SUCCESS_MESSAGE} data-testid="login-setup-notice" /> : null}
```
Add identically:
```typescript
const passwordChanged = searchParams.get('reason') === 'password-changed';
// ...
{passwordChanged ? <Notice message="Signed out because your password changed." data-testid="login-password-changed-notice" /> : null}
```

**Generic-failure fallback fix** — `genericFailureMessage` (lines 22-27) currently falls through to `copyForErrorCode(code)`, which can return nothing for an unmapped code (Pitfall 6). Ensure `copyForErrorCode` (in `apps/web/src/lib/error-copy.ts`) has an unconditional default branch returning "Something went wrong. Try again." so `bannerMessage` is never left unset for a real failure.

---

### `packages/ui/src/ThemeToggle.tsx` (extend to explicit-value write function)

**Analog:** same file's existing `handleClick`/`STORAGE_KEY`/effect pattern (lines 11-19, 99-113):
```typescript
export const STORAGE_KEY = 'noodara-theme';
// ...
const handleClick = () => {
  const next = nextMode(mode);
  try {
    if (next === 'system') localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, next);
  } catch { /* storage disabled */ }
  setMode(next);
};
```
Extract the localStorage-write + `data-theme` DOM write into an exported function (`applyTheme(value)` or similar) that both the cyclic click handler and the new `SegmentedControl`-driven explicit-value callers invoke — this is the ONE write path (P17). Never let `SettingsGroups.tsx`'s new controls call `document.documentElement.setAttribute`/`localStorage.setItem` directly.

---

### `packages/ui/src/ListRow.tsx` (row-height token)

**Analog:** same file (lines 19, 65-66):
```typescript
const ROW_HEIGHT_PX = 44;
// ...
data-height={ROW_HEIGHT_PX}
style={{ height: `${ROW_HEIGHT_PX.toString(10)}px` }}
```
Replace the inline `style` with a class reading `var(--row-height)`; keep `data-height` as an explicit prop derived from a shared constant (not `getComputedStyle`) per RESEARCH Pitfall 4, so unit tests keep asserting a literal number while real rendering uses the CSS variable.

---

### `apps/web/src/components/SettingsGroups.tsx` (Account + Appearance rewrite)

**Analog:** same file's current `Appearance` block (lines 74-83) and `SettingsRowView`/`rowSlug` helpers (lines 20-56) — reuse `rowSlug`-style `data-testid` derivation for the new Account rows, and the exact `InsetGroup title="..." data-testid="..."` composition already used for `Instance`/existing `Appearance`.

## Shared Patterns

### Current-password confirmation (D-02)
**Source:** `apps/control-plane/src/auth/password-hasher.ts`'s `verifyPassword`
**Apply to:** `update-account-profile.ts`, `change-account-password.ts` (delegated to Better Auth internally, but the same function backs it)
```typescript
export async function verifyPassword({ hash, password }: { hash: string; password: string }): Promise<boolean> {
  try { return await argon2.verify(hash, password); } catch { return false; }
}
```
Never call `auth.api.signInEmail` to "verify" a password — it mints a new session as a side effect (RESEARCH Anti-Patterns).

### Fastify → Fetch Headers bridge
**Source:** `apps/control-plane/src/auth/fetch-headers.ts`
**Apply to:** every `auth.api.*` call in the new account services
```typescript
export function toFetchHeaders(headers: Record<string, string | string[] | undefined>): Headers { /* ... */ }
```

### Activity event construction, no secrets
**Source:** `packages/domain/src/activity/activity-event.ts`
**Apply to:** all three new `account.*` actions
```typescript
export const AUTH_ACTIONS = [ /* ... */ 'auth.password_reset' ] as const;
const FORBIDDEN_METADATA_KEYS = new Set(['password', 'secret', 'token', 'credential', ...]);
```
Add `account.name_changed`, `account.email_changed`, `account.password_changed` to a new `ACCOUNT_ACTIONS` union alongside `AUTH_ACTIONS`/`SERVER_ACTIONS`, combined into `ActivityAction` exactly like the existing two are combined. `assertNoSensitiveMetadata`'s forbidden-key set already blocks `password`/`token`/`credential` — no new guard needed unless a new sensitive key name is introduced.

### Service-result → HTTP status mapping
**Source:** `apps/control-plane/src/routes/servers.ts`'s `sendServiceError`/`mapServiceCodeToStatus`
**Apply to:** `routes/account.ts` — never a hand-written status literal for a service code; add new codes (`INVALID_CREDENTIAL` already exists, add `EMAIL_DOMAIN_UNRESOLVABLE`) to `http-errors.ts`'s status map.

### `requireSession`/actor-guard discipline
**Source:** `apps/control-plane/src/auth/require-session.ts` + `routes/servers.ts`'s `requireActor`
**Apply to:** all `/api/account/*` routes — registered inside the same `api-scope.ts` scope, `request.actor.id` is the only user id ever used for a mutation (never a `userId` from the request body).

### Client-side session guard (unchanged, reused)
**Source:** `apps/web/src/lib/require-session.ts`
**Apply to:** the `/login?reason=password-changed` redirect (D-07) — the existing `redirectToLogin`/`hasRedirected` single-navigation guard already handles this; only the destination query string changes at the call site that observes the 401 after a password change revokes the session.

## No Analog Found

| File | Role | Data Flow | Reason |
|------|------|-----------|--------|
| `packages/domain/src/preferences/preferences.ts` (cookie codec, replaces the draft `apps/web/src/lib/preferences-cookie.ts`) | utility | transform | No existing file parses/serializes a non-HttpOnly mirror cookie server-authoritatively; closest inspiration is `theme-script.ts`'s localStorage-read-with-fallback shape, but the cookie + Zod-revalidation contract (D-16, Security Domain "Cookie tampering") is new — build fresh, following `preferences.ts`'s Zod shape for revalidation on read. |
| `packages/ui/src/theme.css` `@custom-variant` block | config | transform | Zero prior `@custom-variant` usage anywhere in the repo (RESEARCH Assumption A2/Open Question 4) — the planner must verify Tailwind v4's exact grammar via Context7 or a spike build before implementing; no local file to copy from. |
| `apps/web/src/lib/settings-rows.test.ts` (`@ts-expect-error` type test for SET-06) | test | unit (type-level) | No existing `.test-d.ts`/`@ts-expect-error`-based structural type test found in the repo via search; write fresh following Vitest's own `expectTypeOf`/`@ts-expect-error` convention, referencing `settings-rows.ts`'s own doc comment (lines 1-10) that already states the intended structural guarantee in prose. |

## Metadata

**Analog search scope:** `apps/control-plane/src/{routes,services,auth,db}`, `apps/web/src/{app,lib,components}`, `packages/{domain,ui}/src`, `tests/integration/services`
**Files scanned:** ~30 (direct reads) via Read/Bash cat, grep for `@custom-variant`, `ROW_HEIGHT_PX`, `isAPIError`, `.test-d.ts`
**Pattern extraction date:** 2026-09-27
