// ACT-02/D-14 (05-UI-SPEC.md §5.6) -- the one exhaustive, tested allowlist that turns a raw
// `ActivityItem` into a rendered sentence and a curated, per-action metadata detail block.
// `ActivityRow.tsx` renders only what this module returns; it never composes prose or reads
// `metadata`/`errorCode` directly (05-15-PLAN.md's must_haves key_link).
//
// T-5-64 (threat register): this file is the client-side second allowlist over the redacted
// `metadata` jsonb column. Every metadata read goes through a named, type-checked accessor
// (`stringField`/`numberField`/...) that looks up one specific key -- there is no code path here
// that enumerates `metadata`'s own keys (`Object.keys`, a spread, a full-object serialization),
// which is what makes "an unrecognised key never reaches any part of the output" structural
// rather than a convention: a key this file never names by name can never appear in
// `sentenceFor`'s or `curatedDetailFor`'s output, full stop.
import { AUTH_ACTIONS, SERVER_ACTIONS, type ActivityAction } from '@noodara/domain/activity';

/** The wire shape `GET /api/activity` returns (05-15-PLAN.md's `<interfaces>` block), hand-copied
 *  rather than imported across the apps/web/apps/control-plane boundary -- the same discipline
 *  `api-client.ts`'s `ServerView` and `server-events.ts`'s `ServerEvent` already established.
 *  `action` is `string`, not `ActivityAction`: a value loaded over the wire is never trusted to
 *  already be a member of the domain's union, and `sentenceFor`/`curatedDetailFor` degrade safely
 *  for anything outside it. */
export interface ActivityItem {
  readonly id: string;
  readonly occurredAt: string;
  readonly actorType: 'user' | 'system';
  readonly actorId: string | null;
  readonly entityType: string;
  readonly entityId: string | null;
  readonly action: string;
  readonly outcome: 'success' | 'failure';
  readonly errorCode: string | null;
  readonly metadata: unknown;
}

export interface ResolvedServer {
  readonly name: string;
  readonly href: string;
}

/** Injected by the caller (the activity page, which owns the currently-fetched servers list) --
 *  this module never fetches anything itself. Returns `null` when `entityId` does not match any
 *  currently-known server (deleted, or simply not loaded yet). */
export type ServerLookup = (entityId: string) => ResolvedServer | null;

export interface ActivitySentenceServerSegment {
  readonly label: string;
  readonly href: string | null;
  readonly mono: boolean;
}

/** A sentence is always `before + (server?.label ?? '') + after` -- never a single opaque string
 *  -- so `ActivityRow` can render the server segment as a real `<a>` (when `href` is non-null) or
 *  plain text without ever concatenating markup into a string itself. */
export interface ActivitySentence {
  readonly before: string;
  readonly server: ActivitySentenceServerSegment | null;
  readonly after: string;
}

export interface CuratedDetailEntry {
  readonly label: string;
  readonly value: string;
  readonly mono: boolean;
}

// --- metadata accessors -----------------------------------------------------------------------
// Every one of these looks up exactly one named key and validates its type; none of them ever
// iterates `metadata`'s own keys. A value of the wrong shape (an object where a string was
// expected, a string where a number was expected) is dropped here -- never stringified, never
// passed through -- so a malformed or unexpected metadata shape can never reach the DOM.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(metadata: unknown, key: string): string | undefined {
  if (!isRecord(metadata)) return undefined;
  const value = metadata[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(metadata: unknown, key: string): number | undefined {
  if (!isRecord(metadata)) return undefined;
  const value = metadata[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function booleanField(metadata: unknown, key: string): boolean | undefined {
  if (!isRecord(metadata)) return undefined;
  const value = metadata[key];
  return typeof value === 'boolean' ? value : undefined;
}

function stringArrayField(metadata: unknown, key: string): readonly string[] | undefined {
  if (!isRecord(metadata)) return undefined;
  const value = metadata[key];
  if (!Array.isArray(value)) return undefined;
  return value.every((entry): entry is string => typeof entry === 'string') ? value : undefined;
}

// --- actor + server-name resolution -----------------------------------------------------------

function actorLabel(item: ActivityItem): 'Admin' | 'System' {
  return item.actorType === 'system' ? 'System' : 'Admin';
}

/** 05-UI-SPEC.md §5.6's server-name resolution rule: a live link when `lookupServer` finds the
 *  entity, else the name carried in metadata (a deleted server's event still names it there),
 *  else the entity id's first 8 characters in mono -- never a link once past the first tier.
 *  `server.deleted` passes `neverLink: true` so an (impossible in practice, defensive) lookup hit
 *  can never re-link a server the sentence itself says is gone. */
function resolveServerSegment(
  item: ActivityItem,
  lookupServer: ServerLookup,
  options: { readonly neverLink?: boolean } = {},
): ActivitySentenceServerSegment {
  if (options.neverLink !== true && item.entityId !== null) {
    const resolved = lookupServer(item.entityId);
    if (resolved !== null) {
      return { label: resolved.name, href: resolved.href, mono: false };
    }
  }

  const metadataName = stringField(item.metadata, 'name');
  if (metadataName !== undefined) {
    return { label: metadataName, href: null, mono: false };
  }

  if (item.entityId !== null) {
    return { label: item.entityId.slice(0, 8), href: null, mono: true };
  }

  return { label: 'a deleted server', href: null, mono: false };
}

function textSentence(text: string): ActivitySentence {
  return { before: text, server: null, after: '' };
}

function serverSentence(
  before: string,
  after: string,
  item: ActivityItem,
  lookupServer: ServerLookup,
  options: { readonly neverLink?: boolean } = {},
): ActivitySentence {
  return { before, server: resolveServerSegment(item, lookupServer, options), after };
}

// --- curated detail field builders (05-UI-SPEC.md §5.6's per-action key lists) -----------------

const CREDENTIAL_TYPE_LABEL: Record<string, string> = {
  ssh_private_key: 'Private key',
  ssh_password: 'Password',
};

function compact(entries: readonly (CuratedDetailEntry | undefined)[]): readonly CuratedDetailEntry[] {
  return entries.filter((entry): entry is CuratedDetailEntry => entry !== undefined);
}

function emailEntry(item: ActivityItem): CuratedDetailEntry | undefined {
  const email = stringField(item.metadata, 'email');
  return email === undefined ? undefined : { label: 'Email', value: email, mono: false };
}

function ipEntry(item: ActivityItem): CuratedDetailEntry | undefined {
  const ip = stringField(item.metadata, 'ip');
  return ip === undefined ? undefined : { label: 'IP', value: ip, mono: false };
}

function hostPortEntry(item: ActivityItem): CuratedDetailEntry | undefined {
  const host = stringField(item.metadata, 'host');
  const port = numberField(item.metadata, 'sshPort');
  if (host === undefined || port === undefined) return undefined;
  return { label: 'Host', value: `${host}:${String(port)}`, mono: false };
}

function hostOnlyEntry(item: ActivityItem): CuratedDetailEntry | undefined {
  const host = stringField(item.metadata, 'host');
  return host === undefined ? undefined : { label: 'Host', value: host, mono: false };
}

function sshUserEntry(item: ActivityItem): CuratedDetailEntry | undefined {
  const sshUser = stringField(item.metadata, 'sshUser');
  return sshUser === undefined ? undefined : { label: 'SSH user', value: sshUser, mono: false };
}

function credentialEntry(item: ActivityItem): CuratedDetailEntry | undefined {
  const credentialType = stringField(item.metadata, 'credentialType');
  const label = credentialType === undefined ? undefined : CREDENTIAL_TYPE_LABEL[credentialType];
  return label === undefined ? undefined : { label: 'Credential', value: label, mono: false };
}

function fieldsChangedEntry(item: ActivityItem): CuratedDetailEntry | undefined {
  const fields = stringArrayField(item.metadata, 'changedFields');
  return fields === undefined ? undefined : { label: 'Fields changed', value: fields.join(', '), mono: false };
}

function credentialReplacedEntry(item: ActivityItem): CuratedDetailEntry | undefined {
  const replaced = booleanField(item.metadata, 'credentialReplaced');
  return replaced === undefined ? undefined : { label: 'Credential replaced', value: replaced ? 'yes' : 'no', mono: false };
}

function attemptsEntry(item: ActivityItem): CuratedDetailEntry | undefined {
  const attempts = numberField(item.metadata, 'attempts');
  return attempts === undefined ? undefined : { label: 'Attempts', value: String(attempts), mono: false };
}

function durationEntry(item: ActivityItem): CuratedDetailEntry | undefined {
  const durationMs = numberField(item.metadata, 'durationMs');
  return durationMs === undefined ? undefined : { label: 'Duration', value: `${String(durationMs)}ms`, mono: false };
}

function errorEntry(item: ActivityItem): CuratedDetailEntry | undefined {
  return item.errorCode === null ? undefined : { label: 'Error', value: item.errorCode, mono: true };
}

function warningsEntry(item: ActivityItem): CuratedDetailEntry | undefined {
  const warnings = stringArrayField(item.metadata, 'warnings');
  if (warnings === undefined) return undefined;
  return { label: 'Warnings', value: warnings.length === 0 ? 'none' : warnings.join(', '), mono: true };
}

function checksFailedEntry(item: ActivityItem): CuratedDetailEntry | undefined {
  const checks = stringArrayField(item.metadata, 'checksFailed');
  return checks === undefined ? undefined : { label: 'Checks failed', value: checks.join(', '), mono: true };
}

function previousFingerprintEntry(item: ActivityItem): CuratedDetailEntry | undefined {
  const fingerprint = stringField(item.metadata, 'previousFingerprint');
  return fingerprint === undefined ? undefined : { label: 'Previous', value: fingerprint, mono: true };
}

function newFingerprintEntry(item: ActivityItem): CuratedDetailEntry | undefined {
  const fingerprint = stringField(item.metadata, 'newFingerprint');
  return fingerprint === undefined ? undefined : { label: 'New', value: fingerprint, mono: true };
}

// --- the frozen, exhaustive table -----------------------------------------------------------

interface ActivityCopyEntry {
  readonly sentence: (item: ActivityItem, lookupServer: ServerLookup) => ActivitySentence;
  readonly curatedDetail: (item: ActivityItem) => readonly CuratedDetailEntry[];
}

// 05-UI-SPEC.md §5.6, encoded exhaustively. `satisfies Record<ActivityAction, ActivityCopyEntry>`
// makes a domain action added to `AUTH_ACTIONS`/`SERVER_ACTIONS` without a matching entry here a
// compile-time error, never a silent runtime gap.
const ACTIVITY_COPY = {
  'auth.setup_completed': {
    sentence: (item) => textSentence(`${actorLabel(item)} account created`),
    curatedDetail: (item) => compact([emailEntry(item)]),
  },
  'auth.admin_preseeded': {
    sentence: (item) => textSentence(`${actorLabel(item)} account created from environment variables`),
    curatedDetail: (item) => compact([emailEntry(item)]),
  },
  'auth.login_succeeded': {
    sentence: (item) => textSentence(`${actorLabel(item)} signed in`),
    curatedDetail: (item) => compact([emailEntry(item), ipEntry(item)]),
  },
  'auth.login_failed': {
    sentence: () => textSentence('Sign-in attempt failed'),
    curatedDetail: (item) => compact([emailEntry(item), ipEntry(item)]),
  },
  'auth.login_blocked': {
    sentence: () => textSentence('Sign-in temporarily blocked after repeated failures'),
    curatedDetail: (item) => compact([emailEntry(item), ipEntry(item)]),
  },
  'auth.logout': {
    sentence: (item) => textSentence(`${actorLabel(item)} signed out`),
    curatedDetail: () => [],
  },
  'auth.session_revoked': {
    sentence: () => textSentence('A session was revoked'),
    curatedDetail: () => [],
  },
  'auth.password_reset': {
    sentence: (item) => textSentence(`${actorLabel(item)} password was reset`),
    curatedDetail: () => [],
  },
  'server.created': {
    sentence: (item, lookupServer) => serverSentence(`${actorLabel(item)} added server `, '', item, lookupServer),
    curatedDetail: (item) => compact([hostPortEntry(item), sshUserEntry(item), credentialEntry(item)]),
  },
  'server.updated': {
    sentence: (item, lookupServer) => serverSentence(`${actorLabel(item)} edited server `, '', item, lookupServer),
    curatedDetail: (item) => compact([fieldsChangedEntry(item), credentialReplacedEntry(item)]),
  },
  'server.deleted': {
    sentence: (item, lookupServer) =>
      serverSentence(`${actorLabel(item)} deleted server `, '', item, lookupServer, { neverLink: true }),
    curatedDetail: (item) => compact([hostOnlyEntry(item)]),
  },
  'server.connection_attempted': {
    sentence: (item, lookupServer) =>
      item.outcome === 'success'
        ? serverSentence(`${actorLabel(item)} connected `, '', item, lookupServer)
        : serverSentence('Connection to ', ' failed', item, lookupServer),
    curatedDetail: (item) =>
      item.outcome === 'success'
        ? compact([attemptsEntry(item), durationEntry(item)])
        : compact([attemptsEntry(item), durationEntry(item), errorEntry(item)]),
  },
  'server.discovery_completed': {
    sentence: (item, lookupServer) =>
      item.outcome === 'success'
        ? serverSentence('Discovery completed for ', '', item, lookupServer)
        : serverSentence('Discovery failed for ', '', item, lookupServer),
    curatedDetail: (item) =>
      item.outcome === 'success' ? compact([warningsEntry(item)]) : compact([checksFailedEntry(item), errorEntry(item)]),
  },
  'server.fingerprint_trusted': {
    sentence: (item, lookupServer) =>
      serverSentence(`${actorLabel(item)} trusted a new host key for `, '', item, lookupServer),
    curatedDetail: (item) => compact([previousFingerprintEntry(item), newFingerprintEntry(item)]),
  },
} satisfies Record<ActivityAction, ActivityCopyEntry>;

const KNOWN_ACTIONS: ReadonlySet<string> = new Set<string>([...AUTH_ACTIONS, ...SERVER_ACTIONS]);

function isKnownAction(action: string): action is ActivityAction {
  return KNOWN_ACTIONS.has(action);
}

/** The exact §5.6 sentence for `item`, or a generic, non-revealing fallback (naming only the
 *  entity type) for an action outside the known fourteen -- the raw `action` string is never
 *  interpolated into that fallback. */
export function sentenceFor(item: ActivityItem, lookupServer: ServerLookup): ActivitySentence {
  if (!isKnownAction(item.action)) {
    return textSentence(`An activity event occurred on this ${item.entityType}.`);
  }
  return ACTIVITY_COPY[item.action].sentence(item, lookupServer);
}

/** The curated label/value pairs `item`'s action allows, in §5.6 order -- `[]` for an action with
 *  no curated keys (the three chevron-less auth actions) and `[]` for an action this module does
 *  not know at all. */
export function curatedDetailFor(item: ActivityItem): readonly CuratedDetailEntry[] {
  if (!isKnownAction(item.action)) return [];
  return ACTIVITY_COPY[item.action].curatedDetail(item);
}
