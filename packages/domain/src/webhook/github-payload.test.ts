import { describe, expect, it } from "vitest";
import {
  GITHUB_PAYLOAD_LIMITS,
  githubPingPayloadSchema,
  githubPushPayloadSchema,
} from "./index.js";

const SHA = "a".repeat(40);

const push = (over: Record<string, unknown> = {}) => ({
  ref: "refs/heads/main",
  before: "0".repeat(40),
  after: SHA,
  deleted: false,
  repository: {
    clone_url: "https://github.com/acme/api.git",
    ssh_url: "git@github.com:acme/api.git",
    html_url: "https://github.com/acme/api",
  },
  ...over,
});

describe("githubPushPayloadSchema", () => {
  it("parses the minimal push payload and ignores unknown fields", () => {
    const result = githubPushPayloadSchema.safeParse(
      push({
        pusher: { name: "x" },
        sender: { login: "y" },
        huge: "z".repeat(100_000),
      }),
    );
    expect(result.success).toBe(true);
    expect(result.data).not.toHaveProperty("pusher");
    expect(result.data).not.toHaveProperty("huge");
    expect(result.data?.repository).toEqual({
      clone_url: "https://github.com/acme/api.git",
      ssh_url: "git@github.com:acme/api.git",
      html_url: "https://github.com/acme/api",
    });
  });

  it("accepts an optional commits array and head_commit, stripping their unknown fields", () => {
    const result = githubPushPayloadSchema.safeParse(
      push({
        commits: [{ id: SHA, message: "m", author: {} }],
        head_commit: { id: SHA, tree_id: "t" },
      }),
    );
    expect(result.data?.commits).toEqual([{ id: SHA }]);
    expect(result.data?.head_commit).toEqual({ id: SHA });
    expect(
      githubPushPayloadSchema.safeParse(push({ head_commit: null })).success,
    ).toBe(true);
  });

  it.each(["ref", "after", "deleted", "repository"])(
    "rejects a payload missing %s",
    (key) => {
      const payload = Object.fromEntries(
        Object.entries(push()).filter(([name]) => name !== key),
      );
      expect(githubPushPayloadSchema.safeParse(payload).success).toBe(false);
    },
  );

  it.each(["clone_url", "ssh_url"])(
    "rejects a repository missing %s",
    (key) => {
      const repository = Object.fromEntries(
        Object.entries(push().repository).filter(([name]) => name !== key),
      );
      expect(
        githubPushPayloadSchema.safeParse(push({ repository })).success,
      ).toBe(false);
    },
  );

  it("rejects wrong types and non-object payloads", () => {
    expect(
      githubPushPayloadSchema.safeParse(push({ deleted: "no" })).success,
    ).toBe(false);
    expect(githubPushPayloadSchema.safeParse(push({ ref: 1 })).success).toBe(
      false,
    );
    expect(githubPushPayloadSchema.safeParse(null).success).toBe(false);
    expect(githubPushPayloadSchema.safeParse("push").success).toBe(false);
  });

  describe("bounds (H2)", () => {
    const over = (n: number) => "x".repeat(n + 1);
    it.each([
      [
        "ref",
        () => push({ ref: `refs/heads/${over(GITHUB_PAYLOAD_LIMITS.ref)}` }),
      ],
      ["after", () => push({ after: over(GITHUB_PAYLOAD_LIMITS.sha) })],
      ["before", () => push({ before: over(GITHUB_PAYLOAD_LIMITS.sha) })],
      [
        "clone_url",
        () =>
          push({
            repository: {
              ...push().repository,
              clone_url: over(GITHUB_PAYLOAD_LIMITS.url),
            },
          }),
      ],
      [
        "ssh_url",
        () =>
          push({
            repository: {
              ...push().repository,
              ssh_url: over(GITHUB_PAYLOAD_LIMITS.url),
            },
          }),
      ],
      [
        "html_url",
        () =>
          push({
            repository: {
              ...push().repository,
              html_url: over(GITHUB_PAYLOAD_LIMITS.url),
            },
          }),
      ],
      [
        "commit id",
        () => push({ commits: [{ id: over(GITHUB_PAYLOAD_LIMITS.sha) }] }),
      ],
      [
        "head_commit id",
        () => push({ head_commit: { id: over(GITHUB_PAYLOAD_LIMITS.sha) } }),
      ],
    ])("rejects an oversized %s", (_name, build) => {
      expect(githubPushPayloadSchema.safeParse(build()).success).toBe(false);
    });

    it("accepts exactly the maximum number of commits", () => {
      const commits = Array.from(
        { length: GITHUB_PAYLOAD_LIMITS.commits },
        () => ({ id: SHA }),
      );
      expect(githubPushPayloadSchema.safeParse(push({ commits })).success).toBe(
        true,
      );
    });

    it("rejects an oversized commits array without visiting any element", () => {
      let touched = 0;
      const element = {
        get id() {
          touched += 1;
          return SHA;
        },
      };
      const commits = Array.from(
        { length: GITHUB_PAYLOAD_LIMITS.commits + 1 },
        () => element,
      );
      expect(githubPushPayloadSchema.safeParse(push({ commits })).success).toBe(
        false,
      );
      expect(touched).toBe(0);
    });

    it("rejects a commits value that is not an array", () => {
      expect(
        githubPushPayloadSchema.safeParse(push({ commits: { length: 1 } }))
          .success,
      ).toBe(false);
    });
  });
});

describe("githubPingPayloadSchema", () => {
  it("parses the minimal ping payload and ignores unknown fields", () => {
    const result = githubPingPayloadSchema.safeParse({
      zen: "Keep it simple.",
      hook_id: 42,
      hook: { a: 1 },
    });
    expect(result.data).toEqual({ zen: "Keep it simple.", hook_id: 42 });
    expect(githubPingPayloadSchema.safeParse({ hook_id: 1 }).success).toBe(
      true,
    );
  });

  it("rejects a missing or invalid hook_id and an oversized zen", () => {
    expect(githubPingPayloadSchema.safeParse({ zen: "z" }).success).toBe(false);
    expect(githubPingPayloadSchema.safeParse({ hook_id: 1.5 }).success).toBe(
      false,
    );
    expect(githubPingPayloadSchema.safeParse({ hook_id: 0 }).success).toBe(
      false,
    );
    expect(
      githubPingPayloadSchema.safeParse({
        hook_id: 1,
        zen: "z".repeat(GITHUB_PAYLOAD_LIMITS.zen + 1),
      }).success,
    ).toBe(false);
  });
});
