'use client';

import { validateEmail } from '@noodara/domain/validators';
import { Banner, Button, Field, Input, Notice } from '@noodara/ui';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState, type SubmitEvent } from 'react';
import { AuthCard } from '../../components/AuthCard';
import { apiSend, type ApiErrorCode } from '../../lib/api-client';
import { copyForErrorCode, formatRetryAfterDuration } from '../../lib/error-copy';

// 05-UI-SPEC.md SS2.2, verbatim -- rendered for every 401 cause (wrong password, unknown email)
// with no variation between them (T-5-45: AUTH-04's "sin revelar si una cuenta existe"). Better
// Auth's own `POST /api/auth/sign-in/email` error body is `{ message, code }` (better-call's wire
// shape, confirmed by reading node_modules/better-call/dist/to-response.mjs), never this app's
// `{ error, message }` D-16 vocabulary -- so its `message` is never rendered here regardless: only
// the HTTP status (`ApiFailure.unauthorized`/`retryAfterSeconds`, both derived from the response
// itself, never the body) drives which fixed banner this screen shows.
const INVALID_CREDENTIALS_MESSAGE = "That email or password isn't right.";
const EMAIL_FIELD_ERROR = 'Enter a valid email address.';
const SETUP_SUCCESS_MESSAGE = 'Admin account created. Sign in to continue.';

function genericFailureMessage(code: ApiErrorCode, message: string): string {
  // NETWORK_ERROR has no ServiceErrorCode counterpart (a rejected `fetch`, not a server response)
  // -- api-client.ts already crafted a safe, non-raw message for it, so it is the one code this
  // screen renders straight from `ApiFailure.message` rather than through `copyForErrorCode`.
  if (code === 'NETWORK_ERROR') return message;
  return copyForErrorCode(code);
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const setupSucceeded = searchParams.get('setup') === 'success';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [emailError, setEmailError] = useState<string | null>(null);
  const [bannerMessage, setBannerMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(event: SubmitEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBannerMessage(null);
    setEmailError(null);

    const emailResult = validateEmail(email);
    if (!emailResult.ok) {
      setEmailError(EMAIL_FIELD_ERROR);
      return;
    }

    setSubmitting(true);
    const result = await apiSend<unknown>('POST', '/api/auth/sign-in/email', {
      email: emailResult.value,
      password,
    });
    setSubmitting(false);

    if (result.ok) {
      // /servers does not exist yet (Plan 05-12) -- the URL still updates correctly; QA-04's own
      // critical path (login -> Servers) is this screen's job only as far as "lands on /servers".
      router.push('/servers');
      return;
    }

    if (result.unauthorized) {
      setBannerMessage(INVALID_CREDENTIALS_MESSAGE);
      return;
    }

    if (result.retryAfterSeconds !== undefined) {
      setBannerMessage(`Too many attempts. Try again ${formatRetryAfterDuration(result.retryAfterSeconds)}.`);
      return;
    }

    setBannerMessage(genericFailureMessage(result.code, result.message));
  }

  return (
    <AuthCard title="Sign in">
      {setupSucceeded ? <Notice message={SETUP_SUCCESS_MESSAGE} data-testid="login-setup-notice" /> : null}
      {bannerMessage !== null ? <Banner message={bannerMessage} data-testid="login-banner" /> : null}
      <form
        className="flex flex-col gap-5"
        // The browser's own native email-format bubble is unstyled and inconsistent across
        // browsers -- this screen owns validation UI entirely through Field's inline error
        // (05-UI-SPEC.md's design system), so native constraint validation is disabled and
        // `validateEmail` (the same domain validator the backend uses) is the one source of truth.
        noValidate
        onSubmit={(event) => {
          void handleSubmit(event);
        }}
      >
        <Field label="Email" {...(emailError !== null ? { error: emailError } : {})}>
          {(controlProps) => (
            <Input
              {...controlProps}
              type="email"
              invalid={emailError !== null}
              autoComplete="username"
              required
              value={email}
              onChange={(event) => {
                setEmail(event.target.value);
              }}
            />
          )}
        </Field>
        <Field label="Password">
          {(controlProps) => (
            <Input
              {...controlProps}
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(event) => {
                setPassword(event.target.value);
              }}
            />
          )}
        </Field>
        <Button type="submit" loading={submitting} data-testid="login-submit">
          Sign in
        </Button>
      </form>
    </AuthCard>
  );
}

// Client Components calling `useSearchParams` must be wrapped in a `<Suspense>` boundary or a
// production build fails (Next.js 16's own "Missing Suspense boundary" rule) -- the fallback
// renders the same card shell with an empty form area rather than nothing.
export default function LoginPage() {
  return (
    <Suspense fallback={<AuthCard title="Sign in">{null}</AuthCard>}>
      <LoginForm />
    </Suspense>
  );
}
