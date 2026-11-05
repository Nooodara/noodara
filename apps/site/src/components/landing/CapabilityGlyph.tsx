// 10-12-PLAN.md Round 1 (D-02a/D-05). One hand-drawn glyph per DELIVERED_CAPABILITIES entry, on
// the same 24-unit/3-stroke grid HowItWorksDiagram.tsx already uses -- own inline SVG, currentColor
// only, no third-party icon set or library. Purely decorative next to a visible title, so every
// <svg> is aria-hidden; the accessible name lives on the title text beside it.
import type { ReactNode } from 'react';
import type { CapabilityId } from '../../content/scope';

const STROKE = 1.75;

interface GlyphProps {
  readonly id: CapabilityId;
}

const GLYPHS: Record<CapabilityId, ReactNode> = {
  // Terminal prompt: rounded frame, a ">" chevron, one command underline.
  install: (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" fill="none" stroke="currentColor" strokeWidth={STROKE} />
      <path d="M7 9 L10.5 12 L7 15" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
      <line x1="12" y1="15" x2="17" y2="15" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
    </>
  ),
  // Two nodes joined by a line: a server connecting over SSH.
  'connect-ssh': (
    <>
      <circle cx="6.5" cy="7" r="3" fill="none" stroke="currentColor" strokeWidth={STROKE} />
      <rect x="13" y="13" width="8" height="6" rx="1.5" fill="none" stroke="currentColor" strokeWidth={STROKE} />
      <path d="M8.8 9.3 L14.5 14" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
    </>
  ),
  // Shield with a check mark: verified fingerprint / trust.
  'fingerprint-trust': (
    <>
      <path
        d="M12 3.5 L19 6.2 V11 C19 15.5 16 18.7 12 20.5 C8 18.7 5 15.5 5 11 V6.2 Z"
        fill="none"
        stroke="currentColor"
        strokeWidth={STROKE}
        strokeLinejoin="round"
      />
      <path d="M8.7 11.4 L11 13.7 L15.5 9.2" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // Magnifying glass: step-by-step discovery.
  discovery: (
    <>
      <circle cx="10.5" cy="10.5" r="6" fill="none" stroke="currentColor" strokeWidth={STROKE} />
      <line x1="15" y1="15" x2="20" y2="20" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
    </>
  ),
  // Three stacked bars: server fleet / full detail, reusing HowItWorksDiagram's own motif.
  'server-detail': (
    <>
      <rect x="4" y="4.5" width="16" height="4" rx="1.3" fill="none" stroke="currentColor" strokeWidth={STROKE} />
      <rect x="4" y="10" width="16" height="4" rx="1.3" fill="none" stroke="currentColor" strokeWidth={STROKE} />
      <rect x="4" y="15.5" width="16" height="4" rx="1.3" fill="none" stroke="currentColor" strokeWidth={STROKE} />
    </>
  ),
  // A short list with a leading dot: activity log entries.
  'activity-log': (
    <>
      <circle cx="5" cy="7" r="1.4" fill="currentColor" stroke="none" />
      <line x1="9" y1="7" x2="20" y2="7" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
      <circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <line x1="9" y1="12" x2="20" y2="12" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
      <circle cx="5" cy="17" r="1.4" fill="currentColor" stroke="none" />
      <line x1="9" y1="17" x2="16" y2="17" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
    </>
  ),
  // Half-filled circle: light/dark appearance.
  appearance: (
    <>
      <circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" strokeWidth={STROKE} />
      <path d="M12 4.5 A7.5 7.5 0 0 1 12 19.5 Z" fill="currentColor" stroke="none" />
    </>
  ),
  // Head + shoulders: the admin account.
  account: (
    <>
      <circle cx="12" cy="8.5" r="3.5" fill="none" stroke="currentColor" strokeWidth={STROKE} />
      <path d="M5 19.5 C5 15.5 8 13.5 12 13.5 C16 13.5 19 15.5 19 19.5" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
    </>
  ),
  // Globe: a domain served over HTTPS.
  'domains-https': (
    <>
      <circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" strokeWidth={STROKE} />
      <path d="M12 4 C9 7 9 17 12 20 C15 17 15 7 12 4 Z" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinejoin="round" />
      <line x1="4" y1="12" x2="20" y2="12" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
    </>
  ),
  // Three sliders: variables layered by scope.
  variables: (
    <>
      <line x1="4" y1="7" x2="20" y2="7" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
      <circle cx="9" cy="7" r="1.8" fill="currentColor" stroke="none" />
      <line x1="4" y1="12" x2="20" y2="12" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
      <circle cx="15" cy="12" r="1.8" fill="currentColor" stroke="none" />
      <line x1="4" y1="17" x2="20" y2="17" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
      <circle cx="11" cy="17" r="1.8" fill="currentColor" stroke="none" />
    </>
  ),
  // Key: a secret referenced by name.
  secrets: (
    <>
      <circle cx="8" cy="12" r="3.5" fill="none" stroke="currentColor" strokeWidth={STROKE} />
      <path d="M11.5 12 H20 M17 12 V15 M20 12 V14.5" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // Circular arrow: upgrade/rollback.
  'upgrade-rollback': (
    <>
      <path d="M18 8 A7 7 0 1 0 19 14" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
      <path d="M18 4 V8.5 H13.5" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // Stacked layers: projects, environments and services.
  'projects-services': (
    <>
      <path d="M12 4 L20 8 L12 12 L4 8 Z" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinejoin="round" />
      <path d="M4 12 L12 16 L20 12" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M4 16 L12 20 L20 16" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // Upward arrow into a tray: ship a build to a server.
  'deploy-sources': (
    <>
      <path d="M12 15 V5 M8 9 L12 5 L16 9" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M5 14 V19 H19 V14" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // Log lines: build and runtime output.
  'deploy-logs': (
    <>
      <rect x="4" y="4" width="16" height="16" rx="2.5" fill="none" stroke="currentColor" strokeWidth={STROKE} />
      <line x1="8" y1="9" x2="16" y2="9" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
      <line x1="8" y1="12.5" x2="14" y2="12.5" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
      <line x1="8" y1="16" x2="12" y2="16" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
    </>
  ),
  // Heartbeat line in a frame: healthcheck and rollback.
  'deploy-health': (
    <>
      <rect x="3" y="4" width="18" height="16" rx="2.5" fill="none" stroke="currentColor" strokeWidth={STROKE} />
      <path d="M6 12.5 H9 L10.8 9 L13.2 15.5 L15 12.5 H18" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // Inbound arrow into a bracketed target: webhook-triggered deploy.
  'deploy-webhooks': (
    <>
      <path d="M4 12 H13" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
      <path d="M10 8.5 L13.5 12 L10 15.5" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
      <path d="M17 5 H20 V19 H17" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
  // Bar chart on a baseline: server and container metrics.
  metrics: (
    <>
      <line x1="4" y1="20" x2="20" y2="20" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
      <line x1="7.5" y1="17" x2="7.5" y2="12" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
      <line x1="12" y1="17" x2="12" y2="6" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
      <line x1="16.5" y1="17" x2="16.5" y2="9.5" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
    </>
  ),
  // Lines with a search lens: service logs.
  logs: (
    <>
      <line x1="4" y1="6" x2="16" y2="6" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
      <line x1="4" y1="10" x2="12" y2="10" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
      <line x1="4" y1="14" x2="9" y2="14" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
      <circle cx="15.5" cy="15.5" r="3" fill="none" stroke="currentColor" strokeWidth={STROKE} />
      <line x1="17.7" y1="17.7" x2="20" y2="20" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
    </>
  ),
  // Three nodes joined by edges: the infrastructure graph.
  'infrastructure-graph': (
    <>
      <circle cx="12" cy="5.5" r="2.5" fill="none" stroke="currentColor" strokeWidth={STROKE} />
      <circle cx="6" cy="18" r="2.5" fill="none" stroke="currentColor" strokeWidth={STROKE} />
      <circle cx="18" cy="18" r="2.5" fill="none" stroke="currentColor" strokeWidth={STROKE} />
      <path d="M10.9 7.7 L7.1 15.8 M13.1 7.7 L16.9 15.8 M8.5 18 H15.5" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
    </>
  ),
  // Speech bubble with a question mark: ask the assistant.
  'ai-assistant': (
    <>
      <path d="M5 5 H19 A1.5 1.5 0 0 1 20.5 6.5 V15 A1.5 1.5 0 0 1 19 16.5 H10 L6 19.5 V16.5 H5 A1.5 1.5 0 0 1 3.5 15 V6.5 A1.5 1.5 0 0 1 5 5 Z" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinejoin="round" />
      <path d="M10 9 A2 2 0 1 1 12.8 10.8 C12.2 11.1 12 11.5 12 12" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
      <circle cx="12" cy="14" r="0.4" fill="none" stroke="currentColor" strokeWidth={STROKE} />
    </>
  ),
  // Padlock: credentials encrypted at rest.
  'encrypted-credentials': (
    <>
      <rect x="5" y="11" width="14" height="9" rx="2" fill="none" stroke="currentColor" strokeWidth={STROKE} />
      <path d="M8 11 V8 A4 4 0 0 1 16 8 V11" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" />
    </>
  ),
  // Clock: explicit timeouts.
  'explicit-timeouts': (
    <>
      <circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" strokeWidth={STROKE} />
      <path d="M12 7.5 V12 L15.5 14" fill="none" stroke="currentColor" strokeWidth={STROKE} strokeLinecap="round" strokeLinejoin="round" />
    </>
  ),
};

export function CapabilityGlyph({ id }: GlyphProps) {
  return (
    <svg aria-hidden="true" width="24" height="24" viewBox="0 0 24 24" fill="none" className="h-6 w-6 text-ink">
      {GLYPHS[id]}
    </svg>
  );
}
