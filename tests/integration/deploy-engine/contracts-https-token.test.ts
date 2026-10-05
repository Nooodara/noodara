// 12-06: HTTPS-token clone contract (ADR 0008 open item 4) on the real sshd + dockerd fixture.
// A git-http-backend host behind nginx basic auth (per-run CA, per-run token) serves node-api; the
// deploy host clones it through @noodara/git cloneRepository with the askpass helper in its own
// <ws>/secrets/askpass slot. Root-side `stack.exec` is used only for truth (rev-parse, stat, ps).
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DEPLOYMENT_ERROR_CODES } from "@noodara/domain/deployment";
import {
  createRedactor,
  secretValue,
  type Redactor,
} from "@noodara/domain/security";
import {
  deployWorkspaceFor,
  validateResourceId,
  validateServiceSource,
  type DeployWorkspace,
  type ServiceSource,
  type ValidationResult,
} from "@noodara/domain/validators";
import {
  createSsh2Adapter,
  type SshDeploySession,
  type StreamChunk,
} from "@noodara/ssh";
import {
  ASKPASS_FILE_NAME,
  askpassFileFor,
} from "@noodara/ssh/testing/deploy-templates";
// Relative source imports, as in engine-primitives.test.ts: the root package.json does not declare
// @noodara/git / @noodara/docker.
import {
  cloneRepository,
  type GitCredential,
} from "../../../packages/git/src/index.js";
import {
  removeWorkspace,
  type DockerStepContext,
  type StepLimits,
  type StepResult,
} from "../../../packages/docker/src/index.js";
import {
  DEPLOY_ENGINE_UBUNTU_VERSIONS,
  GIT_HTTPS_USERNAME,
  startDeployEngineStack,
  type DeployEngineStack,
} from "../helpers/deploy-engine.js";
import { assertNoStrayTestContainers } from "../helpers/ssh.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(HERE, "../../../fixtures");
const STACK_TIMEOUT_MS = 900_000;
const STEP_TEST_TIMEOUT_MS = 300_000;
const SAMPLER_TIMEOUT_MS = 300_000;
const REPO = "node-api";

const LIMITS: StepLimits = {
  maxDurationMs: 240_000,
  idleTimeoutMs: 120_000,
  maxTotalBytes: 1_048_576,
  maxLineBytes: 16_384,
};

/** RFC 9562 UUIDv7 (the resource-id format the control plane issues). */
function uuidv7(): string {
  const bytes = randomBytes(16);
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i += 1)
    bytes[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function valid<T>(result: ValidationResult<T>): T {
  if (!result.ok) throw new Error(`fixture failed validation: ${result.code}`);
  return result.value;
}

function freshWorkspace(): DeployWorkspace {
  return valid(deployWorkspaceFor(valid(validateResourceId(uuidv7()))));
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** argv (`ps -eww`) and every /proc/<pid>/cmdline and environ, as root, every ~20 ms. */
const SAMPLER_SCRIPT = `stop=$1; out=$2
umask 077
: > "$out"
while [ ! -e "$stop" ]; do
  ps -eww -o args= >> "$out" 2>/dev/null
  for p in /proc/[0-9]*; do
    cat "$p/cmdline" >> "$out" 2>/dev/null; printf '\\n' >> "$out"
    cat "$p/environ" >> "$out" 2>/dev/null; printf '\\n' >> "$out"
  done
  sleep 0.02
done
`;

async function sampleProcessesDuring<T>(
  stack: DeployEngineStack,
  body: () => Promise<T>,
): Promise<{ value: T; samples: string }> {
  const tag = randomUUID();
  const stop = `/tmp/noodara-sampler-stop-${tag}`;
  const out = `/tmp/noodara-sampler-out-${tag}`;
  const sampling = stack.exec(["sh", "-c", SAMPLER_SCRIPT, "sh", stop, out], {
    user: "root",
    timeoutMs: SAMPLER_TIMEOUT_MS,
  });
  try {
    for (let i = 0; i < 100; i += 1) {
      const started = await stack.exec(["test", "-s", out], { user: "root" });
      if (started.exitCode === 0) break;
      await delay(50);
    }
    const value = await body();
    await stack.exec(["touch", stop], { user: "root" });
    await sampling;
    const read = await stack.exec(
      ["sh", "-c", 'tr "\\000" " " < "$0" | sort -u', out],
      {
        user: "root",
      },
    );
    return { value, samples: read.stdout };
  } finally {
    await stack.exec(["touch", stop], { user: "root" });
    await sampling.catch(() => undefined);
    await stack.exec(["rm", "-f", stop, out], { user: "root" });
  }
}

describe.each(DEPLOY_ENGINE_UBUNTU_VERSIONS)(
  "12-06 / ADR 0008 open item 4: HTTPS-token clone through the askpass slot, Ubuntu %s",
  (ubuntu) => {
    let stack: DeployEngineStack | undefined;
    let session: SshDeploySession | undefined;
    const redactor: Redactor = createRedactor();
    /** Every chunk, tail and failure message the wrappers produced in this suite. */
    const transcript: string[] = [];
    /** Every root-side observation that must not contain a token, by origin. */
    const observed: { readonly origin: string; readonly text: string }[] = [];
    /** Every token this suite handed to a clone (the right one and the wrong one). */
    const canaries: string[] = [];

    const s = (): DeployEngineStack => {
      if (stack === undefined) throw new Error("stack not started");
      return stack;
    };
    const sess = (): SshDeploySession => {
      if (session === undefined) throw new Error("session not connected");
      return session;
    };
    const https = () => {
      const host = s().httpsGit;
      if (host === null) throw new Error("stack started without httpsGit");
      return host;
    };
    const dockerContext = (): DockerStepContext => ({
      session: sess(),
      redactor,
      limits: LIMITS,
      onChunk: (chunk) => transcript.push(chunk.text),
    });
    const record = <T>(step: StepResult<T>): StepResult<T> => {
      if (step.ok)
        transcript.push(step.result.stdoutTail, step.result.stderrTail);
      else if (step.kind === "failed") transcript.push(step.message);
      return step;
    };
    const rootOut = async (argv: readonly string[]): Promise<string> =>
      (await s().exec(argv, { user: "root" })).stdout.trim();
    const pathGone = async (target: string): Promise<boolean> =>
      (await rootOut([
        "sh",
        "-c",
        'test -e "$0" && echo present || echo gone',
        target,
      ])) === "gone";
    const httpsSource = (): Extract<ServiceSource, { kind: "git" }> => {
      const source = valid(
        validateServiceSource({
          kind: "git",
          repositoryUrl: https().repoUrl(REPO),
          branch: "main",
        }),
      );
      if (source.kind !== "git") throw new Error("expected a git source");
      return source;
    };
    const tokenCredential = (token: string): GitCredential => {
      canaries.push(
        token,
        Buffer.from(`${GIT_HTTPS_USERNAME}:${token}`).toString("base64"),
      );
      return { kind: "https_token", token: secretValue(token, "api_key") };
    };
    const clone = (
      workspace: DeployWorkspace,
      token: string,
      sink: StreamChunk[],
    ) =>
      cloneRepository({
        session: sess(),
        redactor,
        workspace,
        source: httpsSource(),
        credential: tokenCredential(token),
        limits: LIMITS,
        onChunk: (chunk) => {
          transcript.push(chunk.text);
          sink.push(chunk);
        },
      }).then(record);
    const removeAndCheck = async (
      workspace: DeployWorkspace,
    ): Promise<void> => {
      const removed = record(
        await removeWorkspace(dockerContext(), { workspace }),
      );
      expect(removed.ok).toBe(true);
      expect(await pathGone(askpassFileFor(workspace))).toBe(true);
      expect(await pathGone(workspace.secretFile("https_token"))).toBe(true);
      expect(await pathGone(workspace.root)).toBe(true);
    };

    beforeAll(async () => {
      stack = await startDeployEngineStack({
        ubuntu,
        seedRepositories: [
          { name: REPO, sourceDir: path.join(FIXTURES_DIR, "node-api") },
        ],
        httpsGit: true,
      });
      const outcome = await createSsh2Adapter().connect({
        target: {
          host: stack.ssh.host,
          port: stack.ssh.port,
          user: stack.ssh.user,
        },
        credential: {
          kind: "private_key",
          privateKey: secretValue(stack.ssh.privateKey, "ssh_private_key"),
        },
        timeouts: {
          connectMs: 20_000,
          commandMs: 60_000,
          discoveryMs: 120_000,
        },
        trustedFingerprint: null,
        redactor,
      });
      if (!outcome.ok) throw new Error(`connect failed: ${outcome.errorCode}`);
      session = outcome.session;
    }, STACK_TIMEOUT_MS);

    afterAll(async () => {
      await session?.close();
      await stack?.stop();
      await assertNoStrayTestContainers();
      const networks = execFileSync(
        "docker",
        ["network", "ls", "-q", "--filter", "label=noodara.test=true"],
        { encoding: "utf8", timeout: 60_000 },
      );
      expect(networks.trim()).toBe("");
    }, STACK_TIMEOUT_MS);

    it(
      "A1/A2: the right token clones over HTTPS via <ws>/secrets/askpass (0700, own slot), no helper persists it, and the workspace removal takes both files",
      async () => {
        const workspace = freshWorkspace();
        const sink: StreamChunk[] = [];
        const expectedSha = (
          await s().exec(
            ["git", "-C", `/srv/git/${REPO}.git`, "rev-parse", "main"],
            { user: "git" },
          )
        ).stdout.trim();
        expect(expectedSha).toMatch(/^[0-9a-f]{40}$/);

        // A user-level `store` helper must not capture the token: the template resets helpers.
        const helper = await s().exec(
          ["git", "config", "--global", "credential.helper", "store"],
          {
            user: "deployer",
          },
        );
        expect(helper.exitCode).toBe(0);
        try {
          const { value: cloned, samples } = await sampleProcessesDuring(
            s(),
            () => clone(workspace, https().token, sink),
          );
          observed.push({ origin: "ps/proc during clone", text: samples });
          // The sampler overlapped the clone: its argv (with the workspace path) was captured.
          expect(samples).toContain(workspace.repo);
          if (!cloned.ok) {
            const detail =
              cloned.kind === "failed"
                ? `${cloned.code}: ${cloned.message}`
                : cloned.outcome;
            throw new Error(`https clone did not succeed (${detail})`);
          }
          expect(cloned.value.commitSha).toBe(expectedSha);

          // A1: own slot, owner-only. 0700 because git execs the helper without a shell.
          const askpass = askpassFileFor(workspace);
          expect(askpass).toBe(
            `${workspace.root}/secrets/${ASKPASS_FILE_NAME}`,
          );
          expect(askpass).not.toBe(workspace.secretFile("known_hosts"));
          expect(await rootOut(["stat", "-c", "%a %U", askpass])).toBe(
            "700 deployer",
          );
          expect(
            await rootOut([
              "stat",
              "-c",
              "%a %U",
              workspace.secretFile("https_token"),
            ]),
          ).toBe("600 deployer");
          expect(
            await rootOut(["stat", "-c", "%a", workspace.secretsDir]),
          ).toBe("700");
          expect(await pathGone(workspace.secretFile("known_hosts"))).toBe(
            true,
          );
          expect(await pathGone(workspace.secretFile("deploy_key"))).toBe(true);

          // A3: the remote URL is the plain URL, no userinfo.
          const remote = await s().exec(
            ["git", "-C", workspace.repo, "remote", "get-url", "origin"],
            {
              user: "deployer",
            },
          );
          expect(remote.stdout.trim()).toBe(https().repoUrl(REPO));
          expect(remote.stdout).not.toContain("@");
          observed.push({
            origin: "git remote get-url origin",
            text: remote.stdout,
          });
          observed.push({
            origin: ".git/config",
            text: await rootOut(["cat", `${workspace.repo}/.git/config`]),
          });
          observed.push({
            origin: "clone tree outside .git/objects",
            text: await rootOut([
              "sh",
              "-c",
              'find "$0" -type f -not -path "$0/.git/objects/*" -exec cat {} +',
              workspace.repo,
            ]),
          });
          for (const credentials of [
            "/home/deployer/.git-credentials",
            "/home/deployer/.config/git/credentials",
          ]) {
            expect(await pathGone(credentials), credentials).toBe(true);
          }
        } finally {
          await s().exec(
            ["git", "config", "--global", "--unset-all", "credential.helper"],
            {
              user: "deployer",
            },
          );
        }

        await removeAndCheck(workspace);
      },
      STEP_TEST_TIMEOUT_MS,
    );

    it(
      "A2: a wrong token fails as REPOSITORY_AUTH_FAILED with a curated message",
      async () => {
        const workspace = freshWorkspace();
        const sink: StreamChunk[] = [];
        const wrongToken = randomBytes(24).toString("base64url");
        expect(wrongToken).not.toBe(https().token);
        const { value: failed, samples } = await sampleProcessesDuring(
          s(),
          () => clone(workspace, wrongToken, sink),
        );
        observed.push({ origin: "ps/proc during failed clone", text: samples });
        expect(failed.ok).toBe(false);
        if (failed.ok || failed.kind !== "failed")
          throw new Error("expected a classified failure");
        expect(failed.code).toBe("REPOSITORY_AUTH_FAILED");
        expect(DEPLOYMENT_ERROR_CODES).toContain(failed.code);
        // Git's own wording reached the redacted stream, not the curated message.
        expect(sink.map((chunk) => chunk.text).join("")).toMatch(
          /Authentication failed for '/,
        );
        expect(failed.message).not.toMatch(/Authentication failed for '/);
        await removeAndCheck(workspace);
      },
      STEP_TEST_TIMEOUT_MS,
    );

    it("A3/SEC canary: no token (raw or as a basic-auth header) in ps, /proc, .git, the remote URL, chunks, tails or messages", () => {
      // Both clones ran: two tokens, each with its basic-auth encoding.
      expect(canaries).toHaveLength(4);
      expect(observed.length).toBeGreaterThanOrEqual(5);
      expect(transcript.length).toBeGreaterThan(0);
      for (const canary of canaries) {
        for (const { origin, text } of observed) {
          expect(text.includes(canary), `token leaked into ${origin}`).toBe(
            false,
          );
        }
        expect(
          transcript.some((text) => text.includes(canary)),
          "token leaked into a chunk, tail or message",
        ).toBe(false);
      }
    });
  },
);
