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
  'upgrade-rollback': 'Upgrade & rollback',
  'encrypted-credentials': 'Encrypted at rest',
  'explicit-timeouts': 'Explicit timeouts',
};

export const SCOPE_EXCLUSIONS = [
  {
    id: 'app-config',
    statement: 'Noodara does not manage application environment variables or secrets. Put configuration in the image.',
    projectAnchor: 'Dominios, reverse proxy (Traefik), TLS, env vars y secrets de aplicación',
    excludedTerms: ['environment variable', 'environment variables', 'env var', 'env vars', 'app secret', 'app secrets', 'secrets management'],
    showOnLanding: true,
  },
  {
    id: 'domains-tls',
    statement: 'Noodara does not manage domains, TLS certificates or a reverse proxy.',
    projectAnchor: 'Dominios, reverse proxy (Traefik), TLS, env vars y secrets de aplicación',
    excludedTerms: ['domain', 'domains', 'TLS', 'HTTPS', 'certificate', 'certificates', 'Traefik', 'reverse proxy'],
    showOnLanding: true,
  },
  {
    id: 'advanced-deploy',
    statement: 'Noodara does not run webhooks, healthchecks or automatic rollbacks.',
    projectAnchor: 'Deployment engine, webhooks, healthchecks, rollback',
    excludedTerms: ['webhook', 'webhooks', 'healthcheck', 'healthchecks', 'auto-deploy', 'automatic rollback', 'automatic rollbacks'],
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
    id: 'deploy-services',
    statement: 'Noodara does not build or deploy services from the panel in this release.',
    // Removed once the future "Your first deploy" docs page ships -- see tests/unit/site/landing-claims.test.ts.
    projectAnchor: 'Projects, Environments, Services, deployments Docker y Git',
    excludedTerms: ['deploy', 'deploys', 'deployment', 'deployments'],
    showOnLanding: true,
  },
  {
    id: 'observability-ai',
    statement: 'Noodara does not collect metrics or offer AI features in this release.',
    projectAnchor: 'Observabilidad, Infrastructure Graph, AI read-only',
    excludedTerms: ['AI', 'observability', 'metrics', 'Infrastructure Graph'],
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
