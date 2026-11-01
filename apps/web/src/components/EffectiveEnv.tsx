'use client';

// 24-02: what the service's container gets: each key once, with its winning value (a secret
// reference shows as a chip, never a value) and an origin pill. Definitions overridden by a
// narrower scope are behind a per-row disclosure. When the stored set differs from the running
// deployment's snapshot, a notice says to redeploy.
import { useEffect, useRef, useState } from 'react';
import { Disclosure, Notice } from '@noodara/ui';
import { OriginPill, SecretChip } from './EnvRow';
import { getEffectiveEnv, type EffectiveEnvView, type EnvValueView } from '../lib/env-api';
import { REDEPLOY_TO_APPLY_COPY } from '../lib/env-form';
import { requireSession } from '../lib/require-session';

export const EFFECTIVE_LOAD_FAILED_COPY = "Couldn't load the effective variables. Check your connection and try again.";
export const EFFECTIVE_EMPTY_COPY = 'No variables reach this service yet.';

export interface EffectiveEnvProps {
  readonly projectId: string;
  readonly serviceId: string;
  /** Bumped by the parent after a variable or secret write (or a deploy) to refetch. */
  readonly version?: number;
}

function Value({ value }: { readonly value: EnvValueView }) {
  return value.kind === 'secret_ref' ? (
    <SecretChip name={value.name} />
  ) : (
    <span data-testid="effective-value" className="min-w-0 break-all font-mono text-callout text-ink">
      {value.value}
    </span>
  );
}

export function EffectiveEnv({ projectId, serviceId, version = 0 }: EffectiveEnvProps) {
  const [view, setView] = useState<EffectiveEnvView | null>(null);
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    void getEffectiveEnv(projectId, serviceId).then((result) => {
      if (!mounted.current) return;
      if (!result.ok) {
        if (result.unauthorized) void requireSession();
        setFailed(true);
        return;
      }
      setFailed(false);
      setView(result.data);
    });
  }, [projectId, serviceId, version]);

  return (
    <section aria-label="Effective variables" data-testid="effective-env" className="flex flex-col gap-3">
      {view?.differsFromRunning === true ? (
        <Notice message={REDEPLOY_TO_APPLY_COPY} data-testid="effective-redeploy-notice" />
      ) : null}
      {view === null ? (
        failed ? (
          <p role="alert" data-testid="effective-load-failed" className="text-callout text-status-error-text">
            {EFFECTIVE_LOAD_FAILED_COPY}
          </p>
        ) : (
          <p data-testid="effective-loading" className="text-callout text-ink-secondary">
            Loading effective variables…
          </p>
        )
      ) : view.items.length === 0 ? (
        <p data-testid="effective-empty" className="text-callout text-ink-secondary">
          {EFFECTIVE_EMPTY_COPY}
        </p>
      ) : (
        <ul className="flex flex-col divide-y divide-hairline" data-testid="effective-list">
          {view.items.map((item) => (
            <li key={item.key} data-testid={`effective-row-${item.key}`} className="flex flex-col gap-1 py-2">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span data-testid="effective-key" className="min-w-0 break-all font-mono text-callout font-semibold text-ink">
                  {item.key}
                </span>
                <Value value={item.value} />
                <OriginPill scope={item.origin} />
              </div>
              {item.shadowed.length === 0 ? null : (
                <Disclosure
                  title={item.shadowed.length === 1 ? 'Overrides 1 definition' : `Overrides ${item.shadowed.length.toString()} definitions`}
                  data-testid="effective-shadowed"
                >
                  <ul className="flex flex-col gap-1 pb-2">
                    {item.shadowed.map((entry, index) => (
                      <li key={`${entry.origin}:${index.toString()}`} data-testid="effective-shadowed-item" className="flex flex-wrap items-center gap-2">
                        <OriginPill scope={entry.origin} />
                        <Value value={entry.value} />
                      </li>
                    ))}
                  </ul>
                </Disclosure>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
