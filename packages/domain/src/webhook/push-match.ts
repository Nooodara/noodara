// Decides whether a GitHub delivery should deploy a git service (16-05). Order: event, payload
// schema, repository, ref kind, deletion, exact branch, SHA shape. The pushed SHA itself is what
// gets deployed (OPEN_QUESTIONS #18), never the branch tip at build time.

import { type CommitSha, validateCommitSha } from "../validators/git.js";
import type { WebhookDeliveryOutcome } from "./delivery-outcome.js";
import {
  GITHUB_ZERO_SHA,
  githubPingPayloadSchema,
  githubPushPayloadSchema,
} from "./github-payload.js";

export interface WebhookServiceTarget {
  readonly repositoryUrl: string;
  readonly branch: string;
}

export type PushIgnoredOutcome = Extract<
  WebhookDeliveryOutcome,
  | "ignored_event"
  | "ignored_tag"
  | "ignored_ref"
  | "ignored_branch"
  | "ignored_deletion"
>;
export type PushRejectedOutcome = Extract<
  WebhookDeliveryOutcome,
  "invalid_payload" | "repository_mismatch" | "invalid_sha"
>;

export type PushMatch =
  | { readonly kind: "deploy"; readonly sha: CommitSha }
  | { readonly kind: "ping"; readonly outcome: "ping" }
  | { readonly kind: "ignored"; readonly outcome: PushIgnoredOutcome }
  | { readonly kind: "rejected"; readonly outcome: PushRejectedOutcome };

const SCHEME_PREFIX_PATTERN = /^(?:https|ssh):\/\//;
const AUTHORITY_PATTERN =
  /^(?:[^@/]*@)?(?:\[[0-9a-fA-F:.]+\]|[^:@[\]\s]+)(?::\d{1,5})?$/;
const SCP_PATTERN = /^(?:[^@/:]+@)?[^:/@[\]\s]+:/;
const USER_PREFIX_PATTERN = /^[^@]*@/;
const PORT_SUFFIX_PATTERN = /:\d{1,5}$/;
const HEADS_PREFIX = "refs/heads/";
const TAGS_PREFIX = "refs/tags/";

function normalizePath(path: string): string | null {
  const trimmed = path
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .replace(/\/+$/, "");
  return trimmed === "" ? null : trimmed;
}

/**
 * Comparison key `host/path` for https://, ssh:// and scp-like URLs: user and port dropped, host
 * lowercased, leading/trailing slashes and one `.git` suffix stripped. The path stays
 * case-sensitive. Returns null for anything else (http, git://, no path).
 */
export function normalizeRepositoryUrl(url: string): string | null {
  let authority: string;
  let rawPath: string;
  if (SCHEME_PREFIX_PATTERN.test(url)) {
    const rest = url.slice(url.indexOf("://") + 3);
    const slash = rest.indexOf("/");
    authority = slash === -1 ? rest : rest.slice(0, slash);
    rawPath = slash === -1 ? "" : rest.slice(slash);
    if (!AUTHORITY_PATTERN.test(authority)) return null;
    authority = authority.replace(PORT_SUFFIX_PATTERN, "");
  } else {
    if (url.includes("://") || !SCP_PATTERN.test(url)) return null;
    const colon = url.indexOf(":");
    authority = url.slice(0, colon);
    rawPath = url.slice(colon + 1);
  }
  const path = normalizePath(rawPath);
  if (path === null) return null;
  return `${authority.replace(USER_PREFIX_PATTERN, "").toLowerCase()}/${path}`;
}

function sameRepository(
  serviceUrl: string,
  candidates: readonly (string | undefined)[],
): boolean {
  const expected = normalizeRepositoryUrl(serviceUrl);
  if (expected === null) return false;
  return candidates.some(
    (candidate) =>
      candidate !== undefined && normalizeRepositoryUrl(candidate) === expected,
  );
}

/** `event` is the X-GitHub-Event header; `payload` is the parsed JSON body. */
export function matchPush(
  service: WebhookServiceTarget,
  event: string | undefined,
  payload: unknown,
): PushMatch {
  if (event === "ping") {
    return githubPingPayloadSchema.safeParse(payload).success
      ? { kind: "ping", outcome: "ping" }
      : { kind: "rejected", outcome: "invalid_payload" };
  }
  if (event !== "push") return { kind: "ignored", outcome: "ignored_event" };

  const parsed = githubPushPayloadSchema.safeParse(payload);
  if (!parsed.success) return { kind: "rejected", outcome: "invalid_payload" };
  const push = parsed.data;
  const { clone_url, ssh_url, html_url } = push.repository;

  if (!sameRepository(service.repositoryUrl, [clone_url, ssh_url, html_url])) {
    return { kind: "rejected", outcome: "repository_mismatch" };
  }
  if (push.ref.startsWith(TAGS_PREFIX))
    return { kind: "ignored", outcome: "ignored_tag" };
  if (!push.ref.startsWith(HEADS_PREFIX))
    return { kind: "ignored", outcome: "ignored_ref" };
  if (push.deleted || push.after === GITHUB_ZERO_SHA)
    return { kind: "ignored", outcome: "ignored_deletion" };
  if (push.ref !== `${HEADS_PREFIX}${service.branch}`)
    return { kind: "ignored", outcome: "ignored_branch" };

  const sha = validateCommitSha(push.after);
  return sha.ok
    ? { kind: "deploy", sha: sha.value }
    : { kind: "rejected", outcome: "invalid_sha" };
}
