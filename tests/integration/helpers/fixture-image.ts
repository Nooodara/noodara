// 36-04: content-addressed fixture images (identity, registry validation, resolution).
//
// Constraints that shape this file:
// - Node builtins only and erasable TypeScript (no enums, namespaces or parameter properties), so
//   a plain `.mjs` script can import it under Node 24 type stripping and compute the very same
//   identity the tests compute (one shared implementation, H8).
// - Docker is reached only through the injected `FixtureDockerFacade`. The CLI facade below runs
//   `docker` with an argument array (execFile, no shell) and only ever calls `image inspect`,
//   `version`, `pull`, `image tag` and `image rm`. It never logs in and never reads Docker
//   configuration or credential files (H4).
// - Every fallback is reported with a fixed message, once per process. Docker stderr and the
//   registry value are never echoed (H3, H4).
import {
  execFile,
  execFileSync,
  type ExecFileOptionsWithStringEncoding,
} from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Resolved per call, never at import: unit tests that mock node:child_process with a subset of
// its exports (35-04 ssh-stage-events) still import the SSH helper that imports this module.
function execFileAsync(
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithStringEncoding,
): Promise<{ stdout: string; stderr: string }> {
  return promisify(execFile)(file, args, options);
}

/** Version of the identity framing. Bump it when the framing below changes. */
export const FIXTURE_IMAGE_SCHEME = "noodara-fixture-image/v1";
/** Image label carrying the identity; the Dockerfiles set it from the build arg below. */
export const FIXTURE_IDENTITY_LABEL = "noodara.test.fixture-identity";
/** Build arg the caller passes with the identity. It is excluded from the hashed arguments. */
export const FIXTURE_IDENTITY_BUILD_ARG = "NOODARA_FIXTURE_IDENTITY";
/** Opt-in registry for pre-built fixture images. Unset or empty means "never pull". */
export const FIXTURE_REGISTRY_ENV = "NOODARA_TEST_FIXTURE_REGISTRY";
/** Local repository prefix for fixture images (cache and owner tags). */
export const FIXTURE_LOCAL_REPOSITORY_PREFIX = "noodara-test";
/** Unscaled pull budget; callers pass it through their runner timeout scale. */
export const FIXTURE_IMAGE_PULL_BUDGET_MS = 180_000;
/** Bound for each metadata call (inspect, version, tag, rm) of the CLI facade. */
export const DOCKER_METADATA_TIMEOUT_MS = 30_000;
/** Bound for `git ls-files` when executable bits come from the index (Windows checkouts). */
export const GIT_LS_FILES_TIMEOUT_MS = 15_000;
/** How long an aborted or timed-out pull may take to settle before its reaping goes async. */
export const PULL_SETTLE_GRACE_MS = 5_000;
/** Length cap for NOODARA_TEST_FIXTURE_REGISTRY. */
export const FIXTURE_REGISTRY_MAX_LENGTH = 200;

const MAX_SINGLE_FLIGHT_WAITS = 3;
const IDENTITY_PATTERN = /^[0-9a-f]{64}$/;
const NAME_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const TARGET_PATTERN =
  /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$/;
const REGISTRY_COMPONENT = "[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*";
const REGISTRY_HOST =
  "[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*(?::[0-9]{1,5})?";
const REGISTRY_PATTERN = new RegExp(
  `^${REGISTRY_HOST}(?:/${REGISTRY_COMPONENT})*$`,
);
const TEXT_EXTENSIONS = new Set([
  ".sh",
  ".conf",
  ".md",
  ".txt",
  ".yml",
  ".yaml",
  ".json",
]);

// ---------------------------------------------------------------------------------------------
// Step 1: identity
// ---------------------------------------------------------------------------------------------

/** One regular file of a build context, path relative to the context root in POSIX form. */
export interface ContextEntry {
  readonly path: string;
  readonly executable: boolean;
  readonly content: Buffer;
}

export interface FixtureIdentityInput {
  /** Dockerfile path relative to the context root. */
  readonly dockerfile: string;
  readonly buildArgs: Readonly<Record<string, string>>;
  readonly entries: readonly ContextEntry[];
}

/** Files whose CRLF line endings are normalised to LF before hashing. Never binary files. */
export function isDeclaredTextFile(relativePath: string): boolean {
  const base = path.posix.basename(relativePath);
  if (
    base === "Dockerfile" ||
    base.startsWith("Dockerfile.") ||
    base.endsWith(".Dockerfile")
  )
    return true;
  if (base === ".dockerignore") return true;
  return TEXT_EXTENSIONS.has(path.posix.extname(base).toLowerCase());
}

function normaliseContent(relativePath: string, content: Buffer): Buffer {
  if (!isDeclaredTextFile(relativePath) || !content.includes("\r\n"))
    return content;
  return Buffer.from(
    content.toString("latin1").replaceAll("\r\n", "\n"),
    "latin1",
  );
}

/** POSIX path of `target` relative to `root`. Throws when it escapes the root. */
export function toContextRelativePath(root: string, target: string): string {
  const relative = path.relative(
    path.resolve(root),
    path.resolve(root, target),
  );
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Fixture build context path escapes the context root.");
  }
  return relative.split(path.sep).join("/");
}

function assertPosixRelative(value: string): void {
  if (
    value === "" ||
    value.includes("\\") ||
    value.includes("\0") ||
    value.startsWith("/") ||
    value
      .split("/")
      .some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error(
      "Fixture build context entry has an invalid relative path.",
    );
  }
}

function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * SHA-256 (hex) over an unambiguous framing: every field is preceded by its byte length as a
 * big-endian u64, sections carry their element counts, arguments are sorted by key and entries
 * by path (byte order). Declared text files are hashed with LF line endings.
 */
export function hashFixtureIdentity(input: FixtureIdentityInput): string {
  assertPosixRelative(input.dockerfile);
  const hash = createHash("sha256");
  const field = (value: string | Buffer): void => {
    const bytes =
      typeof value === "string" ? Buffer.from(value, "utf8") : value;
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  };
  field(FIXTURE_IMAGE_SCHEME);
  field(input.dockerfile);
  const args = Object.entries(input.buildArgs)
    .filter(([key]) => key !== FIXTURE_IDENTITY_BUILD_ARG)
    .sort(([a], [b]) => compareBytes(a, b));
  field(String(args.length));
  for (const [key, value] of args) {
    field(key);
    field(value);
  }
  const entries = [...input.entries].sort((a, b) =>
    compareBytes(a.path, b.path),
  );
  field(String(entries.length));
  let previous: string | undefined;
  for (const entry of entries) {
    assertPosixRelative(entry.path);
    if (entry.path === previous)
      throw new Error("Fixture build context lists the same path twice.");
    previous = entry.path;
    field(entry.path);
    field(entry.executable ? "1" : "0");
    field(normaliseContent(entry.path, entry.content));
  }
  return hash.digest("hex");
}

// .dockerignore (subset of moby/patternmatcher: comments, `!`, `*`, `?`, `**`, last match wins,
// a pattern also matches every descendant of a matched directory). Anything outside the subset
// throws, so the hash can never silently disagree with what `docker build` sends.

export interface DockerignoreRule {
  readonly negate: boolean;
  readonly pattern: RegExp;
}

function compileDockerignorePattern(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern.charAt(index);
    if (char === "*") {
      if (pattern.charAt(index + 1) === "*") {
        index += 1;
        if (pattern.charAt(index + 1) === "/") index += 1;
        source += index + 1 >= pattern.length ? ".*" : "(?:.*/)?";
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else if (char === "[" || char === "\\") {
      throw new Error(
        "Unsupported .dockerignore syntax in the fixture build context.",
      );
    } else {
      source += char.replace(/[.+^${}()|\]]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

export function parseDockerignore(text: string): DockerignoreRule[] {
  const rules: DockerignoreRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1).trim();
    let cleaned = path.posix.normalize(line).replace(/\/+$/, "");
    if (cleaned.length > 1 && cleaned.startsWith("/"))
      cleaned = cleaned.slice(1);
    if (cleaned === "" || cleaned === ".") continue;
    rules.push({ negate, pattern: compileDockerignorePattern(cleaned) });
  }
  return rules;
}

export function isDockerignored(
  rules: readonly DockerignoreRule[],
  relativePath: string,
): boolean {
  const segments = relativePath.split("/");
  const candidates = segments.map((_, index) =>
    segments.slice(0, index + 1).join("/"),
  );
  let excluded = false;
  for (const rule of rules) {
    if (candidates.some((candidate) => rule.pattern.test(candidate)))
      excluded = !rule.negate;
  }
  return excluded;
}

/** Parses `git ls-files -s -z` output into path -> executable bit. */
export function parseGitLsFilesStage(output: string): Map<string, boolean> {
  const bits = new Map<string, boolean>();
  for (const record of output.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab <= 0) continue;
    const mode = record.slice(0, record.indexOf(" "));
    bits.set(record.slice(tab + 1), mode === "100755");
  }
  return bits;
}

const GIT_LS_FILES_ARGS = ["ls-files", "-s", "-z", "--", "."] as const;

function gitLsFilesOptions(contextDir: string): ExecFileOptionsWithStringEncoding {
  return {
    cwd: contextDir,
    timeout: GIT_LS_FILES_TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
    windowsHide: true,
  };
}

/** Executable bits from the git index, for checkouts whose file modes carry no exec bit. */
export async function readGitExecutableBits(
  contextDir: string,
): Promise<ReadonlyMap<string, boolean>> {
  const { stdout } = await execFileAsync(
    "git",
    GIT_LS_FILES_ARGS,
    gitLsFilesOptions(contextDir),
  );
  return parseGitLsFilesStage(stdout);
}

/** Synchronous twin of readGitExecutableBits (same argv, timeout and parser). */
export function readGitExecutableBitsSync(
  contextDir: string,
): ReadonlyMap<string, boolean> {
  return parseGitLsFilesStage(
    execFileSync("git", GIT_LS_FILES_ARGS, {
      ...gitLsFilesOptions(contextDir),
      encoding: "utf8",
    }),
  );
}

export interface EnumerateContextOptions {
  /** Defaults to process.platform. On win32 executable bits come from the git index. */
  readonly platform?: NodeJS.Platform | undefined;
  readonly gitExecutableBits?:
    ((contextDir: string) => Promise<ReadonlyMap<string, boolean>>) | undefined;
  /** Always included even when .dockerignore excludes it (docker build does the same). */
  readonly dockerfile?: string | undefined;
}

interface FoundFile {
  readonly relative: string;
  readonly absolute: string;
  readonly mode: number;
}

// One walk and one selection shared by the async and the sync entry points, so the identity a
// script computes (async) and the one the SSH helper computes (sync, see startSshd) never drift.
function walkContext(root: string): FoundFile[] {
  const found: FoundFile[] = [];
  const walk = (directory: string): void => {
    for (const child of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, child.name);
      const relative = toContextRelativePath(root, absolute);
      if (child.isSymbolicLink())
        throw new Error(
          `Fixture build context contains a symlink: ${relative}`,
        );
      if (child.isDirectory()) {
        walk(absolute);
      } else if (child.isFile()) {
        found.push({ relative, absolute, mode: lstatSync(absolute).mode });
      } else {
        throw new Error(
          `Fixture build context contains a special file: ${relative}`,
        );
      }
    }
  };
  walk(root);
  return found;
}

function selectContextEntries(
  root: string,
  found: readonly FoundFile[],
  dockerfileOption: string | undefined,
  gitBits: ReadonlyMap<string, boolean> | undefined,
): ContextEntry[] {
  const ignoreFile = found.find((file) => file.relative === ".dockerignore");
  const rules = ignoreFile
    ? parseDockerignore(readFileSync(ignoreFile.absolute, "utf8"))
    : [];
  const keep = new Set<string>([".dockerignore"]);
  if (dockerfileOption !== undefined)
    keep.add(toContextRelativePath(root, dockerfileOption));

  const entries: ContextEntry[] = [];
  for (const file of found) {
    if (!keep.has(file.relative) && isDockerignored(rules, file.relative))
      continue;
    const executable = gitBits
      ? gitBits.get(file.relative) === true
      : (file.mode & 0o100) !== 0;
    entries.push({
      path: file.relative,
      executable,
      content: readFileSync(file.absolute),
    });
  }
  return entries;
}

/** Regular files of the context, minus .dockerignore exclusions. Symlinks and special files throw. */
export async function enumerateContext(
  contextDir: string,
  options: EnumerateContextOptions = {},
): Promise<ContextEntry[]> {
  const root = path.resolve(contextDir);
  const found = walkContext(root);
  const platform = options.platform ?? process.platform;
  const gitBits =
    platform === "win32"
      ? await (options.gitExecutableBits ?? readGitExecutableBits)(root)
      : undefined;
  return selectContextEntries(root, found, options.dockerfile, gitBits);
}

export interface EnumerateContextSyncOptions {
  readonly platform?: NodeJS.Platform | undefined;
  readonly gitExecutableBits?:
    ((contextDir: string) => ReadonlyMap<string, boolean>) | undefined;
  readonly dockerfile?: string | undefined;
}

/** Synchronous twin of enumerateContext (same walk, ignore rules and executable bits). */
export function enumerateContextSync(
  contextDir: string,
  options: EnumerateContextSyncOptions = {},
): ContextEntry[] {
  const root = path.resolve(contextDir);
  const found = walkContext(root);
  const platform = options.platform ?? process.platform;
  const gitBits =
    platform === "win32"
      ? (options.gitExecutableBits ?? readGitExecutableBitsSync)(root)
      : undefined;
  return selectContextEntries(root, found, options.dockerfile, gitBits);
}

export interface ComputeFixtureIdentityOptions extends EnumerateContextOptions {
  readonly contextDir: string;
  readonly dockerfile: string;
  readonly buildArgs?: Readonly<Record<string, string>> | undefined;
}

export interface ComputeFixtureIdentitySyncOptions
  extends EnumerateContextSyncOptions {
  readonly contextDir: string;
  readonly dockerfile: string;
  readonly buildArgs?: Readonly<Record<string, string>> | undefined;
}

function identityOf(
  dockerfile: string,
  buildArgs: Readonly<Record<string, string>> | undefined,
  entries: readonly ContextEntry[],
): string {
  if (!entries.some((entry) => entry.path === dockerfile)) {
    throw new Error("Fixture Dockerfile is not part of its build context.");
  }
  return hashFixtureIdentity({ dockerfile, buildArgs: buildArgs ?? {}, entries });
}

/** Identity of a committed fixture context, the value used for the tag and the label. */
export async function computeFixtureIdentity(
  options: ComputeFixtureIdentityOptions,
): Promise<string> {
  const dockerfile = toContextRelativePath(
    options.contextDir,
    options.dockerfile,
  );
  const entries = await enumerateContext(options.contextDir, {
    ...options,
    dockerfile,
  });
  return identityOf(dockerfile, options.buildArgs, entries);
}

/**
 * Synchronous twin of computeFixtureIdentity. The SSH helper needs it because its 'build' mode
 * must start the build before its first await (35-04 cancellation contract), and the build
 * already carries the identity label.
 */
export function computeFixtureIdentitySync(
  options: ComputeFixtureIdentitySyncOptions,
): string {
  const dockerfile = toContextRelativePath(
    options.contextDir,
    options.dockerfile,
  );
  const entries = enumerateContextSync(options.contextDir, {
    ...options,
    dockerfile,
  });
  return identityOf(dockerfile, options.buildArgs, entries);
}

// ---------------------------------------------------------------------------------------------
// Step 2: registry reference
// ---------------------------------------------------------------------------------------------

export const INVALID_REGISTRY_MESSAGE =
  `${FIXTURE_REGISTRY_ENV} is not a valid registry reference (expected lowercase host[:port][/path] ` +
  'without scheme, credentials, whitespace or a leading "-"); ignoring it and building fixture images locally.';

export type RegistryValidation =
  | { readonly ok: true; readonly registry: string | null }
  | { readonly ok: false; readonly message: string };

/** Validates the opt-in registry value. Unset or '' means "not configured". Never echoes the value. */
export function validateRegistryReference(
  value: string | undefined,
): RegistryValidation {
  if (value === undefined || value === "") return { ok: true, registry: null };
  if (
    value.length > FIXTURE_REGISTRY_MAX_LENGTH ||
    !REGISTRY_PATTERN.test(value)
  ) {
    return { ok: false, message: INVALID_REGISTRY_MESSAGE };
  }
  return { ok: true, registry: value };
}

export function localFixtureRef(name: string, identity: string): string {
  return `${FIXTURE_LOCAL_REPOSITORY_PREFIX}/${name}:${identity}`;
}

export function remoteFixtureRef(
  registry: string,
  name: string,
  identity: string,
): string {
  return `${registry}/${name}:${identity}`;
}

/** Per-owner tag derived from a crypto.randomUUID ownership id (never a guessable name). */
export function fixtureOwnerTag(
  name: string,
  owner: string = randomUUID(),
): string {
  return `${FIXTURE_LOCAL_REPOSITORY_PREFIX}/${name}:owner-${owner}`;
}

// ---------------------------------------------------------------------------------------------
// Committed fixture images (one description for the SSH helper and scripts/fixture-images.mjs)
// ---------------------------------------------------------------------------------------------

/** Build context shared by every SSH fixture image: the whole tests/integration/images tree. */
export const FIXTURE_IMAGES_CONTEXT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../images",
);

export const SSHD_FIXTURE_UBUNTU_VERSIONS = ["22.04", "24.04"] as const;

export interface FixtureImageSpec {
  /** Repository name under the local prefix or the registry, e.g. sshd-ubuntu-24.04. */
  readonly name: string;
  /** Dockerfile path relative to FIXTURE_IMAGES_CONTEXT. */
  readonly dockerfile: string;
  /** Hashed build args (the identity build arg is added by the builder, never hashed). */
  readonly buildArgs: Readonly<Record<string, string>>;
}

/** The exact name, Dockerfile and build args startSshd builds for one fixture variant. */
export function sshdFixtureImageSpec(
  ubuntu: string,
  options: { readonly dockerCli?: boolean; readonly slowDf?: boolean } = {},
): FixtureImageSpec {
  return {
    name: `sshd-ubuntu-${ubuntu}`,
    dockerfile: `sshd-ubuntu-${ubuntu}/Dockerfile`,
    buildArgs: {
      WITH_DOCKER_CLI: String(options.dockerCli ?? false),
      WITH_SLOW_DF: String(options.slowDf ?? false),
    },
  };
}

/** Every SSH fixture variant startSshd can build: two Ubuntu versions x docker CLI x slow df. */
export function listFixtureImageSpecs(): FixtureImageSpec[] {
  const specs: FixtureImageSpec[] = [];
  for (const ubuntu of SSHD_FIXTURE_UBUNTU_VERSIONS) {
    for (const dockerCli of [false, true]) {
      for (const slowDf of [false, true]) {
        specs.push(sshdFixtureImageSpec(ubuntu, { dockerCli, slowDf }));
      }
    }
  }
  return specs;
}

// ---------------------------------------------------------------------------------------------
// Step 3: resolution
// ---------------------------------------------------------------------------------------------

export interface FixtureImageInfo {
  readonly label: string | null;
  readonly os: string;
  readonly architecture: string;
}

export interface FixturePlatform {
  readonly os: string;
  readonly architecture: string;
}

export interface FixtureDockerFacade {
  /** null when the reference does not exist (or cannot be inspected). */
  inspectImage(ref: string): Promise<FixtureImageInfo | null>;
  /** The local daemon's OS/architecture; null when unknown. */
  daemonPlatform(): Promise<FixturePlatform | null>;
  pull(
    ref: string,
    options: { readonly timeoutMs: number; readonly signal: AbortSignal },
  ): Promise<void>;
  tag(source: string, target: string): Promise<void>;
  /** Untags the reference (the image itself survives while other tags point to it). */
  removeImage(ref: string): Promise<void>;
}

export type FallbackReason =
  | "not-configured"
  | "invalid-registry"
  | "timeout"
  | "unauthorized"
  | "unreachable"
  | "not-found"
  | "failed"
  | "label-mismatch"
  | "platform-mismatch";

export const FIXTURE_FALLBACK_MESSAGES: Readonly<
  Record<FallbackReason, string>
> = {
  "not-configured": `Fixture image not cached locally and ${FIXTURE_REGISTRY_ENV} is not set; building it locally.`,
  "invalid-registry": INVALID_REGISTRY_MESSAGE,
  timeout: "Pulling a fixture image timed out; building it locally.",
  unauthorized:
    "The fixture image registry refused the pull (unauthorized); building it locally.",
  unreachable:
    "The fixture image registry is unreachable; building it locally.",
  "not-found":
    "The fixture image is not published in the registry; building it locally.",
  failed: "Pulling a fixture image failed; building it locally.",
  "label-mismatch":
    "A pulled fixture image did not carry the expected identity label; it was removed and the image is built locally.",
  "platform-mismatch":
    "A pulled fixture image does not match the local Docker OS/architecture; it was removed and the image is built locally.",
};

/** Maps a pull failure to a reason. Reads stderr only to classify it; never returns it. */
export function classifyPullFailure(
  error: unknown,
): Exclude<
  FallbackReason,
  "not-configured" | "invalid-registry" | "label-mismatch" | "platform-mismatch"
> {
  if (typeof error !== "object" || error === null) return "failed";
  const record = error as {
    killed?: unknown;
    code?: unknown;
    name?: unknown;
    stderr?: unknown;
    message?: unknown;
  };
  if (
    record.killed === true ||
    record.code === "ETIMEDOUT" ||
    record.name === "TimeoutError"
  )
    return "timeout";
  const text = [record.stderr, record.message]
    .filter((part): part is string => typeof part === "string")
    .join("\n")
    .toLowerCase();
  if (
    /unauthorized|authentication required|denied|forbidden|\b401\b|\b403\b/.test(
      text,
    )
  )
    return "unauthorized";
  if (/manifest unknown|not found|no such manifest|\b404\b/.test(text))
    return "not-found";
  if (
    /no such host|connection refused|network is unreachable|i\/o timeout|dial tcp|tls handshake|server misbehaving|could not resolve/.test(
      text,
    )
  ) {
    return "unreachable";
  }
  return "failed";
}

export interface ResolveFixtureImageOptions {
  /** Fixture name, e.g. `sshd-ubuntu-24.04` (lowercase registry component). */
  readonly name: string;
  readonly identity: string;
  /** Caller-owned tag the resolved image ends up under (the caller removes it on stop). */
  readonly target: string;
  readonly docker: FixtureDockerFacade;
  /**
   * Builds the image into `target`, passing FIXTURE_IDENTITY_BUILD_ARG = identity. In 'build' mode
   * it is called synchronously, before any await. Its cancellation and the reaping of a late
   * `target` stay with the caller; this module only guarantees it never caches an aborted build.
   */
  readonly build: () => Promise<void>;
  /** Raw NOODARA_TEST_FIXTURE_REGISTRY value; validated here. */
  readonly registry?: string | undefined;
  /** Already-scaled pull deadline. */
  readonly pullDeadlineMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly report?: ((message: string) => void) | undefined;
  /** 'reuse' (default): local cache, then opt-in pull, then build. 'build': always build. */
  readonly mode?: "reuse" | "build" | undefined;
  readonly pullSettleGraceMs?: number | undefined;
}

export interface ResolvedFixtureImage {
  readonly ref: string;
  readonly source: "local" | "pull" | "build";
}

const inflight = new Map<string, Promise<void>>();
const reported = new Set<FallbackReason>();

/** Clears the in-process single-flight table and the report-once memory (tests only). */
export function resetFixtureImageState(): void {
  inflight.clear();
  reported.clear();
}

interface ResolveContext {
  readonly options: ResolveFixtureImageOptions;
  readonly hashRef: string;
  readonly signal: AbortSignal | undefined;
  platform: Promise<FixturePlatform | null> | undefined;
}

function abortReason(signal: AbortSignal): unknown {
  return (
    signal.reason ??
    new DOMException("The operation was aborted.", "AbortError")
  );
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function raceAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) return promise;
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(abortReason(signal));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function report(
  options: ResolveFixtureImageOptions,
  reason: FallbackReason,
): void {
  if (reported.has(reason)) return;
  reported.add(reason);
  const sink =
    options.report ??
    ((message: string) => process.stderr.write(`[fixture-image] ${message}\n`));
  try {
    sink(FIXTURE_FALLBACK_MESSAGES[reason]);
  } catch {
    // Reporting is advisory; it never fails a resolution.
  }
}

async function safeInspect(
  docker: FixtureDockerFacade,
  ref: string,
): Promise<FixtureImageInfo | null> {
  try {
    return await docker.inspectImage(ref);
  } catch {
    return null;
  }
}

async function safeRemove(
  docker: FixtureDockerFacade,
  ref: string,
): Promise<void> {
  try {
    await docker.removeImage(ref);
  } catch {
    // Best effort: an absent reference is the goal.
  }
}

function platformOf(context: ResolveContext): Promise<FixturePlatform | null> {
  context.platform ??= context.options.docker
    .daemonPlatform()
    .catch(() => null);
  return context.platform;
}

function isVerified(
  info: FixtureImageInfo | null,
  identity: string,
  platform: FixturePlatform | null,
): boolean {
  return (
    info !== null &&
    platform !== null &&
    info.label === identity &&
    info.os === platform.os &&
    info.architecture === platform.architecture
  );
}

/** Tags the verified local cache image as `target`. */
async function useLocal(context: ResolveContext): Promise<boolean> {
  const { docker, identity, target } = context.options;
  const platform = await platformOf(context);
  if (
    !isVerified(await safeInspect(docker, context.hashRef), identity, platform)
  )
    return false;
  throwIfAborted(context.signal);
  try {
    await docker.tag(context.hashRef, target);
  } catch {
    return false;
  }
  if (!isVerified(await safeInspect(docker, target), identity, platform)) {
    await safeRemove(docker, target);
    return false;
  }
  if (context.signal?.aborted) {
    await safeRemove(docker, target);
    throw abortReason(context.signal);
  }
  return true;
}

/** Publishes `target` under the content-hash tag, only when it is verified and the tag is not. */
async function publishHashTag(context: ResolveContext): Promise<void> {
  const { docker, identity, target } = context.options;
  const platform = await platformOf(context);
  if (!isVerified(await safeInspect(docker, target), identity, platform))
    return;
  if (
    isVerified(await safeInspect(docker, context.hashRef), identity, platform)
  )
    return;
  if (context.signal?.aborted) return;
  try {
    await docker.tag(target, context.hashRef);
  } catch {
    // Best effort: the next resolution simply misses the cache.
  }
}

async function reapLatePull(
  context: ResolveContext,
  pulling: Promise<void>,
  remoteRef: string,
): Promise<void> {
  const { docker } = context.options;
  const grace = context.options.pullSettleGraceMs ?? PULL_SETTLE_GRACE_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = pulling.then(
    () => true,
    () => true,
  );
  const inTime = await Promise.race([
    settled,
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), grace);
      timer.unref();
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (inTime) {
    await safeRemove(docker, remoteRef);
  } else {
    void settled.then(() => safeRemove(docker, remoteRef));
  }
}

/** Pulls into `target`; true only when `target` holds a verified image. Throws on abort. */
async function tryPull(context: ResolveContext): Promise<boolean> {
  const { options, signal } = context;
  const { docker, identity, name, target } = options;
  const validation = validateRegistryReference(options.registry);
  if (!validation.ok) {
    report(options, "invalid-registry");
    return false;
  }
  if (validation.registry === null) {
    report(options, "not-configured");
    return false;
  }
  const remoteRef = remoteFixtureRef(validation.registry, name, identity);
  const deadline = AbortSignal.timeout(options.pullDeadlineMs);
  const combined =
    signal === undefined ? deadline : AbortSignal.any([signal, deadline]);
  let pulling: Promise<void>;
  try {
    pulling = docker.pull(remoteRef, {
      timeoutMs: options.pullDeadlineMs,
      signal: combined,
    });
  } catch (error) {
    pulling = Promise.reject(error);
  }
  try {
    await raceAbort(pulling, combined);
  } catch (error) {
    if (combined.aborted) await reapLatePull(context, pulling, remoteRef);
    else await safeRemove(docker, remoteRef);
    throwIfAborted(signal);
    report(options, deadline.aborted ? "timeout" : classifyPullFailure(error));
    return false;
  }
  if (signal?.aborted) {
    await safeRemove(docker, remoteRef);
    throw abortReason(signal);
  }
  try {
    await docker.tag(remoteRef, target);
  } catch {
    await safeRemove(docker, remoteRef);
    report(options, "failed");
    return false;
  }
  await safeRemove(docker, remoteRef);
  const pulled = await safeInspect(docker, target);
  const platform = await platformOf(context);
  if (pulled?.label !== identity) {
    await safeRemove(docker, target);
    report(options, "label-mismatch");
    return false;
  }
  if (!isVerified(pulled, identity, platform)) {
    await safeRemove(docker, target);
    report(options, "platform-mismatch");
    return false;
  }
  if (signal?.aborted) {
    await safeRemove(docker, target);
    throw abortReason(signal);
  }
  return true;
}

async function finishBuild(
  context: ResolveContext,
  building: Promise<void>,
): Promise<ResolvedFixtureImage> {
  await raceAbort(building, context.signal);
  throwIfAborted(context.signal);
  await publishHashTag(context);
  throwIfAborted(context.signal);
  return { ref: context.options.target, source: "build" };
}

async function acquire(context: ResolveContext): Promise<ResolvedFixtureImage> {
  if (await tryPull(context)) {
    await publishHashTag(context);
    if (context.signal?.aborted) {
      await safeRemove(context.options.docker, context.options.target);
      throw abortReason(context.signal);
    }
    return { ref: context.options.target, source: "pull" };
  }
  throwIfAborted(context.signal);
  // Another process may have published the image while this one was pulling.
  if (await useLocal(context))
    return { ref: context.options.target, source: "local" };
  throwIfAborted(context.signal);
  return finishBuild(context, context.options.build());
}

function assertResolveOptions(options: ResolveFixtureImageOptions): string {
  if (!NAME_PATTERN.test(options.name))
    throw new Error("Invalid fixture image name.");
  if (!IDENTITY_PATTERN.test(options.identity))
    throw new Error("Invalid fixture image identity.");
  const hashRef = localFixtureRef(options.name, options.identity);
  if (
    options.target.length > 255 ||
    !TARGET_PATTERN.test(options.target) ||
    options.target === hashRef
  ) {
    throw new Error("Invalid fixture image target tag.");
  }
  return hashRef;
}

/**
 * Resolves a fixture image into `options.target`.
 * - 'build' mode: build (synchronously started), then publish the hash tag best effort.
 * - 'reuse' mode: verified local `noodara-test/<name>:<hash>`; else, with in-process
 *   single-flight per identity, opt-in pull of `<registry>/<name>:<hash>` (deadline, label and
 *   OS/arch verification), then a re-check of the local cache, then build.
 * Every pull problem falls back to the build path. Abort rejects with the signal's reason and
 * leaves no tag created by this module (`target`, remote ref or hash tag) behind.
 */
export async function resolveFixtureImage(
  options: ResolveFixtureImageOptions,
): Promise<ResolvedFixtureImage> {
  const hashRef = assertResolveOptions(options);
  const context: ResolveContext = {
    options,
    hashRef,
    signal: options.signal,
    platform: undefined,
  };
  if (options.mode === "build") {
    throwIfAborted(options.signal);
    return finishBuild(context, options.build());
  }

  const key = `${options.name}@${options.identity}`;
  for (let wait = 0; wait < MAX_SINGLE_FLIGHT_WAITS; wait += 1) {
    throwIfAborted(options.signal);
    if (await useLocal(context))
      return { ref: options.target, source: "local" };
    const pending = inflight.get(key);
    if (pending === undefined) break;
    // A waiter races its own signal; if the initiator fails or aborts, the waiter takes over.
    await raceAbort(pending, options.signal);
  }
  throwIfAborted(options.signal);

  const work = acquire(context);
  if (!inflight.has(key)) {
    const settled = work.then(
      () => undefined,
      () => undefined,
    );
    inflight.set(key, settled);
    void settled.then(() => {
      if (inflight.get(key) === settled) inflight.delete(key);
    });
  }
  return work;
}

// ---------------------------------------------------------------------------------------------
// Docker CLI facade (argument arrays only, no shell)
// ---------------------------------------------------------------------------------------------

export type DockerRunner = (
  args: readonly string[],
  options: {
    readonly timeoutMs: number;
    readonly signal?: AbortSignal | undefined;
  },
) => Promise<string>;

const INSPECT_FORMAT =
  '{"os":{{json .Os}},"architecture":{{json .Architecture}},"labels":{{json .Config.Labels}}}';

/** Default runner: execFile('docker', args) with an explicit timeout. */
export const runDockerCli: DockerRunner = async (args, options) => {
  const { stdout } = await execFileAsync("docker", [...args], {
    timeout: options.timeoutMs,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    maxBuffer: 4 * 1024 * 1024,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout;
};

function parseInspect(stdout: string): FixtureImageInfo | null {
  const text = stdout.trim();
  if (text === "") return null;
  try {
    const parsed = JSON.parse(text) as {
      os?: unknown;
      architecture?: unknown;
      labels?: unknown;
    };
    const labels =
      typeof parsed.labels === "object" && parsed.labels !== null
        ? (parsed.labels as Record<string, unknown>)
        : {};
    const label = labels[FIXTURE_IDENTITY_LABEL];
    return {
      label: typeof label === "string" ? label : null,
      os: typeof parsed.os === "string" ? parsed.os : "",
      architecture:
        typeof parsed.architecture === "string" ? parsed.architecture : "",
    };
  } catch {
    return null;
  }
}

export function createDockerCliFacade(
  run: DockerRunner = runDockerCli,
  metadataTimeoutMs: number = DOCKER_METADATA_TIMEOUT_MS,
): FixtureDockerFacade {
  return {
    async inspectImage(ref) {
      try {
        return parseInspect(
          await run(
            ["image", "inspect", "--format", INSPECT_FORMAT, "--", ref],
            { timeoutMs: metadataTimeoutMs },
          ),
        );
      } catch {
        return null;
      }
    },
    async daemonPlatform() {
      try {
        const out = (
          await run(
            ["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"],
            { timeoutMs: metadataTimeoutMs },
          )
        ).trim();
        const [os, architecture] = out.split("/");
        return os && architecture ? { os, architecture } : null;
      } catch {
        return null;
      }
    },
    async pull(ref, options) {
      await run(["pull", "--quiet", "--", ref], {
        timeoutMs: options.timeoutMs,
        signal: options.signal,
      });
    },
    async tag(source, target) {
      await run(["image", "tag", "--", source, target], {
        timeoutMs: metadataTimeoutMs,
      });
    },
    async removeImage(ref) {
      await run(["image", "rm", "--", ref], { timeoutMs: metadataTimeoutMs });
    },
  };
}
