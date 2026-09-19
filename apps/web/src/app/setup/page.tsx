'use client';

import { Banner, Button, Field, Input } from '@noodara/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type SubmitEvent } from 'react';
import { AuthCard } from '../../components/AuthCard';
import { apiSend } from '../../lib/api-client';
import { fieldErrorsFromIssues } from '../../lib/error-copy';

// 05-UI-SPEC.md SS2.1, verbatim -- rendered for every token-related failure (bad, expired, used,
// or already-consumed token, and the 404 that fires once an admin already exists) with no
// variation between them. 05-CONTEXT.md's discretion note ("seguir la semántica de la API de fase
// 1 ... sin revelar si una cuenta existe") is the reason this is one constant, not several: the
// real POST /api/setup route (apps/control-plane/src/routes/setup.ts) returns a different single
// `{ error, message }` code per cause (NOT_FOUND for the admin-exists gate; TOKEN_INVALID,
// ALREADY_USED, EXPIRED for the token itself -- none of them part of api-client.ts's known
// ServiceErrorCode vocabulary, so they all decode to the same generic ApiFailure here already) --
// this screen renders the identical banner regardless, so no code path can ever leak which one
// applied even if that vocabulary changes later.
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

    // The only failure this screen ever distinguishes from the single opaque banner: a real
    // VALIDATION_FAILED body carrying `issues[]` (a malformed request shape caught by the route's
    // own Zod schema, e.g. an empty token bypassing the field's `required` attribute) maps to
    // inline per-field errors, exactly like every other form in this app. Every other failure --
    // including a weak password or a malformed email, which the real service reports as its own
    // flat `{ error, message }` codes with no `issues[]` -- renders the identical opaque banner
    // below, never a distinct message. Browser-native constraints (`minLength`/`maxLength`/
    // `type="email"`/`required`) below catch the common cases before a request is ever sent.
    if (result.code === 'VALIDATION_FAILED' && result.issues !== undefined) {
      const mapped = fieldErrorsFromIssues(result.issues);
      if (Object.keys(mapped).length > 0) {
        setFieldErrors(mapped);
        return;
      }
    }

    setBannerMessage(INVALID_TOKEN_MESSAGE);
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
