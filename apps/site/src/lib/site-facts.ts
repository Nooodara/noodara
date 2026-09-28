// 10-09-PLAN.md Task 1 (D-01/D-17, T-10-12). These four constants are the landing's and docs'
// only source for the install command, its script URL, the GitHub link and the approved
// screenshot allowlist -- the strings below are asserted against install.sh's own
// NOODARA_REPO_OWNER/NOODARA_REPO_NAME defaults and README.md's own install line by
// tests/unit/site/site-facts.test.ts, never trusted as hand-typed literals. Mirrors
// tests/unit/docs/install-docs-accuracy.test.ts's "doc that can't lie" discipline: this module IS
// the enforced source, not a copy of one.
//
// The owner/repo pair below is install.sh's own placeholder default (`NOODARA_REPO_OWNER:-nooodara`,
// `NOODARA_REPO_NAME:-noodara`) -- a real fork or rename changes install.sh first, and this file's
// own test fails until the two values are updated together.

// install.sh's own placeholder pair, nooodara/noodara, split into two constants below so
// GITHUB_URL and INSTALL_SCRIPT_URL are built, never retyped as one literal.
/** install.sh's NOODARA_REPO_OWNER default. */
const REPO_OWNER = 'nooodara';
/** install.sh's NOODARA_REPO_NAME default. */
const REPO_NAME = 'noodara';

export const INSTALL_SCRIPT_URL = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/main/install.sh` as const;

export const INSTALL_COMMAND = `curl -fsSL ${INSTALL_SCRIPT_URL} | sh` as const;

export const GITHUB_URL = `https://github.com/${REPO_OWNER}/${REPO_NAME}` as const;

/** The only screenshots D-17 allows the landing to render -- each one approved by the user in
 *  Phase 8 and synced to docs/ui/approved by apps/site/scripts/sync-site-assets.mjs (10-02). */
export const APPROVED_SCREENS = ['servers', 'login', 'server-detail', 'activity', 'settings'] as const;

export type ApprovedScreen = (typeof APPROVED_SCREENS)[number];
