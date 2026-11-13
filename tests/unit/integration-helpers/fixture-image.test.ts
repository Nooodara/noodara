// 36-04 A1, A2, A3 (module part), H1-H6, H7 (temp-tag part): content-addressed fixture images.
// Pure unit tests: a stateful fake Docker facade and temp directories, no Docker daemon.
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  FIXTURE_FALLBACK_MESSAGES,
  FIXTURE_IDENTITY_BUILD_ARG,
  FIXTURE_IMAGE_PULL_BUDGET_MS,
  FIXTURE_REGISTRY_ENV,
  INVALID_REGISTRY_MESSAGE,
  classifyPullFailure,
  computeFixtureIdentity,
  createDockerCliFacade,
  fixtureOwnerTag,
  hashFixtureIdentity,
  isDockerignored,
  localFixtureRef,
  parseDockerignore,
  parseGitLsFilesStage,
  remoteFixtureRef,
  resetFixtureImageState,
  resolveFixtureImage,
  toContextRelativePath,
  validateRegistryReference,
  type ContextEntry,
  type FallbackReason,
  type FixtureDockerFacade,
  type FixtureImageInfo,
  type FixturePlatform,
  type ResolveFixtureImageOptions,
} from "../../integration/helpers/fixture-image";
import {
  RUNNER_TIMEOUT_DEFAULTS,
  TIMEOUT_SCALE_MAX,
  TIMEOUT_SCALE_MIN,
  scaleTimeout,
} from "../../support/timeout-scale";

const repoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const MODULE_PATH = path.join(
  repoRoot,
  "tests/integration/helpers/fixture-image.ts",
);

const NAME = "sshd-ubuntu-24.04";
const IDENTITY = createHash("sha256").update("fixture").digest("hex");
const OTHER_IDENTITY = createHash("sha256").update("other").digest("hex");
const REGISTRY = "ghcr.io/noodara/fixtures";
const HASH_REF = localFixtureRef(NAME, IDENTITY);
const REMOTE_REF = remoteFixtureRef(REGISTRY, NAME, IDENTITY);
const CANARY = "CANARY-ghp_s3cr3tT0k3nValue";

// ----------------------------------------------------------------------------------------------
// Fake Docker
// ----------------------------------------------------------------------------------------------

interface FakeImage extends FixtureImageInfo {
  readonly id: string;
}

const good = (id: string, label: string | null = IDENTITY): FakeImage => ({
  id,
  label,
  os: "linux",
  architecture: "amd64",
});

interface FakeDocker extends FixtureDockerFacade {
  readonly images: Map<string, FakeImage>;
  readonly calls: string[];
  readonly tagTargets: string[];
  readonly removed: string[];
  readonly pulls: { ref: string; timeoutMs: number }[];
  platform: FixturePlatform | null;
  pullImpl: (ref: string, signal: AbortSignal) => Promise<void>;
  onInspect: ((ref: string) => void) | undefined;
}

function createFakeDocker(): FakeDocker {
  const fake: FakeDocker = {
    images: new Map(),
    calls: [],
    tagTargets: [],
    removed: [],
    pulls: [],
    platform: { os: "linux", architecture: "amd64" },
    pullImpl: () =>
      Promise.reject(
        Object.assign(new Error("pull failed"), { stderr: "manifest unknown" }),
      ),
    onInspect: undefined,
    inspectImage(ref) {
      fake.calls.push(`inspect ${ref}`);
      fake.onInspect?.(ref);
      const image = fake.images.get(ref);
      return Promise.resolve(
        image
          ? {
              label: image.label,
              os: image.os,
              architecture: image.architecture,
            }
          : null,
      );
    },
    daemonPlatform() {
      fake.calls.push("version");
      return Promise.resolve(fake.platform);
    },
    pull(ref, options) {
      fake.calls.push(`pull ${ref}`);
      fake.pulls.push({ ref, timeoutMs: options.timeoutMs });
      return fake.pullImpl(ref, options.signal);
    },
    tag(source, target) {
      fake.calls.push(`tag ${source} ${target}`);
      const image = fake.images.get(source);
      if (!image) return Promise.reject(new Error("No such image"));
      fake.images.set(target, image);
      fake.tagTargets.push(target);
      return Promise.resolve();
    },
    removeImage(ref) {
      fake.calls.push(`rm ${ref}`);
      fake.removed.push(ref);
      fake.images.delete(ref);
      return Promise.resolve();
    },
  };
  return fake;
}

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeBuild(
  fake: FakeDocker,
  target: string,
  image: FakeImage = good("built"),
  hold?: Promise<void>,
) {
  return vi.fn(async () => {
    if (hold) await hold;
    fake.images.set(target, image);
  });
}

const abortingPull =
  (started?: () => void) => (_ref: string, signal: AbortSignal) =>
    new Promise<void>((_resolve, reject) => {
      started?.();
      signal.addEventListener(
        "abort",
        () =>
          reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        { once: true },
      );
    });

let reports: string[];

function options(
  fake: FakeDocker,
  overrides: Partial<ResolveFixtureImageOptions> = {},
): ResolveFixtureImageOptions {
  const target = overrides.target ?? fixtureOwnerTag(NAME);
  return {
    name: NAME,
    identity: IDENTITY,
    target,
    docker: fake,
    build: makeBuild(fake, target),
    pullDeadlineMs: 1_000,
    pullSettleGraceMs: 20,
    report: (message) => reports.push(message),
    ...overrides,
  };
}

/** H6/H7 invariants every scenario must keep. */
function expectInvariants(
  fake: FakeDocker,
  targets: readonly string[],
  identity = IDENTITY,
): void {
  const hashRef = localFixtureRef(NAME, identity);
  expect(fake.removed).not.toContain(hashRef);
  for (const created of fake.tagTargets)
    expect([...targets, hashRef]).toContain(created);
  for (const pull of fake.pulls)
    expect(pull.ref).toBe(remoteFixtureRef(REGISTRY, NAME, identity));
  const cached = fake.images.get(hashRef);
  if (cached) expect(cached.label).toBe(identity);
}

const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  resetFixtureImageState();
  reports = [];
});

// ----------------------------------------------------------------------------------------------
// A1 / H1: identity framing
// ----------------------------------------------------------------------------------------------

const entry = (
  p: string,
  content: string | Buffer,
  executable = false,
): ContextEntry => ({
  path: p,
  executable,
  content: typeof content === "string" ? Buffer.from(content, "utf8") : content,
});
const base = {
  dockerfile: "img/Dockerfile",
  buildArgs: {} as Record<string, string>,
};

describe("hashFixtureIdentity framing (A1, H1)", () => {
  it("is a stable 64-hex SHA-256", () => {
    const input = { ...base, entries: [entry("img/Dockerfile", "FROM x\n")] };
    expect(hashFixtureIdentity(input)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashFixtureIdentity(input)).toBe(hashFixtureIdentity(input));
  });

  it.each([
    [
      "bytes moved between a path and its content",
      [entry("ab", "c")],
      [entry("a", "bc")],
    ],
    [
      "bytes moved between two files",
      [entry("a", "xy"), entry("b", "")],
      [entry("a", "x"), entry("b", "y")],
    ],
    ["one content byte changed", [entry("a", "hello")], [entry("a", "hellp")]],
    [
      "executable bit changed",
      [entry("a.sh", "x", false)],
      [entry("a.sh", "x", true)],
    ],
    ["a file added", [entry("a", "x")], [entry("a", "x"), entry("b", "")]],
    ["a path renamed", [entry("a", "x")], [entry("b", "x")]],
    [
      "CRLF kept in a binary file",
      [entry("blob.bin", "a\r\nb")],
      [entry("blob.bin", "a\nb")],
    ],
  ])("changes when %s", (_label, left, right) => {
    expect(hashFixtureIdentity({ ...base, entries: left })).not.toBe(
      hashFixtureIdentity({ ...base, entries: right }),
    );
  });

  it.each([
    ["bytes moved between an arg key and value", { ab: "c" }, { a: "bc" }],
    ["an arg value changed", { A: "1" }, { A: "2" }],
    ["an arg added", {}, { A: "" }],
  ])("changes when %s", (_label, left, right) => {
    const entries = [entry("a", "x")];
    expect(hashFixtureIdentity({ ...base, buildArgs: left, entries })).not.toBe(
      hashFixtureIdentity({ ...base, buildArgs: right, entries }),
    );
  });

  it("changes with the Dockerfile path", () => {
    const entries = [entry("a/Dockerfile", "x"), entry("b/Dockerfile", "x")];
    expect(
      hashFixtureIdentity({
        dockerfile: "a/Dockerfile",
        buildArgs: {},
        entries,
      }),
    ).not.toBe(
      hashFixtureIdentity({
        dockerfile: "b/Dockerfile",
        buildArgs: {},
        entries,
      }),
    );
  });

  it.each([
    [
      "args in another order",
      { buildArgs: { B: "2", A: "1" } },
      { buildArgs: { A: "1", B: "2" } },
    ],
    [
      "the identity build arg itself",
      { buildArgs: { A: "1", [FIXTURE_IDENTITY_BUILD_ARG]: IDENTITY } },
      { buildArgs: { A: "1" } },
    ],
  ])("ignores %s", (_label, left, right) => {
    const entries = [entry("a", "x")];
    expect(hashFixtureIdentity({ ...base, ...left, entries })).toBe(
      hashFixtureIdentity({ ...base, ...right, entries }),
    );
  });

  it("ignores entry order", () => {
    const entries = [entry("b", "2"), entry("a", "1"), entry("c/d", "3")];
    expect(hashFixtureIdentity({ ...base, entries })).toBe(
      hashFixtureIdentity({ ...base, entries: [...entries].reverse() }),
    );
  });

  it.each([
    "img/Dockerfile",
    "x/.dockerignore",
    "x/run.sh",
    "x/sshd.conf",
    "x/a.yml",
    "x/a.yaml",
    "x/a.json",
    "x/a.md",
    "x/a.txt",
  ])("normalises CRLF to LF in declared text file %s", (file) => {
    expect(
      hashFixtureIdentity({ ...base, entries: [entry(file, "a\r\nb\r\n")] }),
    ).toBe(hashFixtureIdentity({ ...base, entries: [entry(file, "a\nb\n")] }));
  });

  it.each(["", "/abs", "../up", "a/../b", "a\\b", "a//b", "./a"])(
    "rejects the entry path %j",
    (bad) => {
      expect(() =>
        hashFixtureIdentity({ ...base, entries: [entry(bad, "x")] }),
      ).toThrow(/invalid relative path/);
    },
  );

  it("rejects duplicate paths", () => {
    expect(() =>
      hashFixtureIdentity({
        ...base,
        entries: [entry("a", "1"), entry("a", "2")],
      }),
    ).toThrow(/same path twice/);
  });
});

// ----------------------------------------------------------------------------------------------
// A1 / H1 / H2: build context enumeration
// ----------------------------------------------------------------------------------------------

describe("build context enumeration (A1, H1, H2)", () => {
  let tempRoot: string;
  beforeEach(async () => {
    tempRoot = await mkdtemp(path.join(os.tmpdir(), "fixture-image-"));
  });
  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  const BLOB = Buffer.from([0x00, 0x0d, 0x0a, 0xff, 0x0d, 0x0a]);

  async function writeContext(
    dir: string,
    layout: { crlf: boolean; execBits: boolean },
  ): Promise<void> {
    const text = (value: string) =>
      layout.crlf ? value.replaceAll("\n", "\r\n") : value;
    await mkdir(path.join(dir, "img"), { recursive: true });
    await mkdir(path.join(dir, "common/conf.d"), { recursive: true });
    await writeFile(
      path.join(dir, "img/Dockerfile"),
      text("FROM ubuntu:24.04\nCOPY common /c\n"),
    );
    await writeFile(
      path.join(dir, "common/entrypoint.sh"),
      text('#!/bin/sh\nexec "$@"\n'),
    );
    await writeFile(
      path.join(dir, "common/conf.d/test.conf"),
      text("Port 22\n"),
    );
    await writeFile(path.join(dir, "common/blob.bin"), BLOB);
    await chmod(
      path.join(dir, "common/entrypoint.sh"),
      layout.execBits ? 0o755 : 0o644,
    );
  }

  const identityOf = (
    dir: string,
    extra: Partial<Parameters<typeof computeFixtureIdentity>[0]> = {},
  ) =>
    computeFixtureIdentity({
      contextDir: dir,
      dockerfile: "img/Dockerfile",
      buildArgs: { UBUNTU: "24.04" },
      ...extra,
    });

  it("yields the same identity for Linux, macOS and a CRLF Windows checkout", async () => {
    const linux = path.join(tempRoot, "linux");
    const windows = path.join(tempRoot, "windows");
    await writeContext(linux, { crlf: false, execBits: true });
    await writeContext(windows, { crlf: true, execBits: false });
    const gitBits = vi.fn(
      async () => new Map([["common/entrypoint.sh", true]]),
    );

    const onLinux = await identityOf(linux, { platform: "linux" });
    expect(await identityOf(linux, { platform: "darwin" })).toBe(onLinux);
    expect(
      await identityOf(windows, {
        platform: "win32",
        gitExecutableBits: gitBits,
      }),
    ).toBe(onLinux);
    expect(gitBits).toHaveBeenCalledWith(path.resolve(windows));
    // Without the index the Windows checkout has no exec bit, which must change the identity.
    expect(
      await identityOf(windows, {
        platform: "win32",
        gitExecutableBits: async () => new Map(),
      }),
    ).not.toBe(onLinux);
  });

  it("changes when any byte of any context file or a build arg changes", async () => {
    const dir = path.join(tempRoot, "ctx");
    await writeContext(dir, { crlf: false, execBits: true });
    const original = await identityOf(dir);
    for (const file of [
      "img/Dockerfile",
      "common/entrypoint.sh",
      "common/conf.d/test.conf",
      "common/blob.bin",
    ]) {
      const absolute = path.join(dir, file);
      const content = await readFile(absolute);
      const changed = Buffer.from(content);
      changed[0] = (changed[0] ?? 0) ^ 0x01;
      await writeFile(absolute, changed);
      expect(await identityOf(dir), file).not.toBe(original);
      await writeFile(absolute, content);
    }
    expect(await identityOf(dir)).toBe(original);
    expect(await identityOf(dir, { buildArgs: { UBUNTU: "22.04" } })).not.toBe(
      original,
    );
  });

  it.each([
    [
      "inside the context",
      (dir: string) => path.join(dir, "common/entrypoint.sh"),
    ],
    ["outside the context", () => os.tmpdir()],
  ])("rejects a symlink pointing %s", async (_label, linkTarget) => {
    const dir = path.join(tempRoot, "ctx");
    await writeContext(dir, { crlf: false, execBits: true });
    await symlink(linkTarget(dir), path.join(dir, "common/link"));
    await expect(identityOf(dir)).rejects.toThrow(/symlink/);
  });

  it("excludes .dockerignore entries from the hash exactly as from the build", async () => {
    const dir = path.join(tempRoot, "ctx");
    await writeContext(dir, { crlf: false, execBits: true });
    await mkdir(path.join(dir, "docs/keep"), { recursive: true });
    await writeFile(path.join(dir, "docs/notes.txt"), "v1");
    await writeFile(path.join(dir, "docs/keep/kept.txt"), "v1");
    await writeFile(path.join(dir, "scratch.tmp"), "v1");
    await writeFile(
      path.join(dir, ".dockerignore"),
      "# comment\ndocs\n!docs/keep\n**/*.tmp\nimg/Dockerfile\n",
    );
    const original = await identityOf(dir);

    await writeFile(path.join(dir, "docs/notes.txt"), "v2");
    await writeFile(path.join(dir, "scratch.tmp"), "v2");
    expect(await identityOf(dir)).toBe(original);

    await writeFile(path.join(dir, "docs/keep/kept.txt"), "v2");
    expect(await identityOf(dir)).not.toBe(original);

    // The Dockerfile is sent to the builder even when ignored, so it stays in the hash.
    const reIncluded = await identityOf(dir);
    await writeFile(path.join(dir, "img/Dockerfile"), "FROM ubuntu:22.04\n");
    expect(await identityOf(dir)).not.toBe(reIncluded);
  });

  it("rejects .dockerignore syntax outside the supported subset", async () => {
    const dir = path.join(tempRoot, "ctx");
    await writeContext(dir, { crlf: false, execBits: true });
    await writeFile(path.join(dir, ".dockerignore"), "file[0-9]\n");
    await expect(identityOf(dir)).rejects.toThrow(
      /Unsupported \.dockerignore syntax/,
    );
  });

  it("rejects a Dockerfile outside the context", async () => {
    const dir = path.join(tempRoot, "ctx");
    await writeContext(dir, { crlf: false, execBits: true });
    await expect(
      identityOf(dir, { dockerfile: "../Dockerfile" }),
    ).rejects.toThrow(/escapes the context root/);
  });

  it("computes distinct, deterministic identities for the committed sshd contexts", async () => {
    const contextDir = path.join(repoRoot, "tests/integration/images");
    const of = (version: string) =>
      computeFixtureIdentity({
        contextDir,
        dockerfile: `sshd-ubuntu-${version}/Dockerfile`,
      });
    const jammy = await of("22.04");
    const noble = await of("24.04");
    expect(jammy).toMatch(/^[0-9a-f]{64}$/);
    expect(noble).toMatch(/^[0-9a-f]{64}$/);
    expect(jammy).not.toBe(noble);
    expect(await of("24.04")).toBe(noble);
  });
});

describe("path and ignore helpers (H2)", () => {
  it.each(["..", "../x", "../../etc/passwd", "/etc/passwd", ""])(
    "toContextRelativePath rejects %j",
    (target) => {
      expect(() => toContextRelativePath("/ctx/root", target)).toThrow(
        /escapes the context root/,
      );
    },
  );

  it("toContextRelativePath returns POSIX paths", () => {
    expect(toContextRelativePath("/ctx/root", "a/b/c.sh")).toBe("a/b/c.sh");
    expect(toContextRelativePath("/ctx/root", "/ctx/root/a/./b")).toBe("a/b");
  });

  it.each([
    ["docs", "docs/a/b.txt", true],
    ["docs/", "docs/a.txt", true],
    ["/docs", "docs/a.txt", true],
    ["*.md", "README.md", true],
    ["*.md", "sub/README.md", false],
    ["**/*.md", "sub/deep/README.md", true],
    ["**", "anything/at/all", true],
    ["a/**/z", "a/z", true],
    ["a/**/z", "a/b/c/z", true],
    ["file?.txt", "file1.txt", true],
    ["file?.txt", "file12.txt", false],
    ["a.b", "axb", false],
    ["docs\n!docs/keep", "docs/keep/x", false],
    ["docs\n!docs/keep", "docs/other", true],
    ["!docs\ndocs", "docs/x", true],
    ["# docs", "docs/x", false],
  ])("pattern %j on %j -> %s", (patterns, file, expected) => {
    expect(isDockerignored(parseDockerignore(patterns), file)).toBe(expected);
  });

  it("parses git ls-files -s -z output into executable bits", () => {
    const NUL = String.fromCharCode(0);
    const blob = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
    const output = `100755 ${blob} 0\ta b/run.sh${NUL}100644 ${blob} 0\tDockerfile${NUL}`;
    expect([...parseGitLsFilesStage(output)]).toEqual([
      ["a b/run.sh", true],
      ["Dockerfile", false],
    ]);
  });
});

// ----------------------------------------------------------------------------------------------
// H3: registry reference validation
// ----------------------------------------------------------------------------------------------

describe("registry reference validation (H3)", () => {
  it.each([
    "ghcr.io/noodara/fixtures",
    "localhost:5000",
    "registry.example.com:443/a/b",
    "reg-1.example/a_b/c__d/e-f/g.h",
  ])("accepts %j", (value) => {
    expect(validateRegistryReference(value)).toEqual({
      ok: true,
      registry: value,
    });
  });

  it.each([undefined, ""])("treats %j as not configured", (value) => {
    expect(validateRegistryReference(value)).toEqual({
      ok: true,
      registry: null,
    });
  });

  it.each([
    ["URL scheme", "https://ghcr.io/noodara"],
    ["embedded credentials", `user:${CANARY}@ghcr.io/noodara`],
    ["leading whitespace", " ghcr.io/noodara"],
    ["inner whitespace", "ghcr.io/noo dara"],
    ["trailing newline", "ghcr.io/noodara\n"],
    ["semicolon", "ghcr.io/x;rm -rf /"],
    ["command substitution", "ghcr.io/$(id)"],
    ["backticks", "ghcr.io/`id`"],
    ["pipe", "ghcr.io/x|sh"],
    ["ampersand", "ghcr.io/x&&id"],
    ["redirect", "ghcr.io/x>out"],
    ["uppercase repository", "ghcr.io/Noodara"],
    ["leading dash (argument injection)", "-ghcr.io"],
    ["option-shaped value", "--help"],
    ["empty component", "ghcr.io//x"],
    ["trailing slash", "ghcr.io/x/"],
    ["tag or digest", "ghcr.io/x:latest/y"],
    ["over the length cap", `ghcr.io/${"a".repeat(200)}`],
  ])(
    "rejects a value with %s, naming the variable without echoing it",
    (_label, value) => {
      const result = validateRegistryReference(value);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.message).toBe(INVALID_REGISTRY_MESSAGE);
      expect(result.message).toContain(FIXTURE_REGISTRY_ENV);
      expect(result.message).not.toContain(value.trim());
    },
  );

  it("falls back to the build path for a rejected value, without pulling", async () => {
    const fake = createFakeDocker();
    const opts = options(fake, {
      registry: `https://user:${CANARY}@ghcr.io/x`,
    });
    await expect(resolveFixtureImage(opts)).resolves.toEqual({
      ref: opts.target,
      source: "build",
    });
    expect(fake.pulls).toEqual([]);
    expect(opts.build).toHaveBeenCalledTimes(1);
    expect(reports).toEqual([INVALID_REGISTRY_MESSAGE]);
    expectInvariants(fake, [opts.target]);
  });
});

// ----------------------------------------------------------------------------------------------
// A2 / H5: resolution order, pull verification and fallbacks
// ----------------------------------------------------------------------------------------------

describe("resolution order (A2, H5)", () => {
  it("reuses a verified local image without pulling or building", async () => {
    const fake = createFakeDocker();
    fake.images.set(HASH_REF, good("cached"));
    const opts = options(fake, { registry: REGISTRY });
    await expect(resolveFixtureImage(opts)).resolves.toEqual({
      ref: opts.target,
      source: "local",
    });
    expect(fake.images.get(opts.target)?.id).toBe("cached");
    expect(fake.pulls).toEqual([]);
    expect(opts.build).not.toHaveBeenCalled();
    expect(reports).toEqual([]);
    expectInvariants(fake, [opts.target]);
  });

  it.each([
    ["a mismatched label", good("stale", OTHER_IDENTITY)],
    ["no label", good("unlabelled", null)],
    ["another architecture", { ...good("arm"), architecture: "arm64" }],
    ["another OS", { ...good("win"), os: "windows" }],
  ])("never uses a local hash-tagged image with %s", async (_label, image) => {
    const fake = createFakeDocker();
    fake.images.set(HASH_REF, image);
    const opts = options(fake);
    await expect(resolveFixtureImage(opts)).resolves.toEqual({
      ref: opts.target,
      source: "build",
    });
    expect(opts.build).toHaveBeenCalledTimes(1);
    expect(fake.images.get(HASH_REF)?.id).toBe("built");
    expectInvariants(fake, [opts.target]);
  });

  it("builds when no registry is configured and reports that once per process", async () => {
    const fake = createFakeDocker();
    const first = options(fake);
    const second = options(fake, { identity: OTHER_IDENTITY });
    await expect(resolveFixtureImage(first)).resolves.toMatchObject({
      source: "build",
    });
    fake.images.delete(localFixtureRef(NAME, OTHER_IDENTITY));
    await expect(
      resolveFixtureImage({
        ...second,
        build: makeBuild(fake, second.target, good("b2", OTHER_IDENTITY)),
      }),
    ).resolves.toMatchObject({
      source: "build",
    });
    expect(fake.pulls).toEqual([]);
    expect(reports).toEqual([FIXTURE_FALLBACK_MESSAGES["not-configured"]]);
  });

  it("pulls a verified image with the scaled deadline, then publishes the hash tag", async () => {
    const fake = createFakeDocker();
    fake.pullImpl = (ref) => {
      fake.images.set(ref, good("pulled"));
      return Promise.resolve();
    };
    const opts = options(fake, { registry: REGISTRY, pullDeadlineMs: 4_321 });
    await expect(resolveFixtureImage(opts)).resolves.toEqual({
      ref: opts.target,
      source: "pull",
    });
    expect(fake.pulls).toEqual([{ ref: REMOTE_REF, timeoutMs: 4_321 }]);
    expect(opts.build).not.toHaveBeenCalled();
    expect(fake.images.has(REMOTE_REF)).toBe(false);
    expect(fake.images.get(opts.target)?.id).toBe("pulled");
    expect(fake.images.get(HASH_REF)?.id).toBe("pulled");
    // The hash tag is applied only after the pulled image was verified.
    const verifiedAt = fake.calls.lastIndexOf(`inspect ${opts.target}`);
    expect(
      fake.calls.indexOf(`tag ${opts.target} ${HASH_REF}`),
    ).toBeGreaterThan(verifiedAt);
    expect(reports).toEqual([]);
    expectInvariants(fake, [opts.target]);
  });

  it.each<[string, unknown, FallbackReason]>([
    [
      "unauthorised",
      { stderr: `Error response from daemon: unauthorized: ${CANARY}` },
      "unauthorized",
    ],
    [
      "denied",
      {
        stderr:
          "pull access denied, repository does not exist or may require docker login",
      },
      "unauthorized",
    ],
    [
      "unreachable",
      { stderr: `dial tcp: lookup ${CANARY}.example: no such host` },
      "unreachable",
    ],
    ["not published", { stderr: "manifest unknown" }, "not-found"],
    ["killed by its own timeout", { killed: true, stderr: CANARY }, "timeout"],
    ["an unknown failure", { stderr: CANARY }, "failed"],
  ])(
    "falls back to build when the pull is %s, with a fixed message",
    async (_label, failure, reason) => {
      const fake = createFakeDocker();
      fake.pullImpl = () =>
        Promise.reject(
          Object.assign(new Error(`docker pull failed: ${CANARY}`), failure),
        );
      const opts = options(fake, { registry: REGISTRY });
      await expect(resolveFixtureImage(opts)).resolves.toEqual({
        ref: opts.target,
        source: "build",
      });
      expect(classifyPullFailure(Object.assign(new Error("x"), failure))).toBe(
        reason,
      );
      expect(reports).toEqual([FIXTURE_FALLBACK_MESSAGES[reason]]);
      expect(JSON.stringify(reports)).not.toContain(CANARY);
      expect(fake.images.has(REMOTE_REF)).toBe(false);
      expect(fake.images.get(HASH_REF)?.id).toBe("built");
      expectInvariants(fake, [opts.target]);
    },
  );

  it("bounds the pull by its deadline even when the pull never settles on its own", async () => {
    const fake = createFakeDocker();
    fake.pullImpl = abortingPull();
    const opts = options(fake, { registry: REGISTRY, pullDeadlineMs: 30 });
    await expect(resolveFixtureImage(opts)).resolves.toEqual({
      ref: opts.target,
      source: "build",
    });
    expect(reports).toEqual([FIXTURE_FALLBACK_MESSAGES.timeout]);
    expectInvariants(fake, [opts.target]);
  });

  it.each<[string, FakeImage, FallbackReason]>([
    [
      "the identity label does not match",
      good("evil", OTHER_IDENTITY),
      "label-mismatch",
    ],
    ["the identity label is missing", good("evil", null), "label-mismatch"],
    [
      "the architecture differs from the daemon",
      { ...good("evil"), architecture: "arm64" },
      "platform-mismatch",
    ],
    [
      "the OS differs from the daemon",
      { ...good("evil"), os: "windows" },
      "platform-mismatch",
    ],
  ])(
    "removes a pulled image when %s and builds instead",
    async (_label, pulled, reason) => {
      const fake = createFakeDocker();
      fake.pullImpl = (ref) => {
        fake.images.set(ref, pulled);
        return Promise.resolve();
      };
      const opts = options(fake, { registry: REGISTRY });
      await expect(resolveFixtureImage(opts)).resolves.toEqual({
        ref: opts.target,
        source: "build",
      });
      expect(fake.removed).toEqual(
        expect.arrayContaining([REMOTE_REF, opts.target]),
      );
      expect(fake.images.has(REMOTE_REF)).toBe(false);
      expect(fake.images.get(opts.target)?.id).toBe("built");
      expect(fake.images.get(HASH_REF)?.id).toBe("built");
      expect(reports).toEqual([FIXTURE_FALLBACK_MESSAGES[reason]]);
      expectInvariants(fake, [opts.target]);
    },
  );

  it("never accepts a pulled image when the daemon platform is unknown", async () => {
    const fake = createFakeDocker();
    fake.platform = null;
    fake.pullImpl = (ref) => {
      fake.images.set(ref, good("pulled"));
      return Promise.resolve();
    };
    const opts = options(fake, { registry: REGISTRY });
    await expect(resolveFixtureImage(opts)).resolves.toMatchObject({
      source: "build",
    });
    expect(fake.images.has(HASH_REF)).toBe(false);
  });

  it("re-checks the local cache before building (another process won the race)", async () => {
    const fake = createFakeDocker();
    let hashInspections = 0;
    fake.onInspect = (ref) => {
      if (ref === HASH_REF && ++hashInspections === 2)
        fake.images.set(HASH_REF, good("other-process"));
    };
    const opts = options(fake, { registry: REGISTRY });
    await expect(resolveFixtureImage(opts)).resolves.toEqual({
      ref: opts.target,
      source: "local",
    });
    expect(opts.build).not.toHaveBeenCalled();
    expect(fake.images.get(opts.target)?.id).toBe("other-process");
    expectInvariants(fake, [opts.target]);
  });

  it("does not overwrite a verified hash tag published by another process", async () => {
    const fake = createFakeDocker();
    const opts = options(fake, { mode: "build" });
    fake.onInspect = (ref) => {
      if (ref === opts.target && !fake.images.has(HASH_REF))
        fake.images.set(HASH_REF, good("other-process"));
    };
    await expect(resolveFixtureImage(opts)).resolves.toMatchObject({
      source: "build",
    });
    expect(fake.tagTargets).not.toContain(HASH_REF);
    expect(fake.images.get(HASH_REF)?.id).toBe("other-process");
    expectInvariants(fake, [opts.target]);
  });

  it("build mode starts the build synchronously, before any Docker call, and ignores the registry", async () => {
    const fake = createFakeDocker();
    fake.images.set(HASH_REF, good("cached"));
    fake.pullImpl = () => Promise.reject(new Error("must not pull"));
    const opts = options(fake, { mode: "build", registry: REGISTRY });
    const pending = resolveFixtureImage(opts);
    expect(opts.build).toHaveBeenCalledTimes(1);
    expect(fake.calls).toEqual([]);
    await expect(pending).resolves.toEqual({
      ref: opts.target,
      source: "build",
    });
    expect(fake.pulls).toEqual([]);
    expect(reports).toEqual([]);
  });

  it("a failed build rejects with its error and never tags the content hash", async () => {
    const fake = createFakeDocker();
    const failure = new Error("build failed");
    for (const mode of ["build", "reuse"] as const) {
      const opts = options(fake, {
        mode,
        build: vi.fn(() => Promise.reject(failure)),
      });
      await expect(resolveFixtureImage(opts)).rejects.toBe(failure);
    }
    expect(fake.images.has(HASH_REF)).toBe(false);
    expect(fake.tagTargets).toEqual([]);
  });

  it("returns an unlabelled build but never caches it under the content hash", async () => {
    const fake = createFakeDocker();
    const target = fixtureOwnerTag(NAME);
    const opts = options(fake, {
      target,
      build: makeBuild(fake, target, good("built", null)),
    });
    await expect(resolveFixtureImage(opts)).resolves.toEqual({
      ref: target,
      source: "build",
    });
    expect(fake.images.has(HASH_REF)).toBe(false);
  });

  it.each([
    ["a target equal to the cache tag", { target: HASH_REF }, /target/],
    ["a target with a leading dash", { target: "-noodara-test/x:y" }, /target/],
    ["an uppercase name", { name: "Sshd" }, /name/],
    ["a non-hash identity", { identity: "latest" }, /identity/],
  ])("rejects %s before touching Docker", async (_label, override, message) => {
    const fake = createFakeDocker();
    await expect(resolveFixtureImage(options(fake, override))).rejects.toThrow(
      message,
    );
    expect(fake.calls).toEqual([]);
  });
});

// ----------------------------------------------------------------------------------------------
// A2: the pull budget leaves room for the build fallback; failed pulls are not retried
// ----------------------------------------------------------------------------------------------

describe("pull budget and failed-pull memory (A2)", () => {
  it("the pull budget is strictly less than half the integration test budget at every scale", async () => {
    const config = await readFile(
      path.join(repoRoot, "vitest.integration.config.ts"),
      "utf8",
    );
    expect(config).toContain(
      "testTimeout: timeouts.scaled(RUNNER_TIMEOUT_DEFAULTS.integration.testTimeout)",
    );
    const testBudget = RUNNER_TIMEOUT_DEFAULTS.integration.testTimeout;
    expect(FIXTURE_IMAGE_PULL_BUDGET_MS).toBeGreaterThan(0);
    expect(FIXTURE_IMAGE_PULL_BUDGET_MS * 2).toBeLessThan(testBudget);
    for (let factor = TIMEOUT_SCALE_MIN; factor <= TIMEOUT_SCALE_MAX; factor += 0.5) {
      expect(scaleTimeout(FIXTURE_IMAGE_PULL_BUDGET_MS, factor) * 2).toBeLessThan(
        scaleTimeout(testBudget, factor),
      );
    }
  });

  it("a failed pull is not retried in-process: the next resolution goes straight to local/build", async () => {
    const fake = createFakeDocker();
    const firstTarget = fixtureOwnerTag(NAME);
    const first = await resolveFixtureImage(
      options(fake, { registry: REGISTRY, target: firstTarget }),
    );
    expect(first.source).toBe("build");
    expect(fake.pulls).toHaveLength(1);
    // Simulate a later caller that finds no local cache (e.g. it was removed meanwhile).
    fake.images.delete(HASH_REF);
    const secondTarget = fixtureOwnerTag(NAME);
    const second = options(fake, { registry: REGISTRY, target: secondTarget });
    await expect(resolveFixtureImage(second)).resolves.toEqual({
      ref: secondTarget,
      source: "build",
    });
    expect(fake.pulls).toHaveLength(1);
    expect(second.build).toHaveBeenCalledTimes(1);
    expect(fake.images.get(HASH_REF)?.label).toBe(IDENTITY);
    expect(reports).toEqual([FIXTURE_FALLBACK_MESSAGES["not-found"]]);
    // A third caller reuses the hash tag the fallback build published.
    const third = options(fake, { registry: REGISTRY });
    await expect(resolveFixtureImage(third)).resolves.toMatchObject({
      source: "local",
    });
    expect(fake.pulls).toHaveLength(1);
    expectInvariants(fake, [firstTarget, secondTarget, third.target]);
  });

  it("a timed-out pull is not retried in-process and the timeout is reported once", async () => {
    const fake = createFakeDocker();
    fake.pullImpl = abortingPull();
    const first = options(fake, { registry: REGISTRY, pullDeadlineMs: 20 });
    await expect(resolveFixtureImage(first)).resolves.toMatchObject({
      source: "build",
    });
    fake.images.delete(HASH_REF);
    const second = options(fake, { registry: REGISTRY, pullDeadlineMs: 20 });
    await expect(resolveFixtureImage(second)).resolves.toMatchObject({
      source: "build",
    });
    expect(fake.pulls).toHaveLength(1);
    expect(reports).toEqual([FIXTURE_FALLBACK_MESSAGES.timeout]);
  });

  it("a pulled image with the wrong label is not pulled again in-process", async () => {
    const fake = createFakeDocker();
    fake.pullImpl = (ref) => {
      fake.images.set(ref, good("foreign", OTHER_IDENTITY));
      return Promise.resolve();
    };
    await resolveFixtureImage(options(fake, { registry: REGISTRY }));
    fake.images.delete(HASH_REF);
    await expect(
      resolveFixtureImage(options(fake, { registry: REGISTRY })),
    ).resolves.toMatchObject({ source: "build" });
    expect(fake.pulls).toHaveLength(1);
    expect(reports).toEqual([FIXTURE_FALLBACK_MESSAGES["label-mismatch"]]);
  });

  it("the memory is keyed by registry, name and identity", async () => {
    const fake = createFakeDocker();
    await resolveFixtureImage(options(fake, { registry: REGISTRY }));
    fake.images.clear();
    await resolveFixtureImage(
      options(fake, { registry: "ghcr.io/other/fixtures" }),
    );
    fake.images.clear();
    await resolveFixtureImage(
      options(fake, { registry: REGISTRY, identity: OTHER_IDENTITY }),
    );
    expect(fake.pulls.map((pull) => pull.ref)).toEqual([
      REMOTE_REF,
      remoteFixtureRef("ghcr.io/other/fixtures", NAME, IDENTITY),
      remoteFixtureRef(REGISTRY, NAME, OTHER_IDENTITY),
    ]);
  });

  it("a pull aborted by the caller is not remembered as a failure", async () => {
    const fake = createFakeDocker();
    fake.pullImpl = abortingPull();
    const controller = new AbortController();
    const pending = resolveFixtureImage(
      options(fake, { registry: REGISTRY, signal: controller.signal }),
    );
    await vi.waitFor(() => expect(fake.pulls).toHaveLength(1));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    fake.pullImpl = (ref) => {
      fake.images.set(ref, good("pulled"));
      return Promise.resolve();
    };
    await expect(
      resolveFixtureImage(options(fake, { registry: REGISTRY })),
    ).resolves.toMatchObject({ source: "pull" });
    expect(fake.pulls).toHaveLength(2);
  });

  it("resetFixtureImageState forgets failed pulls", async () => {
    const fake = createFakeDocker();
    await resolveFixtureImage(options(fake, { registry: REGISTRY }));
    fake.images.clear();
    resetFixtureImageState();
    await resolveFixtureImage(options(fake, { registry: REGISTRY }));
    expect(fake.pulls).toHaveLength(2);
  });
});

// ----------------------------------------------------------------------------------------------
// A3 / H5: cancellation
// ----------------------------------------------------------------------------------------------

describe("cancellation (A3, H5)", () => {
  it("aborting during a pull returns no handle and leaves no tagged image", async () => {
    const fake = createFakeDocker();
    const started = deferred();
    fake.pullImpl = abortingPull(started.resolve);
    const controller = new AbortController();
    const opts = options(fake, {
      registry: REGISTRY,
      signal: controller.signal,
    });
    const pending = resolveFixtureImage(opts);
    await started.promise;
    const reason = new Error("test cancelled");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(opts.build).not.toHaveBeenCalled();
    for (const ref of [opts.target, REMOTE_REF, HASH_REF])
      expect(fake.images.has(ref)).toBe(false);
    expect(reports).toEqual([]);
  });

  it("reaps a pull that completes after the abort and its settle grace", async () => {
    const fake = createFakeDocker();
    const started = deferred();
    const release = deferred();
    fake.pullImpl = async (ref) => {
      started.resolve();
      await release.promise;
      fake.images.set(ref, good("late"));
    };
    const controller = new AbortController();
    const opts = options(fake, {
      registry: REGISTRY,
      signal: controller.signal,
      pullSettleGraceMs: 5,
    });
    const pending = resolveFixtureImage(opts);
    await started.promise;
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    release.resolve();
    await vi.waitFor(() => expect(fake.removed).toContain(REMOTE_REF));
    for (const ref of [opts.target, REMOTE_REF, HASH_REF])
      expect(fake.images.has(ref)).toBe(false);
  });

  it.each(["build", "reuse"] as const)(
    "an aborted %s-mode build never tags the content hash, even when it completes late",
    async (mode) => {
      const fake = createFakeDocker();
      const release = deferred();
      const target = fixtureOwnerTag(NAME);
      const build = makeBuild(
        fake,
        target,
        good("late-build"),
        release.promise,
      );
      const controller = new AbortController();
      const pending = resolveFixtureImage(
        options(fake, { mode, target, build, signal: controller.signal }),
      );
      await vi.waitFor(() => expect(build).toHaveBeenCalledTimes(1));
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: "AbortError" });
      release.resolve();
      await tick();
      expect(fake.images.has(HASH_REF)).toBe(false);
      expect(fake.tagTargets).not.toContain(HASH_REF);
    },
  );

  it.each(["build", "reuse"] as const)(
    "aborting while the %s-mode build is verified never tags the content hash",
    async (mode) => {
      const fake = createFakeDocker();
      const controller = new AbortController();
      const opts = options(fake, { mode, signal: controller.signal });
      fake.onInspect = (ref) => {
        if (ref === opts.target && fake.images.has(opts.target))
          controller.abort();
      };
      await expect(resolveFixtureImage(opts)).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(fake.images.has(HASH_REF)).toBe(false);
      expect(fake.tagTargets).not.toContain(HASH_REF);
    },
  );

  it("aborting while a pulled image is verified removes it and returns no handle", async () => {
    const fake = createFakeDocker();
    fake.pullImpl = (ref) => {
      fake.images.set(ref, good("pulled"));
      return Promise.resolve();
    };
    const controller = new AbortController();
    const opts = options(fake, {
      registry: REGISTRY,
      signal: controller.signal,
    });
    fake.onInspect = (ref) => {
      if (ref === opts.target) controller.abort();
    };
    await expect(resolveFixtureImage(opts)).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(opts.build).not.toHaveBeenCalled();
    for (const ref of [opts.target, REMOTE_REF, HASH_REF])
      expect(fake.images.has(ref)).toBe(false);
  });

  it("an already aborted signal rejects before any Docker call or build", async () => {
    const fake = createFakeDocker();
    for (const mode of ["build", "reuse"] as const) {
      const opts = options(fake, {
        mode,
        registry: REGISTRY,
        signal: AbortSignal.abort(),
      });
      await expect(resolveFixtureImage(opts)).rejects.toMatchObject({
        name: "AbortError",
      });
      expect(opts.build).not.toHaveBeenCalled();
    }
    expect(fake.calls).toEqual([]);
  });
});

// ----------------------------------------------------------------------------------------------
// H6: single-flight and cross-process idempotence
// ----------------------------------------------------------------------------------------------

describe("concurrent resolution of one identity (H6)", () => {
  it("performs at most one pull/build in-process; the waiter reuses the verified image", async () => {
    const fake = createFakeDocker();
    let pulls = 0;
    fake.pullImpl = (ref) => {
      pulls += 1;
      fake.images.set(ref, good("pulled"));
      return Promise.resolve();
    };
    const first = options(fake, { registry: REGISTRY });
    const second = options(fake, { registry: REGISTRY });
    const results = await Promise.all([
      resolveFixtureImage(first),
      resolveFixtureImage(second),
    ]);
    expect(results.map((result) => result.source).sort()).toEqual([
      "local",
      "pull",
    ]);
    expect(pulls).toBe(1);
    expect(first.build).not.toHaveBeenCalled();
    expect(second.build).not.toHaveBeenCalled();
    expect(
      fake.images.has(first.target) && fake.images.has(second.target),
    ).toBe(true);
    expectInvariants(fake, [first.target, second.target]);
  });

  it("builds once for concurrent callers when nothing can be pulled", async () => {
    const fake = createFakeDocker();
    const release = deferred();
    const firstTarget = fixtureOwnerTag(NAME);
    const first = options(fake, {
      target: firstTarget,
      build: makeBuild(fake, firstTarget, good("built"), release.promise),
    });
    const second = options(fake);
    const pendingFirst = resolveFixtureImage(first);
    await vi.waitFor(() => expect(first.build).toHaveBeenCalledTimes(1));
    const pendingSecond = resolveFixtureImage(second);
    await tick(5);
    release.resolve();
    await expect(pendingFirst).resolves.toMatchObject({ source: "build" });
    await expect(pendingSecond).resolves.toEqual({
      ref: second.target,
      source: "local",
    });
    expect(second.build).not.toHaveBeenCalled();
    expectInvariants(fake, [first.target, second.target]);
  });

  it("a waiter takes over when the initiator is aborted", async () => {
    const fake = createFakeDocker();
    const firstTarget = fixtureOwnerTag(NAME);
    const controller = new AbortController();
    const first = options(fake, {
      target: firstTarget,
      signal: controller.signal,
      build: makeBuild(
        fake,
        firstTarget,
        good("never"),
        new Promise<void>(() => undefined),
      ),
    });
    const second = options(fake);
    const pendingFirst = resolveFixtureImage(first);
    await vi.waitFor(() => expect(first.build).toHaveBeenCalledTimes(1));
    const pendingSecond = resolveFixtureImage(second);
    await tick(5);
    expect(second.build).not.toHaveBeenCalled();
    controller.abort();
    await expect(pendingFirst).rejects.toMatchObject({ name: "AbortError" });
    await expect(pendingSecond).resolves.toEqual({
      ref: second.target,
      source: "build",
    });
    expect(second.build).toHaveBeenCalledTimes(1);
    expect(fake.images.get(HASH_REF)?.id).toBe("built");
    expectInvariants(fake, [first.target, second.target]);
  });

  it("never runs two builds of one identity at once, however many rounds a waiter waits", async () => {
    const fake = createFakeDocker();
    let active = 0;
    let maxActive = 0;
    const failingBuild = () =>
      vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await tick(5);
        active -= 1;
        throw new Error("build failed");
      });
    const callers = Array.from({ length: 6 }, () =>
      options(fake, { build: failingBuild() }),
    );
    const results = await Promise.allSettled(
      callers.map((caller) => resolveFixtureImage(caller)),
    );
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(maxActive).toBe(1);
    for (const caller of callers) expect(caller.build).toHaveBeenCalledTimes(1);
  });

  it("an aborted waiter leaves the initiator untouched", async () => {
    const fake = createFakeDocker();
    const release = deferred();
    const firstTarget = fixtureOwnerTag(NAME);
    const first = options(fake, {
      target: firstTarget,
      build: makeBuild(fake, firstTarget, good("built"), release.promise),
    });
    const controller = new AbortController();
    const second = options(fake, { signal: controller.signal });
    const pendingFirst = resolveFixtureImage(first);
    await vi.waitFor(() => expect(first.build).toHaveBeenCalledTimes(1));
    const pendingSecond = resolveFixtureImage(second);
    await tick(5);
    controller.abort();
    await expect(pendingSecond).rejects.toMatchObject({ name: "AbortError" });
    release.resolve();
    await expect(pendingFirst).resolves.toEqual({
      ref: firstTarget,
      source: "build",
    });
    expect(fake.images.has(second.target)).toBe(false);
    expectInvariants(fake, [first.target, second.target]);
  });
});

// ----------------------------------------------------------------------------------------------
// H4: no credential handling or leakage
// ----------------------------------------------------------------------------------------------

describe("credential hygiene (H4)", () => {
  it("never surfaces a credential-shaped registry or pull stderr in output or thrown errors", async () => {
    const written: string[] = [];
    const stderr = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk: string | Uint8Array) => {
        written.push(String(chunk));
        return true;
      });
    const consoleSpies = (
      ["log", "info", "warn", "error", "debug"] as const
    ).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        written.push(args.map(String).join(" "));
      }),
    );
    try {
      const thrown: unknown[] = [];
      const fake = createFakeDocker();
      fake.pullImpl = () =>
        Promise.reject(
          Object.assign(new Error(`Command failed: docker pull ${CANARY}`), {
            stderr: `unauthorized: ${CANARY}`,
          }),
        );
      // Default sink (process.stderr), credential in the registry value, then in pull stderr.
      for (const registry of [
        `user:${CANARY}@ghcr.io/x`,
        `ghcr.io/${CANARY.toLowerCase().replaceAll("_", "-")}`,
      ]) {
        const { report: _ignored, ...rest } = options(fake, { registry });
        await resolveFixtureImage(rest).catch((error: unknown) =>
          thrown.push(error),
        );
        fake.images.clear();
      }
      // Aborted pull: the thrown value is the caller's own reason, never the pull error.
      const controller = new AbortController();
      fake.pullImpl = (_ref, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(Object.assign(new Error(CANARY), { stderr: CANARY })),
            { once: true },
          );
          controller.abort();
        });
      await resolveFixtureImage(
        options(fake, { registry: REGISTRY, signal: controller.signal }),
      ).catch((error: unknown) => thrown.push(error));

      const surfaced = [
        ...written,
        ...reports,
        ...thrown.map((error) =>
          error instanceof Error
            ? `${error.message} ${error.stack ?? ""}`
            : String(error),
        ),
      ].join("\n");
      expect(written.length).toBeGreaterThan(0);
      expect(surfaced).not.toContain(CANARY);
      expect(surfaced.toLowerCase()).not.toContain(CANARY.toLowerCase());
    } finally {
      stderr.mockRestore();
      for (const spy of consoleSpies) spy.mockRestore();
    }
  });

  it("the CLI facade passes refs as separate arguments and never logs in", async () => {
    const runs: {
      args: readonly string[];
      timeoutMs: number;
      signal: AbortSignal | undefined;
    }[] = [];
    const facade = createDockerCliFacade(async (args, opts) => {
      runs.push({ args, timeoutMs: opts.timeoutMs, signal: opts.signal });
      if (args[0] === "version") return "linux/amd64\n";
      if (args[1] === "inspect")
        return `{"os":"linux","architecture":"amd64","labels":{"noodara.test.fixture-identity":"${IDENTITY}"}}\n`;
      return "";
    }, 777);
    const signal = new AbortController().signal;
    await facade.pull(REMOTE_REF, { timeoutMs: 1_234, signal });
    await facade.tag(REMOTE_REF, HASH_REF);
    await facade.removeImage(REMOTE_REF);
    expect(await facade.inspectImage(HASH_REF)).toEqual({
      label: IDENTITY,
      os: "linux",
      architecture: "amd64",
    });
    expect(await facade.daemonPlatform()).toEqual({
      os: "linux",
      architecture: "amd64",
    });

    expect(runs[0]).toEqual({
      args: ["pull", "--quiet", "--", REMOTE_REF],
      timeoutMs: 1_234,
      signal,
    });
    expect(runs[1]?.args).toEqual(["image", "tag", "--", REMOTE_REF, HASH_REF]);
    expect(runs[2]?.args.at(-1)).toBe(REMOTE_REF);
    expect(runs[2]?.args.slice(0, 2)).toEqual(["image", "rm"]);
    for (const run of runs) {
      expect(run.args).not.toContain("login");
      expect(run.timeoutMs).toBeGreaterThan(0);
    }
  });

  it.each([
    ["empty output means absent", async () => ""],
    [
      "a failing inspect means absent",
      async () => Promise.reject(new Error(CANARY)),
    ],
    ["unparseable output means absent", async () => "not json"],
  ])("the CLI facade inspect: %s", async (_label, run) => {
    const facade = createDockerCliFacade(run);
    expect(await facade.inspectImage(HASH_REF)).toBeNull();
    expect(await facade.daemonPlatform()).toBeNull();
  });

  it("the module never logs in nor touches Docker config or credential files", async () => {
    const source = await readFile(MODULE_PATH, "utf8");
    expect(source).not.toMatch(
      /['"]login['"]|config\.json|DOCKER_CONFIG|\.docker[\\/]|credHelpers|credsStore/,
    );
    expect(source).not.toMatch(/shell:\s*true|\bexec\(|execSync|spawnSync/);
  });
});

// ----------------------------------------------------------------------------------------------
// H7 (module part): temporary names come from crypto.randomUUID
// ----------------------------------------------------------------------------------------------

describe("owner tags (H7)", () => {
  it("derives owner tags from a crypto.randomUUID ownership id", () => {
    const uuid =
      /^noodara-test\/sshd-ubuntu-24\.04:owner-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const tags = new Set(
      Array.from({ length: 16 }, () => fixtureOwnerTag(NAME)),
    );
    expect(tags.size).toBe(16);
    for (const tag of tags) expect(tag).toMatch(uuid);
  });

  it("creates no tag besides the caller-owned target and the content-hash tag", async () => {
    const fake = createFakeDocker();
    fake.pullImpl = (ref) => {
      fake.images.set(ref, good("pulled"));
      return Promise.resolve();
    };
    const opts = options(fake, { registry: REGISTRY });
    await resolveFixtureImage(opts);
    expect(new Set(fake.tagTargets)).toEqual(new Set([opts.target, HASH_REF]));
  });
});
