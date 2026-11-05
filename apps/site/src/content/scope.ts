// This is the only place the public site's claims and limits are written. The landing, the
// Scope reference page, and the in-context ScopeNote/ScopeTable components all render from
// these two arrays -- so the landing, the docs and .planning/PROJECT.md cannot drift apart.
// Every SCOPE_EXCLUSIONS entry's projectAnchor is anchored to PROJECT.md's own "Out of Scope"
// text (verified by tests/unit/site/landing-claims.test.ts), and every DELIVERED_CAPABILITIES
// claim is backed by a real, on-disk evidence file -- neither array may be edited without also
// touching that test.

export type Pillar = 'install' | 'connect' | 'discover' | 'understand' | 'operate';

export interface Capability {
  id: string;
  pillar: Pillar;
  claim: string;
  evidence: readonly string[];
}

export interface Exclusion {
  id: string;
  statement: string;
  /** Verbatim substring that must occur in PROJECT.md's "### Out of Scope" section or its "**Fuera de v0.2:**" line. */
  projectAnchor: string;
  excludedTerms: readonly string[];
  showOnLanding: boolean;
}

export const DELIVERED_CAPABILITIES = [
  {
    id: 'install',
    pillar: 'install',
    claim: 'Install Noodara with one command on Ubuntu 22.04 or 24.04.',
    evidence: ['install.sh'],
  },
  {
    id: 'connect-ssh',
    pillar: 'connect',
    claim: 'Add a server over SSH with a password or a key, no agent required.',
    evidence: ['tests/e2e/server-sheet.spec.ts'],
  },
  {
    id: 'fingerprint-trust',
    pillar: 'connect',
    claim: "Verify and trust the server's host key fingerprint.",
    evidence: ['tests/e2e/host-key.spec.ts'],
  },
  {
    id: 'discovery',
    pillar: 'discover',
    claim: 'Discover a server step by step, with a pass or fail check at each stage.',
    evidence: ['tests/e2e/discovery.spec.ts'],
  },
  {
    id: 'server-detail',
    pillar: 'discover',
    claim: "See a server's OS, CPU, RAM, disk, uptime and Docker status.",
    evidence: ['tests/e2e/server-detail.spec.ts'],
  },
  {
    id: 'activity-log',
    pillar: 'understand',
    claim: 'Read an activity log of every action taken on a server.',
    evidence: ['tests/e2e/activity.spec.ts'],
  },
  {
    id: 'appearance',
    pillar: 'understand',
    claim: 'Switch between light, dark and auto theme, with density and reduced motion preferences.',
    evidence: ['tests/e2e/settings.spec.ts', 'tests/e2e/theme-first-paint.spec.ts'],
  },
  {
    id: 'account',
    pillar: 'understand',
    claim: "Manage the admin account's name, email and password.",
    evidence: ['tests/e2e/settings.spec.ts'],
  },
  {
    id: 'projects-services',
    pillar: 'operate',
    claim: 'Organize work as projects, environments and services on your servers.',
    evidence: ['tests/e2e/projects-dod.spec.ts'],
  },
  {
    id: 'deploy-sources',
    pillar: 'operate',
    claim: 'Deploy a service from a Git repository, a Dockerfile or a pre-built image.',
    evidence: ['tests/e2e/deploy.spec.ts'],
  },
  {
    id: 'deploy-logs',
    pillar: 'understand',
    claim: 'Follow build and runtime logs and the real container state of every deployment.',
    evidence: ['tests/e2e/deploy.spec.ts'],
  },
  {
    id: 'deploy-health',
    pillar: 'operate',
    claim: 'Check a new deployment with a healthcheck and roll back to the previous version, automatically or on demand.',
    evidence: ['tests/e2e/engine-rollback.spec.ts'],
  },
  {
    id: 'deploy-webhooks',
    pillar: 'operate',
    claim: 'Deploy on every push to GitHub with a signed webhook that never deploys the same push twice.',
    evidence: ['tests/integration/webhooks'],
  },
  {
    id: 'domains-https',
    pillar: 'operate',
    claim: 'Point a domain at a service and get automatic HTTPS from a Traefik proxy on each server.',
    evidence: ['tests/e2e/domains-https.spec.ts'],
  },
  {
    id: 'variables',
    pillar: 'operate',
    claim: 'Set environment variables on a project, an environment or a service; the most specific value wins.',
    evidence: ['packages/domain/src/env/resolve-env.ts'],
  },
  {
    id: 'secrets',
    pillar: 'connect',
    claim: 'Store secrets encrypted at rest and reference them by name; the panel, API and logs never show their values.',
    evidence: ['tests/e2e/secrets.spec.ts'],
  },
  {
    id: 'metrics',
    pillar: 'understand',
    claim: 'Chart CPU, memory and disk for each server and service, sampled every minute.',
    evidence: ['tests/e2e/metrics.spec.ts'],
  },
  {
    id: 'logs',
    pillar: 'understand',
    claim: 'Search, filter and follow build, deploy, runtime and activity logs, with secret values redacted.',
    evidence: ['tests/e2e/logs.spec.ts'],
  },
  {
    id: 'infrastructure-graph',
    pillar: 'understand',
    claim: 'Navigate an infrastructure graph of your servers, projects, environments, services and domains.',
    evidence: ['tests/e2e/graph.spec.ts'],
  },
  {
    id: 'ai-assistant',
    pillar: 'understand',
    claim: 'Ask about your infrastructure with your own Anthropic or OpenAI key; the assistant only reads.',
    evidence: ['tests/e2e/ai-query.spec.ts', 'tests/e2e/ai-secret-safety.spec.ts'],
  },
  {
    id: 'upgrade-rollback',
    pillar: 'operate',
    claim: 'Upgrade or roll back an installation from the command line.',
    evidence: ['install.sh', 'tests/integration/installer'],
  },
  {
    id: 'encrypted-credentials',
    pillar: 'connect',
    claim: 'Encrypt server credentials at rest.',
    evidence: ['apps/control-plane/src/services/credential-store.ts'],
  },
  {
    id: 'explicit-timeouts',
    pillar: 'connect',
    claim: 'Apply an explicit timeout to every SSH command.',
    evidence: ['packages/ssh/src/exec-with-timeout.ts'],
  },
] as const satisfies readonly Capability[];

// Round 1 landing redesign (D-02a). Short grid/card titles for FeatureGrid/PrinciplesBand -- labels
// only, never asserted against PROJECT.md (that is claim's job, via landing-claims.test.ts).
export const CAPABILITY_TITLES: Record<(typeof DELIVERED_CAPABILITIES)[number]['id'], string> = {
  install: 'One-command install',
  'connect-ssh': 'Connect over SSH',
  'fingerprint-trust': 'Verified fingerprints',
  discovery: 'Step-by-step discovery',
  'server-detail': 'Full server detail',
  'activity-log': 'Activity log',
  appearance: 'Themes & density',
  account: 'Account settings',
  'projects-services': 'Projects & services',
  'deploy-sources': 'Deploy from Git or image',
  'deploy-logs': 'Build and runtime logs',
  'deploy-health': 'Healthchecks & rollback',
  'deploy-webhooks': 'GitHub webhooks',
  'domains-https': 'Domains & HTTPS',
  variables: 'Variables with precedence',
  secrets: 'Encrypted secrets',
  metrics: 'Server and container metrics',
  logs: 'Service logs',
  'infrastructure-graph': 'Infrastructure graph',
  'ai-assistant': 'Read-only AI assistant',
  'upgrade-rollback': 'Upgrade & rollback',
  'encrypted-credentials': 'Encrypted at rest',
  'explicit-timeouts': 'Explicit timeouts',
};

export const SCOPE_EXCLUSIONS = [
  {
    id: 'advanced-deploy',
    statement: 'Noodara does not offer zero-downtime or blue-green deployments: a redeploy replaces the running container.',
    projectAnchor: 'Deployment engine, webhooks, healthchecks, rollback',
    excludedTerms: ['zero-downtime', 'blue-green', 'canary'],
    showOnLanding: true,
  },
  {
    id: 'multi-user',
    statement: 'Noodara has a single admin account. It has no teams, roles or single sign-on.',
    projectAnchor: 'Multiusuario, roles, equipos, SSO',
    excludedTerms: ['team', 'teams', 'roles', 'SSO', 'single sign-on', 'multi-user', 'RBAC'],
    showOnLanding: true,
  },
  {
    id: 'ai-write',
    statement: 'Noodara does not let its AI assistant change anything: it cannot deploy, restart, delete or run commands.',
    projectAnchor: 'AI con escritura',
    excludedTerms: ['autonomous', 'self-healing', 'auto-remediation'],
    showOnLanding: false,
  },
  {
    id: 'kubernetes-cloud',
    statement: 'Noodara does not run Kubernetes or provision cloud servers.',
    projectAnchor: 'Kubernetes, provisioning cloud',
    excludedTerms: ['Kubernetes', 'cloud provisioning'],
    showOnLanding: false,
  },
  {
    id: 'other-os',
    statement: 'Noodara supports Ubuntu 22.04 and 24.04 servers only.',
    projectAnchor: 'Debian, CentOS, Alpine',
    excludedTerms: ['Debian', 'CentOS', 'Alpine'],
    showOnLanding: false,
  },
] as const satisfies readonly Exclusion[];

export type CapabilityId = (typeof DELIVERED_CAPABILITIES)[number]['id'];
export type ExclusionId = (typeof SCOPE_EXCLUSIONS)[number]['id'];

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Short, all-caps abbreviations (AI, TLS, SSO, RBAC, HTTPS) match case-sensitively so they
 * never fire on an incidental lowercase or mixed-case substring; every other term matches
 * case-insensitively. Both always match as a whole word. */
function isShortAllCapsTerm(term: string): boolean {
  return term.length <= 5 && /^[A-Z]+$/.test(term);
}

export interface ExcludedTermFinding {
  exclusionId: ExclusionId;
  term: string;
}

export function findExcludedTerms(text: string): ExcludedTermFinding[] {
  const findings: ExcludedTermFinding[] = [];
  for (const exclusion of SCOPE_EXCLUSIONS) {
    for (const term of exclusion.excludedTerms) {
      const flags = isShortAllCapsTerm(term) ? 'g' : 'gi';
      const pattern = new RegExp(`\\b${escapeRegExp(term)}\\b`, flags);
      if (pattern.test(text)) {
        findings.push({ exclusionId: exclusion.id, term });
      }
    }
  }
  return findings;
}
