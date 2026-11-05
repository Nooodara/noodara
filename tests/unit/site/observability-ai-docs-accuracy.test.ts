// 30-06 A1: the metrics, logs, graph and AI pages quote the real error codes, defaults and limits,
// read from the domain, AI and control-plane sources rather than retyped.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AI_TOOL_LOG_MAX_LINES } from '../../../packages/ai/src/tools/definitions';
import { AI_TOOL_RESULT_MAX_BYTES } from '../../../packages/ai/src/tools/envelope';
import { AI_TOOL_NAMES } from '../../../packages/ai/src/tools/types';
import { DEFAULT_HISTORY_LIMITS } from '../../../packages/ai/src/agent/history';
import {
  V05_ERROR_MESSAGES,
  V05_SERVICE_ERROR_CODES,
  SERVICE_ERROR_STATUS,
} from '../../../packages/domain/src/api-contract/http-errors';
import {
  AI_MAX_TOOL_CALLS_PER_MESSAGE,
  AI_PROVIDER_KEY_MAX_LENGTH,
  AI_PROVIDER_KEY_MIN_LENGTH,
  AI_PROVIDER_MODELS,
  AI_QUESTION_MAX_LENGTH,
  GRAPH_MAX_NODES,
  GRAPH_MAX_RELATIONS,
  LOG_LINE_MAX_LENGTH,
  LOG_PAGE_MAX_ENTRIES,
  METRIC_NAMES,
  METRIC_SERIES_MAX_POINTS,
} from '../../../packages/domain/src/api-contract/v05-schemas';
import { GRAPH_NODE_KINDS, GRAPH_RELATION_TYPES } from '../../../packages/domain/src/graph/graph-types';
import {
  LOG_LEVELS,
  LOG_SEARCH_MAX_LENGTH,
  LOG_SOURCES,
  LOG_WINDOW_DEFAULT_MS,
  LOG_WINDOW_MAX_MS,
} from '../../../packages/domain/src/logs/log-model';
import {
  CRASH_LOOP_MIN_RESTARTS,
  CRASH_LOOP_WINDOW_MS,
  OOM_EXIT_CODE,
  OOM_NEAR_LIMIT_PERCENT,
} from '../../../packages/domain/src/observability/container-observation';
import {
  HIGH_DISK_PERCENT,
  HIGH_MEMORY_PERCENT,
  HIGH_MEMORY_SUSTAINED_SAMPLES,
} from '../../../packages/domain/src/observability/thresholds';
import { findForbiddenWording } from '../../../apps/site/src/lib/content-rules';

// env.ts, logs.ts, metric-range.ts and ai-schemas.ts pull in runtime config or Fastify on
// import, so their values are read from the source text.
const source = (path: string) => readFileSync(path, 'utf8');
const envSource = source('apps/control-plane/src/env.ts');
const numberIn = (text: string, name: string): number => {
  const match = new RegExp(`${name}\\s*[:=]\\s*([0-9_]+)`).exec(text);
  if (match?.[1] === undefined) throw new Error(`${name} not found`);
  return Number(match[1].replaceAll('_', ''));
};
const rangeIn = (text: string, name: string) => {
  const match = new RegExp(`${name} = \\{ min: ([0-9_]+), max: ([0-9_]+) \\}`).exec(text);
  if (match?.[1] === undefined || match[2] === undefined) throw new Error(`${name} not found`);
  return { min: Number(match[1].replaceAll('_', '')), max: Number(match[2].replaceAll('_', '')) };
};
const METRICS_INTERVAL_MS = numberIn(envSource, 'DEFAULT_METRICS_INTERVAL_MS');
const METRICS_RETENTION_HOURS = numberIn(envSource, 'DEFAULT_METRICS_RETENTION_HOURS');
const INTERVAL_RANGE = rangeIn(envSource, 'METRICS_INTERVAL_RANGE');
const RETENTION_RANGE = rangeIn(envSource, 'METRICS_RETENTION_RANGE');
const METRICS_ENV_KNOBS = [
  ...(/export const METRICS_ENV_KNOBS = \[([^\]]*)\]/.exec(envSource)?.[1] ?? '').matchAll(/'(NOODARA_[A-Z0-9_]+)'/g),
].map((m) => m[1] ?? '');
const LOGS_DEFAULT_LIMIT = numberIn(source('apps/control-plane/src/routes/logs.ts'), 'defaultLimit');
const METRIC_MIN_INTERVAL_SECONDS = numberIn(
  source('apps/control-plane/src/observability/metric-range.ts'),
  'METRIC_MIN_INTERVAL_SECONDS',
);
const aiSchemas = source('apps/control-plane/src/routes/ai-schemas.ts');
const AI_CONVERSATION_ERRORS = [
  ...(/AI_CONVERSATION_ERRORS = Object\.freeze\(\{([\s\S]*?)\n\} as const\)/.exec(aiSchemas)?.[1] ?? '').matchAll(
    /^ {2}([A-Z_]+): \{\s*status: (\d+)/gm,
  ),
].map((m) => ({ code: m[1] ?? '', status: Number(m[2]) }));
const AI_PROVIDER_INPUT_INVALID_STATUS = numberIn(
  source('apps/control-plane/src/ai/settings/ai-settings-service.ts'),
  'AI_PROVIDER_INPUT_INVALID_STATUS',
);

const read = (path: string) => readFileSync(`apps/site/content/docs/${path}.mdx`, 'utf8');
const flat = (text: string) => text.replace(/\s+/g, ' ');
/** Every `UPPER_CODE` in backticks. */
const codesIn = (text: string) => [...text.matchAll(/`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g)].map((m) => m[1] ?? '');

const metrics = read('operate/metrics');
const logs = read('operate/logs');
const graph = read('concepts/infrastructure-graph');
const ai = read('operate/ai-assistant');
const variables = read('reference/variables');
const errorCodes = read('reference/error-codes');

const conversationCodes = new Set(AI_CONVERSATION_ERRORS.map((e) => e.code));
/** A code the API really returns: a service error or one of the AI conversation errors. */
const isRealCode = (code: string) =>
  Object.hasOwn(SERVICE_ERROR_STATUS, code) || conversationCodes.has(code) || code === 'AI_PROVIDER_INPUT_INVALID';

describe('operate/metrics.mdx', () => {
  const text = flat(metrics);

  it('quotes the sample interval and retention with their bounds', () => {
    expect(text).toContain(`every **${String(METRICS_INTERVAL_MS / 1000)} seconds**`);
    expect(text).toContain(`from ${String(INTERVAL_RANGE.min)} (${String(INTERVAL_RANGE.min / 1000)} seconds) to ${String(INTERVAL_RANGE.max)} (${String(INTERVAL_RANGE.max / 60_000)} minutes)`);
    expect(text).toContain(`**${String(METRICS_RETENTION_HOURS)} hours (${String(METRICS_RETENTION_HOURS / 24)} days)**`);
    expect(text).toContain(`from ${String(RETENTION_RANGE.min)} to ${String(RETENTION_RANGE.max)} hours (${String(RETENTION_RANGE.max / 24)} days)`);
    for (const knob of METRICS_ENV_KNOBS) expect(text).toContain(`\`${knob}\``);
  });

  it('lists every metric name and the chart point cap', () => {
    const rows = [...metrics.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]);
    expect(rows).toEqual([...METRIC_NAMES]);
    expect(text).toContain(`at most ${String(METRIC_SERIES_MAX_POINTS)} points`);
    expect(text).toContain(`at least ${String(METRIC_MIN_INTERVAL_SECONDS)} seconds`);
  });

  it('quotes the status thresholds of the observability policies', () => {
    expect(text).toContain(`at ${String(HIGH_DISK_PERCENT)}% or more.`);
    expect(text).toContain(`Memory is at ${String(HIGH_MEMORY_PERCENT)}% or more for the last ${String(HIGH_MEMORY_SUSTAINED_SAMPLES)} samples`);
    expect(text).toContain(`${String(CRASH_LOOP_MIN_RESTARTS)} times or more within ${String(CRASH_LOOP_WINDOW_MS / 60_000)} minutes`);
    expect(text).toContain(`code ${String(OOM_EXIT_CODE)} while its memory was at ${String(OOM_NEAR_LIMIT_PERCENT)}% or more`);
  });
});

describe('operate/logs.mdx', () => {
  const text = flat(logs);

  it('lists exactly the log sources and levels', () => {
    const rows = [...logs.matchAll(/^\| `([a-z]+)` \|/gm)].map((m) => m[1]);
    expect(rows).toEqual([...LOG_SOURCES]);
    expect(text).toContain(LOG_LEVELS.map((l) => `\`${l}\``).join(', ').replace(/, (?=[^,]*$)/, ' or '));
  });

  it('quotes the window, search, page and line limits', () => {
    expect(text).toContain(`the last ${String(LOG_WINDOW_DEFAULT_MS / 60_000)} minutes by default, at most ${String(LOG_WINDOW_MAX_MS / 3_600_000)} hours`);
    expect(text).toContain(`at most ${String(LOG_SEARCH_MAX_LENGTH)} characters`);
    expect(text).toContain(`${String(LOGS_DEFAULT_LIMIT)} lines by default, at most ${String(LOG_PAGE_MAX_ENTRIES)}`);
    expect(text).toContain(`longer than ${String(LOG_LINE_MAX_LENGTH / 1024)} KiB`);
  });
});

describe('concepts/infrastructure-graph.mdx', () => {
  const text = flat(graph);

  it('lists exactly the node kinds and relation types', () => {
    const rows = [...graph.matchAll(/^\| `([A-Za-z_]+)` \|/gm)].map((m) => m[1]);
    expect(rows).toEqual([...GRAPH_NODE_KINDS, ...GRAPH_RELATION_TYPES]);
  });

  it('states the DEPENDS_ON inference rule and that secrets are never read', () => {
    for (const needle of ['**plain variable**', '`noodara-<service id>`', 'host of a URL', 'exactly one service', 'same project', '**Secrets are never read**']) {
      expect(text, needle).toContain(needle);
    }
    expect(text).toContain(`at most ${String(GRAPH_MAX_NODES)} nodes and ${String(GRAPH_MAX_RELATIONS)} relations`);
  });
});

describe('operate/ai-assistant.mdx', () => {
  const text = flat(ai);

  it('names every provider with its pinned model', () => {
    for (const [provider, models] of Object.entries(AI_PROVIDER_MODELS)) {
      for (const model of models) {
        // A dated snapshot id cannot appear in site copy (no literal dates); its family prefix is quoted.
        const quoted = findForbiddenWording(model).length === 0 ? model : (/^[a-z]+-\d+/.exec(model)?.[0] ?? model);
        expect(text, `${provider} ${model}`).toContain(`\`${quoted}\``);
      }
    }
    expect(text).toContain('| Anthropic |');
    expect(text).toContain('| OpenAI |');
  });

  it('quotes the key, question, tool-call, history and tool-result limits', () => {
    expect(text).toContain(`${String(AI_PROVIDER_KEY_MIN_LENGTH)} to ${String(AI_PROVIDER_KEY_MAX_LENGTH)} printable characters`);
    expect(text).toContain(`at most ${String(AI_QUESTION_MAX_LENGTH)} characters`);
    expect(text).toContain(`at most ${String(AI_MAX_TOOL_CALLS_PER_MESSAGE)} tool calls`);
    expect(text).toContain(`at most ${String(DEFAULT_HISTORY_LIMITS.maxMessages)} messages`);
    expect(text).toContain(`capped at ${String(AI_TOOL_RESULT_MAX_BYTES / 1024)} KiB, with log reads capped at ${String(AI_TOOL_LOG_MAX_LINES)} lines`);
  });

  it('lists exactly the read-only tool set', () => {
    const named = [...ai.matchAll(/`(get_[a-z_]+|list_[a-z_]+)`/g)].map((m) => m[1]);
    expect(new Set(named)).toEqual(new Set(AI_TOOL_NAMES));
  });

  it('documents what is sent, the read-only guarantee and its backend enforcement', () => {
    for (const needle of [
      '## What is sent to the provider',
      '## How read-only is enforced',
      'enforced by the panel, not by asking the model',
      '`<secret:name>`',
      'Secret values are never read by any tool',
      'provider key itself',
      'encrypted at rest',
    ]) {
      expect(text, needle).toContain(needle);
    }
  });

  it('lists every v0.5 AI error code and the conversation errors', () => {
    const rows = new Set([...ai.matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]));
    for (const code of V05_SERVICE_ERROR_CODES.filter((c) => c.startsWith('AI_'))) expect(rows.has(code), code).toBe(true);
    for (const { code } of AI_CONVERSATION_ERRORS) expect(rows.has(code), code).toBe(true);
    expect(rows.has('AI_PROVIDER_INPUT_INVALID')).toBe(true);
  });
});

describe('every new page', () => {
  it('only names error codes the API really returns', () => {
    const allowed = new Set<string>([...METRIC_NAMES, ...GRAPH_RELATION_TYPES, ...METRICS_ENV_KNOBS]);
    for (const [name, page] of Object.entries({ metrics, logs, graph, ai })) {
      for (const code of codesIn(page).filter((c) => !allowed.has(c))) {
        expect(isRealCode(code), `${name}: ${code} is not an API error code`).toBe(true);
      }
    }
  });

  it('promises no later release', () => {
    for (const page of [metrics, logs, graph, ai]) expect(page).not.toMatch(/coming soon|until v0\.\d|in a future release/i);
  });
});

describe('reference pages', () => {
  it('variables.mdx lists both metrics knobs with their real defaults and bounds', () => {
    expect(METRICS_ENV_KNOBS).toEqual(['NOODARA_METRICS_INTERVAL_MS', 'NOODARA_METRICS_RETENTION_HOURS']);
    expect(variables).toContain(`| \`NOODARA_METRICS_INTERVAL_MS\` | \`${String(METRICS_INTERVAL_MS)}\` (${String(METRICS_INTERVAL_MS / 1000)} seconds) |`);
    expect(variables).toContain(`${String(INTERVAL_RANGE.min)} to ${String(INTERVAL_RANGE.max)}. |`);
    expect(variables).toContain(`| \`NOODARA_METRICS_RETENTION_HOURS\` | \`${String(METRICS_RETENTION_HOURS)}\` (${String(METRICS_RETENTION_HOURS / 24)} days) |`);
    expect(variables).toContain(`${String(RETENTION_RANGE.min)} to ${String(RETENTION_RANGE.max)}. |`);
  });

  it('error-codes.mdx carries every v0.5 code with its real status and message', () => {
    for (const code of V05_SERVICE_ERROR_CODES) {
      expect(errorCodes).toContain(`| \`${code}\` | ${String(SERVICE_ERROR_STATUS[code])} | ${V05_ERROR_MESSAGES[code]} |`);
    }
  });

  it('error-codes.mdx carries the AI conversation and settings codes with their real status', () => {
    expect(AI_CONVERSATION_ERRORS.length).toBe(5);
    for (const { code, status } of AI_CONVERSATION_ERRORS) {
      expect(errorCodes).toMatch(new RegExp(`^\\| \`${code}\` \\| ${String(status)} \\|`, 'm'));
    }
    expect(errorCodes).toContain(`| \`AI_PROVIDER_INPUT_INVALID\` | ${String(AI_PROVIDER_INPUT_INVALID_STATUS)} |`);
    expect(errorCodes).toContain(`limited to ${String(AI_QUESTION_MAX_LENGTH)} characters`);
  });
});
