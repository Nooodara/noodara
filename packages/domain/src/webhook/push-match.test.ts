import { describe, expect, it } from "vitest";
import { GITHUB_ZERO_SHA, matchPush, normalizeRepositoryUrl } from "./index.js";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const service = {
  repositoryUrl: "https://github.com/acme/api.git",
  branch: "main",
};

const push = (over: Record<string, unknown> = {}) => ({
  ref: "refs/heads/main",
  after: SHA,
  deleted: false,
  repository: {
    clone_url: "https://github.com/acme/api.git",
    ssh_url: "git@github.com:acme/api.git",
  },
  ...over,
});
const repo = (
  clone_url: string,
  ssh_url = "git@example.invalid:none/none.git",
) => ({ clone_url, ssh_url });

describe("normalizeRepositoryUrl", () => {
  it.each([
    ["https://github.com/acme/api.git", "github.com/acme/api"],
    ["https://GitHub.COM/acme/api/", "github.com/acme/api"],
    ["https://github.com/acme/api.git/", "github.com/acme/api"],
    ["https://user@github.com:443/acme/api", "github.com/acme/api"],
    ["ssh://git@github.com/acme/api.git", "github.com/acme/api"],
    ["ssh://git@GITHUB.com:22/acme/api", "github.com/acme/api"],
    ["git@github.com:acme/api.git", "github.com/acme/api"],
    ["git@ghe.example.com:/srv/acme/api.git", "ghe.example.com/srv/acme/api"],
    ["ssh://git@[2001:db8::1]:2222/acme/api", "[2001:db8::1]/acme/api"],
    ["https://github.com/Acme/API", "github.com/Acme/API"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeRepositoryUrl(input)).toBe(expected);
  });

  it.each([
    "http://github.com/acme/api",
    "git://github.com/acme/api.git",
    "https://github.com",
    "https://github.com/",
    "https://github.com/.git",
    "github.com/acme/api",
    "git@github.com:",
    "https://git@/acme/api",
    "https://github.com:http/acme/api",
    "ssh://git@[zz::1]/acme/api",
    "https://git hub.com/acme/api",
    "",
  ])("returns null for %j", (input) => {
    expect(normalizeRepositoryUrl(input)).toBeNull();
  });
});

describe("matchPush", () => {
  it("returns the pushed SHA for a matching branch push", () => {
    expect(matchPush(service, "push", push())).toEqual({
      kind: "deploy",
      sha: SHA,
    });
  });

  it("answers ping with the ping outcome and rejects an invalid ping payload", () => {
    expect(matchPush(service, "ping", { zen: "z", hook_id: 1 })).toEqual({
      kind: "ping",
      outcome: "ping",
    });
    expect(matchPush(service, "ping", { zen: "z" })).toEqual({
      kind: "rejected",
      outcome: "invalid_payload",
    });
  });

  it.each(["pull_request", "release", "Push", "", undefined])(
    "ignores the unsupported event %j",
    (event) => {
      expect(matchPush(service, event, push())).toEqual({
        kind: "ignored",
        outcome: "ignored_event",
      });
    },
  );

  it("rejects a push payload that fails the schema", () => {
    expect(matchPush(service, "push", { ref: "refs/heads/main" })).toEqual({
      kind: "rejected",
      outcome: "invalid_payload",
    });
  });

  it("ignores tags, other refs, deletions, the zero SHA and other branches", () => {
    expect(
      matchPush(service, "push", push({ ref: "refs/tags/v1.0.0" })),
    ).toEqual({
      kind: "ignored",
      outcome: "ignored_tag",
    });
    expect(
      matchPush(service, "push", push({ ref: "refs/pull/1/head" })),
    ).toEqual({
      kind: "ignored",
      outcome: "ignored_ref",
    });
    expect(matchPush(service, "push", push({ deleted: true }))).toEqual({
      kind: "ignored",
      outcome: "ignored_deletion",
    });
    expect(
      matchPush(service, "push", push({ after: GITHUB_ZERO_SHA })),
    ).toEqual({
      kind: "ignored",
      outcome: "ignored_deletion",
    });
    expect(matchPush(service, "push", push({ ref: "refs/heads/dev" }))).toEqual(
      {
        kind: "ignored",
        outcome: "ignored_branch",
      },
    );
  });

  it("compares the branch exactly: prefixes, suffixes and case do not match (H1)", () => {
    const feature = { ...service, branch: "feature/x" };
    for (const ref of [
      "refs/heads/feature",
      "refs/heads/feature/x2",
      "refs/heads/feature/x/y",
      "refs/heads/Feature/x",
      "refs/heads/main",
    ]) {
      expect(matchPush(feature, "push", push({ ref }))).toEqual({
        kind: "ignored",
        outcome: "ignored_branch",
      });
    }
    expect(matchPush({ ...service, branch: "mai" }, "push", push())).toEqual({
      kind: "ignored",
      outcome: "ignored_branch",
    });
    expect(
      matchPush(feature, "push", push({ ref: "refs/heads/feature/x" })),
    ).toEqual({ kind: "deploy", sha: SHA });
  });

  it("rejects non-40-hex and uppercase SHAs (H1)", () => {
    for (const after of [
      SHA.toUpperCase(),
      SHA.slice(0, 39),
      `${SHA}0`,
      `${SHA.slice(0, 39)}g`,
      "",
    ]) {
      expect(matchPush(service, "push", push({ after }))).toEqual({
        kind: "rejected",
        outcome: "invalid_sha",
      });
    }
  });

  it("matches the service repository through any https or ssh form (H1)", () => {
    const forms = [
      "https://github.com/acme/api",
      "https://GITHUB.com/acme/api.git/",
      "ssh://git@github.com/acme/api.git",
      "git@GitHub.com:acme/api",
    ];
    for (const repositoryUrl of forms) {
      expect(matchPush({ ...service, repositoryUrl }, "push", push())).toEqual({
        kind: "deploy",
        sha: SHA,
      });
    }
    // Only the ssh_url of the payload matches the service.
    expect(
      matchPush(
        { ...service, repositoryUrl: "git@github.com:acme/api.git" },
        "push",
        push({
          repository: {
            clone_url: "https://mirror.invalid/x/y",
            ssh_url: "git@github.com:acme/api.git",
          },
        }),
      ),
    ).toEqual({ kind: "deploy", sha: SHA });
    // Only the html_url matches.
    expect(
      matchPush(
        service,
        "push",
        push({
          repository: {
            ...repo("https://mirror.invalid/x/y"),
            html_url: "https://github.com/acme/api",
          },
        }),
      ),
    ).toEqual({ kind: "deploy", sha: SHA });
  });

  it("rejects a repository that is not the service one, before looking at the ref", () => {
    const mismatch = { kind: "rejected", outcome: "repository_mismatch" };
    expect(
      matchPush(
        service,
        "push",
        push({ repository: repo("https://github.com/acme/web.git") }),
      ),
    ).toEqual(mismatch);
    expect(
      matchPush(
        service,
        "push",
        push({ repository: repo("https://github.com/acme/api-old.git") }),
      ),
    ).toEqual(mismatch);
    expect(
      matchPush(
        service,
        "push",
        push({ repository: repo("https://gitlab.com/acme/api.git") }),
      ),
    ).toEqual(mismatch);
    expect(
      matchPush(
        service,
        "push",
        push({ repository: repo("https://github.com/ACME/api.git") }),
      ),
    ).toEqual(mismatch);
    expect(
      matchPush(
        service,
        "push",
        push({
          ref: "refs/tags/v1",
          repository: repo("https://github.com/acme/web.git"),
        }),
      ),
    ).toEqual(mismatch);
    expect(
      matchPush({ ...service, repositoryUrl: "not a url" }, "push", push()),
    ).toEqual(mismatch);
    expect(
      matchPush(service, "push", push({ repository: repo("", "") })),
    ).toEqual(mismatch);
  });
});
