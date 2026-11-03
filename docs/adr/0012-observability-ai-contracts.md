# ADR 0012: Observability and AI contracts (sampling, container state, OOM, `docker logs`, AI providers, eval replay)

## Status

Accepted — 2026-11-03

## Context

v0.5 adds metrics, runtime logs, the Infrastructure Graph and a read-only AI assistant. The
decisions of 2026-11-03 (`.planning/DECISIONS.md`) fixed SSH sampling by a BullMQ job (no agent,
no `docker events`), runtime logs kept on the server, a graph derived on read, provider SDKs only
under `packages/ai/src/providers` and a replay-based CI eval. This ADR records the measured
behaviour those decisions rest on and fixes the shapes phases 26–31 implement.

Every measurement is a permanent contract test in
`tests/integration/deploy-engine/contracts-v05.test.ts` (gate `it-contracts-v05`: 3 static tests
plus 8 per version, 19/19 green on 22.04 and 24.04). Titles start with `HOST`, `CONTAINER`, `OOM`,
`LOGS` or `BOUNDED / ADR 0012`. Raw numbers come from `NOODARA_MEASUREMENTS_FILE=<file>`
(`[V05-*]` lines).

Environment: ADR 0008 fixture (`sshd-dockerd-ubuntu-{22.04,24.04}`), Docker 29.9.2, json-file
log driver, cgroup v2 (cgroupfs), kernel 7.0.14-linuxkit, macOS arm64 Docker Desktop, 2026-11-03.
Fixture images `tests/integration/fixtures/{oom-allocator,crash-loop}` are built on the host from
`node:22-alpine@sha256:0a7108bf…e402` (the base the harness already preloads); nothing is pulled.

## Bounded execution (H1)

Every probe runs as

```text
env -i PATH=/usr/sbin:/usr/bin:/sbin:/bin HOME=<home> LC_ALL=C \
  timeout -k 1 <s> bash --noprofile --norc -c 'set -o pipefail; { <script>; } 2>&1 | head -c <cap>' \
  noodara-<probe> <args…>
```

Scripts are constants; variable parts (container ids, timestamps, templates) travel as
single-quoted positional arguments. Measured on both versions: the remote environment holds only
`HOME LC_ALL PATH PWD SHLVL _`; `timeout` ends a slow probe with 124 at ~2.0 s for a 2 s limit;
`head -c` ends an oversized one with 141 at exactly the cap. No probe output contained the
canary set as a container env var. A static test rejects any fixture `FROM` that is not
`<image>:<tag>@sha256:<64 hex>` or that uses `:latest`.

Defaults for 27-xx: host and container sample 15 s timeout, 64 KiB cap; logs fetch 20 s timeout,
cap = the logs API byte limit below plus 4 KiB.

## Host sample (A1)

### Decision

One exec per sample (script `HOST_SAMPLE` in the test, argument = delta seconds, default `1`):

```text
CPU <first line of /proc/stat>      # read 1
sleep "$1"
CPU <first line of /proc/stat>      # read 2
MEM MemTotal: … kB / MEM MemAvailable: … kB
DF  <target> <size> <used> <avail>  # df -B1 --output=target,size,used,avail / <DockerRootDir>
UP  <uptime seconds> <idle seconds> # /proc/uptime
```

`DockerRootDir` comes from `docker info --format '{{.DockerRootDir}}'`; if Docker is down the
sample still reports `/`. CPU % = `100 * (Δtotal − Δidle) / Δtotal`, where total is the sum of
the first 8 fields (`user nice system idle iowait irq softirq steal`; guest is already in user)
and idle is `idle + iowait`; clamped to 0–100, 0 when Δtotal ≤ 0. Memory used = `MemTotal −
MemAvailable` (bytes = kB × 1024; parse with 64-bit arithmetic, `mawk` on 22.04 prints large
products as `%g`). Disk is reported per target; when both resolve to the same filesystem they
carry the same numbers and the UI shows one.

### Measured (both versions)

| | 22.04 | 24.04 |
|---|---|---|
| Sample, delta 1 s (3 runs) | 1085–1106 ms | 1069–1085 ms |
| Sample, delta 0.5 s | 564 ms | 563 ms |
| Output | 334 B | 334 B |
| `docker info` DockerRootDir | 45 ms | 35 ms |

The cost is the delta itself; everything else is < 60 ms.

## Container sample (A2)

### Decision

One exec per sample (`CONTAINER_SAMPLE`): `docker ps -a -q --no-trunc --filter
label=noodara.managed=true`, then `docker inspect --type container --format "$1"` over all of
them and `docker stats --no-stream --no-trunc --format "$2"` over the running ones.

Inspect template (one JSON object per container):

```text
{"id":{{json .Id}},"name":{{json .Name}},"status":{{json .State.Status}},
 "running":{{json .State.Running}},"restarting":{{json .State.Restarting}},
 "restartCount":{{json .RestartCount}},"oomKilled":{{json .State.OOMKilled}},
 "exitCode":{{json .State.ExitCode}},"startedAt":{{json .State.StartedAt}},
 "finishedAt":{{json .State.FinishedAt}},
 "health":{{with index .State "Health"}}{{json .Status}}{{else}}null{{end}},
 "healthExitCodes":[{{with index .State "Health"}}{{range $i, $l := .Log}}{{if $i}},{{end}}{{$l.ExitCode}}{{end}}{{end}}],
 "memoryLimit":{{json .HostConfig.Memory}}}
```

Stats template: `{{.ID}}\t{{.CPUPerc}}\t{{.MemUsage}}` (`12.3%`, `4.5MiB / 64MiB`; binary
units `B KiB MiB GiB TiB`, decimal `kB MB GB` accepted).

Rule (static test over `packages/ssh/src`, `packages/docker/src`, `apps/control-plane/src` and
the probe templates): no template may select `.Config.Env`, `.Config.Cmd`, `.Mounts` or
`{{json .Config}}`. The sampler template additionally selects only `.Id`, `.Name`,
`.RestartCount`, `.State.*` scalars and `.HostConfig.Memory`, never `{{json .}}`, and
`Health.Log` contributes exit codes only, never its `Output`. (The v0.3 healthcheck probe's
existing `{{json .State}}` stays as is; it carries no env.)

### Measured (both versions)

- The CLI renders templates over the raw JSON map: a missing key (no `HEALTHCHECK` ⇒ no
  `.State.Health`) is a template error, so the template uses `with index .State "Health"`.
- `RestartCount` is top-level, not under `.State`. `.State` keys: `Status Running Paused
  Restarting OOMKilled Dead Pid ExitCode Error StartedAt FinishedAt [Health]`.
- Inspect timestamps are RFC3339Nano with trailing zeros trimmed; a never-finished container
  reports `0001-01-01T00:00:00Z`. A restarting container reports `running=true, restarting=true`.
- No memory limit: `HostConfig.Memory = 0` and stats shows the host `MemTotal` as limit. 27-xx
  stores `memoryLimit = null` in that case, not the host total.
- Sample with 2 managed containers: 2005–2135 ms, 894–902 B. `docker stats --no-stream` is ~2 s
  of it (it waits for two cgroup reads); inspect is tens of ms.

## OOM and crash loop (A3)

### Measured (both versions)

- `--memory 32m --memory-swap 32m` + the allocator: exits 229 ms (22.04) / 355 ms (24.04) after
  start with `status=exited, oomKilled=true, exitCode=137`. Logs show the start marker only.
- `--restart on-failure` + `exit 3`: `RestartCount` 4 at ~1.1 s, 5 at ~2.2 s, 6 at ~4.2 s, 7 at
  ~7.3 s (Docker doubles the restart delay), `status=restarting`, `exitCode=3` throughout.

### Decision

The diagnosis signal for OOM is `oomKilled=true` (137 alone also means SIGKILL from anything
else). Crash looping is `restartCount` growing between two samples or `restarting=true`; the
growth rate slows with Docker's backoff, so the rule compares counts, not intervals.

## `docker logs` (A4)

### Measured (both versions)

- `--timestamps` prefixes every line with a fixed 9-digit `RFC3339Nano` UTC timestamp and a
  space (`2026-11-03T18:37:14.689777509Z out 0`).
- stdout and stderr stay on their own streams (`>o 2>e`); each stream is in order. Merging the
  two by timestamp gave 26 (22.04) and 4 (24.04) inversions in 400 lines: cross-stream order is
  not reliable and the API does not promise it.
- `--since` and `--until` are inclusive on RFC3339Nano.
- `--tail N` is applied before `--until`: `--until T --tail N` returns the last N lines of the
  whole log filtered by `until`, which is empty when the last N are after T. `--since T --tail
  N` returns the last N lines at or after T.
- Cost on a 300 001-line rotated log (15.2 MB, `max-size=10m, max-file=3`): tail 100 = 11–12 ms,
  1000 = 13–23 ms, 10 000 = 25–28 ms, full = 400–499 ms.

### Decision (bounded fetch shape for the logs API)

```text
docker logs --timestamps --since <since> [--tail <n>] -- <container>   # stdout / stderr captured apart
```

- Always `--since` (default now − 15 min, max window 24 h) and `--tail` ≤ 1000 (default 200).
  `--until` is filtered server-side after the fetch, never combined with `--tail` remotely.
- Each line is parsed as `<ts> <text>`, tagged `stdout|stderr`, and the API returns the merged
  page sorted by timestamp with stream as a field; ties keep fetch order.
- Response cap 256 KiB; a line longer than 8 KiB is truncated and flagged. Text is redacted with
  the service's secret values before leaving the API, as for build logs.
- Pagination is backwards by timestamp: the next page's `since` window ends at the oldest line
  returned.

## Data placement and sampling defaults (A7)

- Sample interval **60 s** (configurable 30–300 s). One SSH session per CONNECTED server per tick
  with two execs (host, container), ~3.2 s measured; a tick that is still running skips the
  next (no overlap, no queue growth).
- Retention **7 days** at full resolution (10 080 host rows per server per week), pruned by the
  same repeatable job; no downsampling in v0.5.
- **Postgres:** `MetricSnapshot` (host and per-container rows), build and deploy log chunks,
  activity, AI conversations (redacted). **Stays on the server:** runtime container logs, fetched
  on demand through the bounded shape above, never bulk-copied or indexed.
- **Graph:** `InfrastructureNode` / `InfrastructureRelation` are domain types built by
  `buildGraph` over one DB snapshot on each read; no graph tables.
- **DEPENDS_ON:** inferred only when a plain (non-secret) env value of service A names another
  registered service B by its container name or one of its domains (host part of a URL, or the
  whole value). Secret values are never read for inference. No manual edges in v0.5.

## AI provider contract (A5)

### Decision

`AIProvider` exposes one streaming turn over a normalized shape; SDKs live only in
`packages/ai/src/providers/{anthropic,openai}`.

| | Anthropic Messages (`@anthropic-ai/sdk`) | OpenAI Chat Completions (`openai`) |
|---|---|---|
| Default model (pinned) | `claude-opus-5-5`, `output_config.effort: "medium"` set explicitly, adaptive thinking (cannot be disabled) | `gpt-5-2025-08-07` (dated snapshot) |
| Tools | `tools: [{name, description, input_schema, strict: true}]`, `tool_choice: auto` (forced `any`/`tool` is a 400 on this model) | `tools: [{type: "function", function: {name, description, parameters, strict: true}}]`, `tool_choice: "auto"` |
| Tool call | `tool_use` blocks `{id, name, input}`, `stop_reason: "tool_use"`, parallel calls allowed | `message.tool_calls[] {id, function: {name, arguments}}` (JSON string), `finish_reason: "tool_calls"` |
| Tool result | one user message with all `tool_result {tool_use_id, content, is_error}` blocks | one `{role: "tool", tool_call_id, content}` per call; errors as `{"error": …}` in content |
| Streaming | SSE `message_start`, `content_block_start`, `content_block_delta` (`text_delta`, `input_json_delta`), `content_block_stop`, `message_delta` (stop_reason, usage), `message_stop`, `ping`, `error` | chunks with `choices[0].delta.content` and `delta.tool_calls[i]` fragments by `index`; last chunk `finish_reason`; `stream_options.include_usage` |
| Final answer | `output_config.format: {type: "json_schema", schema}` | `response_format: {type: "json_schema", json_schema: {name, schema, strict: true}}` |
| Stop reasons | `end_turn`, `tool_use`, `max_tokens`, `refusal` (with `stop_details`), `pause_turn` | `stop`, `tool_calls`, `length`, `content_filter` |

The final answer is always re-validated by Noodara's Zod schema; a schema failure is
`INVALID_ANSWER` (one repair turn, then fail). Tool inputs are validated against the tool's Zod
schema before running, whatever the provider guarantees. Tool arguments are parsed as JSON,
never string-matched. Refusal fallbacks (Anthropic `fallbacks`) are not enabled: a refusal is
surfaced as a normalized stop reason.

Normalized errors (both SDKs expose the same classes; SDK `maxRetries` set to 2, request timeout
60 s, a turn deadline enforced by Noodara):

| Normalized | Anthropic / OpenAI SDK | Retried | Shown to user |
|---|---|---|---|
| `AUTH` | 401 `AuthenticationError` | no | invalid API key |
| `FORBIDDEN` | 403 `PermissionDeniedError` | no | key lacks access to the model |
| `RATE_LIMITED` | 429 `RateLimitError` (`retry-after`) | SDK only | try again in N s |
| `PROVIDER_UNAVAILABLE` | ≥500, 529 overloaded `InternalServerError` | SDK only | provider unavailable |
| `TIMEOUT` | `APIConnectionTimeoutError`, turn deadline | no | timed out |
| `CONNECTION` | `APIConnectionError` | SDK only | cannot reach provider |
| `INVALID_REQUEST` | 400/404/422 `BadRequestError`, `NotFoundError` | no | logged, generic message |

Error bodies and messages are redacted before logging; the API key never appears in errors,
logs or activity. Model ids are re-checked against vendor docs in the live run of 29-02 /
31-06 (OPEN_QUESTIONS #21); a change is an ADR amendment, not a silent edit.

### Rejected alternatives

- **LangChain / Vercel AI SDK:** a second abstraction over two SDKs, wide dependency surface,
  hides error classes and tool-call details the read-only guarantees rely on.
- **Provider-agnostic gateway (OpenAI-compatible proxy, LiteLLM-style):** an extra service in
  the install, loses Anthropic-specific fields (`is_error`, `stop_details`, effort) and adds a
  place where keys and prompts transit.
- **Prompt-only permissions:** the model can be steered; read-only is enforced by the tool
  registry and per-tool backend scope checks (DECISIONS 2026-11-03), the prompt only explains it.

## Eval execution (A6)

### Decision

- **Replay (CI, default):** a `ReplayProvider` implements `AIProvider` from cassettes. The key is
  `sha256` of the canonical JSON (sorted keys) of the redacted request: provider, model, system,
  messages, tool definitions, response schema; no timestamps or request ids. The real agent loop,
  tools (against fixture data), redaction and scorer run unchanged. A cassette miss fails the
  run with the key and the first differing field; it never falls back to live.
- **Live:** with a real key (`NOODARA_EVAL_LIVE=1`), the recording provider wraps the real one
  and writes cassettes plus `baseline.json`. Live is the only way to create cassettes or raise
  the baseline; hand-written cassettes are rejected in review. Nightly runs live when the key
  secret exists, otherwise records an explicit skip.
- Cassettes store the redacted request and the provider response stream, never keys; the leak
  scan covers them.

### What replay proves and what it does not

Proves: the loop, tool dispatch, scope checks, redaction and scorer behave deterministically for
the recorded conversations; any change to prompts, tools or schemas that alters a request is
detected as a miss; adversarial cases still end in refusals or NOT_FOUND through the real
backend. Does not prove: that a current model still answers well, that a re-worded prompt is
better, provider latency, rate limits or vendor API drift. Those need a live run.

## Consequences

- 27-xx implements the host and container samplers with these exact scripts and parsers (the
  test's parsers are the reference); the sampler is one bounded session per tick.
- 28-xx implements the logs API on the bounded fetch shape; no log storage is added.
- 29-xx/30-xx implement `AIProvider`, the replay provider and the scorer on these shapes.
- A Docker or Ubuntu upgrade that changes any measured behaviour fails `it-contracts-v05`.
