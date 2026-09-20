'use client';

import { Banner, Button, Field, Input } from '@noodara/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState, type SubmitEvent } from 'react';
import { AuthCard } from '../../components/AuthCard';
import { apiSend } from '../../lib/api-client';
import { copyForErrorCode, fieldErrorsFromIssues } from '../../lib/error-copy';

// 05-UI-SPEC.md SS2.1 -- the admin-exists door-closing 404 (`NOT_FOUND`) and a `VALIDATION_FAILED`
// body this screen cannot map to any field both render this one opaque banner (05-CONTEXT.md's
// discretion note, "seguir la semántica de la API de fase 1 ... sin revelar si una cuenta existe"):
// neither ever confirms whether an account/token exists. `TOKEN_INVALID`/`ALREADY_USED`/`EXPIRED`
// (the service's own real stale-token codes, apps/control-plane/src/services/setup-service.ts) are
// not part of api-client.ts's known `ServiceErrorCode` vocabulary and are out of this plan's scope
// to add (api-client.ts is owned by a sibling plan this wave) -- they currently decode to the same
// generic `INTERNAL_ERROR` a genuine server crash does, and render that code's own copy below,
// never this banner. T-5G-30-04's fix (05-30-PLAN.md) is scoped to the two confirmed
// mislabelling bugs -- a real 500 and a network failure both wrongly showing this text -- not a
// full audit of every service-level code this route can return.
const INVALID_TOKEN_MESSAGE = 'This setup link is no longer valid. Ask whoever installed Noodara for a new one.';

interface SetupSuccess {
  readonly success: true;
}

function SetupForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const prefillToken = searchParams.get('token') ?? '';

  const [token, setToken] = useState(prefillToken);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // T-5G-30-01: the one-time setup token must not survive in the address bar or browser history
  // once this page has read it -- `useState(prefillToken)` above already captured the value as
  // this component's initial state, so stripping the query param here cannot blank the field
  // (proven by tests/e2e/setup.spec.ts). Runs once on mount only, via the raw History API rather
  // than `router.replace` -- a Next.js router-level navigation would trigger a re-render that
  // could re-read `searchParams` on a later pass, exactly what "does not re-read and blank the
  // field" (05-30-PLAN.md) forbids; `history.replaceState` changes the visible URL without
  // touching React Router state or remounting anything.
  useEffect(() => {
    if (window.location.search.includes('token=')) {
      const url = new URL(window.location.href);
      url.searchParams.delete('token');
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
    }
  }, []);

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBannerMessage(null);
    setFieldErrors({});
    setSubmitting(true);

    const result = await apiSend<SetupSuccess>('POST', '/api/setup', { token, email, password });

    setSubmitting(false);

    if (result.ok) {
      // A neutral, non-secret confirmation flag (05-UI-SPEC.md SS2.1's "Admin account created.
      // Sign in to continue." toast) -- never the email or any token/credential value.
      router.push('/login?setup=success');
      return;
    }

    // T-5G-30-04: four distinct outcomes, never one blanket fallthrough.
    //
    // 1. A real VALIDATION_FAILED body carrying `issues[]` this UI can map (a malformed request
    //    shape caught by the route's own Zod schema, e.g. an empty token bypassing the field's
    //    `required` attribute) renders inline per-field errors, exactly like every other form in
    //    this app -- no banner. Browser-native constraints (`minLength`/`maxLength`/`type="email"`/
    //    `required`) below catch the common cases before a request is ever sent.
    if (result.code === 'VALIDATION_FAILED') {
      const mapped = result.issues !== undefined ? fieldErrorsFromIssues(result.issues) : {};
      if (Object.keys(mapped).length > 0) {
        setFieldErrors(mapped);
        return;
      }
      // A VALIDATION_FAILED body this UI cannot map to any field -- unchanged legacy behaviour,
      // the same opaque banner as an invalid token (05-CONTEXT.md's "never reveal which cause
      // applied" discretion note).
      setBannerMessage(INVALID_TOKEN_MESSAGE);
      return;
    }

    // 2. NOT_FOUND is the one token-specific code this screen's known vocabulary actually carries
    //    (the door-closing 404 that fires once an admin already exists) -- deliberately the same
    //    opaque banner as a bad/expired token, never a distinct message (T-5-45).
    if (result.code === 'NOT_FOUND') {
      setBannerMessage(INVALID_TOKEN_MESSAGE);
      return;
    }

    // 3. A rejected fetch (offline, DNS failure, the request-timeout gate) -- api-client.ts's own
    //    safe, non-raw reachability message, never the invalid-link text.
    if (result.code === 'NETWORK_ERROR') {
      setBannerMessage(result.message);
      return;
    }

    // 4. Every remaining code (INTERNAL_ERROR and anything else) gets its own real copy, never the
    //    invalid-link message -- the confirmed gap-5 bug (05-VERIFICATION.md) was exactly this
    //    banner rendering for a genuine 500.
    setBannerMessage(copyForErrorCode(result.code));
  }

  return (
    <AuthCard title="Create admin account">
      {bannerMessage !== null ? <Banner message={bannerMessage} data-testid="setup-banner" /> : null}
      <form className="flex flex-col gap-5" onSubmit={(event) => void handleSubmit(event)}>
        <Field label="Token" {...(fieldErrors.token !== undefined ? { error: fieldErrors.token } : {})}>
          {(controlProps) => (
            <Input
              {...controlProps}
              mono
              invalid={fieldErrors.token !== undefined}
              autoComplete="off"
              required
              value={token}
              onChange={(event) => {
                setToken(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Email" {...(fieldErrors.email !== undefined ? { error: fieldErrors.email } : {})}>
          {(controlProps) => (
            <Input
              {...controlProps}
              type="email"
              invalid={fieldErrors.email !== undefined}
              required
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
          )}
        </Field>
        <Field
          label="Password"
          help="Must be 12–128 characters."
          {...(fieldErrors.password !== undefined ? { error: fieldErrors.password } : {})}
        >
          {(controlProps) => (
            <Input
              {...controlProps}
              type="password"
              invalid={fieldErrors.password !== undefined}
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={128}
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
          )}
        </Field>
        <Button type="submit" loading={submitting} data-testid="setup-submit">
          Create admin account
        </Button>
      </form>
    </AuthCard>
  );
}

// Client Components calling `useSearchParams` must be wrapped in a `<Suspense>` boundary or a
// production build fails (Next.js 16's own "Missing Suspense boundary" rule) -- the fallback
// renders the same card shell with an empty form area rather than nothing, since this route has no
// other loading state (05-UI-SPEC.md SS2.1: "effectively instant", no pre-check API call).
export default function SetupPage() {
  return (
    <Suspense fallback={<AuthCard title="Create admin account">{null}</AuthCard>}>
      <SetupForm />
    </Suspense>
  );
}
