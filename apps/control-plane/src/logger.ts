import { Writable } from 'node:stream';
import pino, { type DestinationStream, type Logger, type LoggerOptions } from 'pino';
import { env } from './env.js';

// pino `redact.paths` (STACK.md "Structured Logging & Redaction") plus the credential/master-key
// wildcards required by noodara-security §3/§8 and RESEARCH threat T-1-05. `req.headers.cookie`,
// `req.headers.authorization` and `req.body.password` are the pitfall-1-adjacent minimum; the
// `*.credential`/`*.encryptedCredential`/`*.masterKey` wildcards catch domain entities nested at
// any depth under an arbitrary parent key.
const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.body.password',
  'req.body.sshPassword',
  'req.body.sshPrivateKey',
  '*.credential',
  '*.encryptedCredential',
  '*.masterKey',
];

export interface CreateLoggerOptions {
  level?: string;
  destination?: DestinationStream;
}

export function createLogger(options: CreateLoggerOptions = {}): Logger {
  const loggerOptions: LoggerOptions = {
    level: options.level ?? env.LOG_LEVEL,
    redact: {
      paths: REDACT_PATHS,
      censor: '[REDACTED]',
    },
    // T-4-10/T-4-38: the single control that makes every `{ err }` call site in this codebase
    // safe by default — pino's own default `err` serializer includes `message` and `stack`,
    // which is exactly the leak 04-SECURITY.md found in `queue/connect-server-worker.ts`'s
    // `worker.on('failed', ...)` and `events/redis-server-event-publisher.ts` /
    // `events/sse-broadcaster.ts`'s warn logs. Only `name` survives; do not "helpfully" restore
    // `message`, `stack`, `cause` or `code` here, and do not add a per-call-site fix instead —
    // this option is what closes all three sites without editing any of them.
    serializers: {
      err: (e: unknown): { name: string } => ({
        name: e instanceof Error ? e.name : 'UnknownError',
      }),
    },
  };

  return options.destination ? pino(loggerOptions, options.destination) : pino(loggerOptions);
}

export interface TestLogCapture {
  stream: DestinationStream;
  records: () => unknown[];
}

/**
 * A pino destination stream tests can capture real emitted output from, so redaction is asserted
 * against what pino actually writes rather than against the `redact` config shape.
 */
export function writableForTests(): TestLogCapture {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });

  return {
    stream,
    records: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as unknown),
  };
}
