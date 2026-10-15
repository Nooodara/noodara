// Minimal zod schemas for the GitHub `push` and `ping` deliveries (16-05). Only the fields Noodara
// reads are declared; unknown keys are stripped without being walked. Every string and array is
// capped (H2), and the commits array is length-checked before any element is parsed.

import { z } from "zod";

export const GITHUB_PAYLOAD_LIMITS = Object.freeze({
  /** `refs/heads/` plus a 255-byte branch, with headroom. */
  ref: 512,
  /** SHA fields are length-capped here; matchPush enforces the exact 40-hex shape. */
  sha: 64,
  url: 2048,
  zen: 512,
  /** GitHub itself truncates `commits` at 2048 entries. */
  commits: 2048,
});

export const GITHUB_ZERO_SHA = "0".repeat(40);

function boundedArray<T extends z.ZodType>(element: T, max: number) {
  return z
    .custom<unknown[]>((value) => Array.isArray(value) && value.length <= max, {
      error: `Expected an array of at most ${String(max)} items`,
    })
    .pipe(z.array(element));
}

const shaField = z.string().max(GITHUB_PAYLOAD_LIMITS.sha);
const urlField = z.string().max(GITHUB_PAYLOAD_LIMITS.url);
const commitSchema = z.object({ id: shaField });

export const githubPushPayloadSchema = z.object({
  ref: z.string().max(GITHUB_PAYLOAD_LIMITS.ref),
  before: shaField.optional(),
  after: shaField,
  deleted: z.boolean(),
  repository: z.object({
    clone_url: urlField,
    ssh_url: urlField,
    html_url: urlField.optional(),
  }),
  commits: boundedArray(commitSchema, GITHUB_PAYLOAD_LIMITS.commits).optional(),
  head_commit: commitSchema.nullable().optional(),
});

export type GithubPushPayload = z.infer<typeof githubPushPayloadSchema>;

export const githubPingPayloadSchema = z.object({
  zen: z.string().max(GITHUB_PAYLOAD_LIMITS.zen).optional(),
  hook_id: z.int().positive(),
});

export type GithubPingPayload = z.infer<typeof githubPingPayloadSchema>;
