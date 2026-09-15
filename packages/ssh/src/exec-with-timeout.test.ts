// Fake-timer, fake-channel unit tests for the per-command timeout/redaction/truncation wrapper
// (SEC-04, SEC-05, D-08). This is the one module in the phase where a fake channel/client is the
// right test double: the behaviour under test here is timer and stream mechanics, not connection
// outcomes — 02-RESEARCH.md's "no mocked Client for connection-outcome scenarios" rule is about
// connection outcomes, which plans 02-08 and 02-10 cover against real Testcontainers-backed
// fixtures. No test in this file waits real wall-clock time; every timing assertion advances
// Vitest's injected fake timers instead.
import { createRedactor } from '@noodara/domain/security';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { commandFor } from './commands/index.js';
import { classifySshError } from './error-classifier.js';
import { CommandTimeoutError, TransportClosedError } from './errors.js';
import { execWithTimeout, MAX_OUTPUT_BYTES, type ExecChannel } from './exec-with-timeout.js';

class FakeChannel implements ExecChannel {
  readonly dataListeners: ((chunk: Buffer) => void)[] = [];
  readonly closeListeners: ((code: number | null, signal?: string) => void)[] = [];
  readonly errorListeners: ((err: Error) => void)[] = [];
  readonly stderrDataListeners: ((chunk: Buffer) => void)[] = [];
  destroyCalls = 0;

  readonly stderr = {
    on: (_event: 'data', listener: (chunk: Buffer) => void): void => {
      this.stderrDataListeners.push(listener);
    },
  };

  on(event: 'data', listener: (chunk: Buffer) => void): void;
  on(event: 'close', listener: (code: number | null, signal?: string) => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  on(
    event: 'data' | 'close' | 'error',
    listener:
      | ((chunk: Buffer) => void)
      | ((code: number | null, signal?: string) => void)
      | ((err: Error) => void),
  ): void {
    if (event === 'data') {
      this.dataListeners.push(listener as (chunk: Buffer) => void);
    } else if (event === 'close') {
      this.closeListeners.push(listener as (code: number | null, signal?: string) => void);
    } else {
      this.errorListeners.push(listener as (err: Error) => void);
    }
  }

  destroy(): void {
    this.destroyCalls += 1;
  }

  emitData(chunk: Buffer): void {
    for (const listener of this.dataListeners) listener(chunk);
  }

  emitStderrData(chunk: Buffer): void {
    for (const listener of this.stderrDataListeners) listener(chunk);
  }

  emitClose(code: number | null): void {
    for (const listener of this.closeListeners) listener(code);
  }

  emitError(err: Error): void {
    for (const listener of this.errorListeners) listener(err);
  }
}

class FakeClient {
  execCommand: string | undefined;
  execCalls = 0;
  readonly end = vi.fn();
  readonly destroy = vi.fn();
  private resultCallback: ((err: Error | undefined, channel: ExecChannel) => void) | undefined;

  exec(command: string, callback: (err: Error | undefined, channel: ExecChannel) => void): void {
    this.execCommand = command;
    this.execCalls += 1;
    this.resultCallback = callback;
  }

  triggerChannel(channel: ExecChannel): void {
    this.resultCallback?.(undefined, channel);
  }

  triggerError(err: Error): void {
    this.resultCallback?.(err, new FakeChannel());
  }
}

const TIMEOUT_MS = 30_000;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('execWithTimeout — success path', () => {
  it('resolves with an ExecResult carrying stdout, stderr, exit code and duration when the channel closes within budget', async () => {
    const client = new FakeClient();
    const channel = new FakeChannel();
    const redactor = createRedactor();

    const resultPromise = execWithTimeout({
      client,
      commandName: 'discovery.hostname',
      timeoutMs: TIMEOUT_MS,
      redactor,
    });

    client.triggerChannel(channel);
    channel.emitData(Buffer.from('my-host\n'));
    channel.emitStderrData(Buffer.from(''));
    channel.emitClose(0);

    const result = await resultPromise;

    expect(result.commandName).toBe('discovery.hostname');
    expect(result.stdout).toBe('my-host\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the command string comes only from commandFor(name) — the raw allowlisted template is what reaches the fake client', async () => {
    const client = new FakeClient();
    const channel = new FakeChannel();
    const redactor = createRedactor();

    const resultPromise = execWithTimeout({
      client,
      commandName: 'discovery.hostname',
      timeoutMs: TIMEOUT_MS,
      redactor,
    });

    expect(client.execCommand).toBe(commandFor('discovery.hostname'));
    expect(client.execCalls).toBe(1);

    client.triggerChannel(channel);
    channel.emitClose(0);
    await resultPromise;
  });
});

describe('execWithTimeout — timeout path', () => {
  it('rejects with CommandTimeoutError and destroys only the channel, never the client, when the budget elapses first', async () => {
    const client = new FakeClient();
    const channel = new FakeChannel();
    const redactor = createRedactor();

    const resultPromise = execWithTimeout({
      client,
      commandName: 'discovery.disk',
      timeoutMs: TIMEOUT_MS,
      redactor,
    });
    client.triggerChannel(channel);

    vi.advanceTimersByTime(TIMEOUT_MS);

    await expect(resultPromise).rejects.toBeInstanceOf(CommandTimeoutError);
    await resultPromise.catch((err: unknown) => {
      expect(err).toBeInstanceOf(CommandTimeoutError);
      if (err instanceof CommandTimeoutError) {
        expect(err.commandName).toBe('discovery.disk');
        expect(err.timeoutMs).toBe(TIMEOUT_MS);
      }
    });

    expect(channel.destroyCalls).toBe(1);
    expect(client.end).not.toHaveBeenCalled();
    expect(client.destroy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('discards data arriving after the timeout has fired, leaving the settled rejection unchanged', async () => {
    const client = new FakeClient();
    const channel = new FakeChannel();
    const redactor = createRedactor();

    const resultPromise = execWithTimeout({
      client,
      commandName: 'discovery.disk',
      timeoutMs: TIMEOUT_MS,
      redactor,
    });
    client.triggerChannel(channel);
    vi.advanceTimersByTime(TIMEOUT_MS);

    // Late data/close events must not throw and must not change the already-settled outcome.
    expect(() => {
      channel.emitData(Buffer.from('too late'));
      channel.emitClose(0);
    }).not.toThrow();

    await expect(resultPromise).rejects.toBeInstanceOf(CommandTimeoutError);
  });

  it('destroys a channel that arrives from client.exec() after the timeout has already fired, and never crashes if it later errors (CR-01)', async () => {
    const client = new FakeClient();
    const redactor = createRedactor();

    const resultPromise = execWithTimeout({
      client,
      commandName: 'discovery.disk',
      timeoutMs: TIMEOUT_MS,
      redactor,
    });

    // No channel has been handed back yet when the timeout fires — client.exec()'s callback
    // resolves only afterward, exactly the late-arrival race CR-01 covers.
    vi.advanceTimersByTime(TIMEOUT_MS);
    await expect(resultPromise).rejects.toBeInstanceOf(CommandTimeoutError);

    const lateChannel = new FakeChannel();
    expect(() => {
      client.triggerChannel(lateChannel);
    }).not.toThrow();

    expect(lateChannel.destroyCalls).toBe(1);
    expect(() => {
      lateChannel.emitError(new Error('late channel blew up after being discarded'));
    }).not.toThrow();
  });

  it('clears the timer on the client.exec callback-error path, and rejects with the raw error', async () => {
    const client = new FakeClient();
    const redactor = createRedactor();
    const upstreamError = new Error('exec channel could not be opened');

    const resultPromise = execWithTimeout({
      client,
      commandName: 'discovery.disk',
      timeoutMs: TIMEOUT_MS,
      redactor,
    });
    client.triggerError(upstreamError);

    await expect(resultPromise).rejects.toBe(upstreamError);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('execWithTimeout — channel-level error (WR-01)', () => {
  it('rejects with TransportClosedError, never crashing, when the channel itself emits an unhandled error', async () => {
    const client = new FakeClient();
    const channel = new FakeChannel();
    const redactor = createRedactor();

    const resultPromise = execWithTimeout({
      client,
      commandName: 'discovery.disk',
      timeoutMs: TIMEOUT_MS,
      redactor,
    });
    client.triggerChannel(channel);

    expect(() => {
      channel.emitError(new Error('channel died unexpectedly'));
    }).not.toThrow();

    await expect(resultPromise).rejects.toBeInstanceOf(TransportClosedError);
  });

  it('classifies the channel-level error to CONNECTION_LOST via the same table mid-exec transport death uses', async () => {
    const client = new FakeClient();
    const channel = new FakeChannel();
    const redactor = createRedactor();

    const resultPromise = execWithTimeout({
      client,
      commandName: 'discovery.disk',
      timeoutMs: TIMEOUT_MS,
      redactor,
    });
    client.triggerChannel(channel);
    channel.emitError(new Error('channel died unexpectedly'));

    await resultPromise.catch((err: unknown) => {
      const failure = classifySshError(err, { phase: 'exec', redactor });
      expect(failure.errorCode).toBe('CONNECTION_LOST');
    });
  });

  it('ignores a channel-level error that arrives after the outcome has already settled', async () => {
    const client = new FakeClient();
    const channel = new FakeChannel();
    const redactor = createRedactor();

    const resultPromise = execWithTimeout({
      client,
      commandName: 'discovery.hostname',
      timeoutMs: TIMEOUT_MS,
      redactor,
    });
    client.triggerChannel(channel);
    channel.emitData(Buffer.from('my-host\n'));
    channel.emitClose(0);
    await resultPromise;

    expect(() => {
      channel.emitError(new Error('too late to matter'));
    }).not.toThrow();
  });
});

describe('execWithTimeout — redaction', () => {
  it('passes stdout and stderr through the injected Redactor before they appear in the resolved ExecResult', async () => {
    const client = new FakeClient();
    const channel = new FakeChannel();
    const redactor = createRedactor();
    const secret = 'super-secret-registered-value';
    redactor.register(secret, 'ssh_password');

    const resultPromise = execWithTimeout({
      client,
      commandName: 'discovery.hostname',
      timeoutMs: TIMEOUT_MS,
      redactor,
    });
    client.triggerChannel(channel);
    channel.emitData(Buffer.from(`output containing ${secret} inline`));
    channel.emitClose(0);

    const result = await resultPromise;

    expect(result.stdout).toContain('[REDACTED:ssh_password]');
    expect(result.stdout).not.toContain(secret);
  });
});

describe('execWithTimeout — 64 KB truncation', () => {
  it('truncates output larger than MAX_OUTPUT_BYTES per stream and marks truncated true', async () => {
    const client = new FakeClient();
    const channel = new FakeChannel();
    const redactor = createRedactor();

    const resultPromise = execWithTimeout({
      client,
      commandName: 'discovery.hostname',
      timeoutMs: TIMEOUT_MS,
      redactor,
    });
    client.triggerChannel(channel);
    channel.emitData(Buffer.alloc(MAX_OUTPUT_BYTES + 1, 'a'));
    channel.emitClose(0);

    const result = await resultPromise;

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
  });

  it('does not mark output truncated when it is exactly at the limit', async () => {
    const client = new FakeClient();
    const channel = new FakeChannel();
    const redactor = createRedactor();

    const resultPromise = execWithTimeout({
      client,
      commandName: 'discovery.hostname',
      timeoutMs: TIMEOUT_MS,
      redactor,
    });
    client.triggerChannel(channel);
    channel.emitData(Buffer.alloc(MAX_OUTPUT_BYTES, 'a'));
    channel.emitClose(0);

    const result = await resultPromise;

    expect(result.truncated).toBe(false);
    expect(Buffer.byteLength(result.stdout)).toBe(MAX_OUTPUT_BYTES);
  });

  it('never splits a multi-byte character into an invalid sequence when the limit falls mid-character', async () => {
    const client = new FakeClient();
    const channel = new FakeChannel();
    const redactor = createRedactor();

    // 'é' is 2 bytes in UTF-8 (0xC3 0xA9). Fill up to one byte short of the limit with ASCII,
    // then emit the 2-byte character so the cut falls exactly between its two bytes.
    const asciiPrefix = Buffer.alloc(MAX_OUTPUT_BYTES - 1, 'a');
    const multiByteChar = Buffer.from('é', 'utf8');
    expect(multiByteChar.length).toBe(2);

    const resultPromise = execWithTimeout({
      client,
      commandName: 'discovery.hostname',
      timeoutMs: TIMEOUT_MS,
      redactor,
    });
    client.triggerChannel(channel);
    channel.emitData(asciiPrefix);
    channel.emitData(multiByteChar);
    channel.emitClose(0);

    const result = await resultPromise;

    expect(result.truncated).toBe(true);
    expect(result.stdout).not.toContain('�');
    expect(Buffer.byteLength(result.stdout)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
  });

  it('truncates stderr independently of stdout', async () => {
    const client = new FakeClient();
    const channel = new FakeChannel();
    const redactor = createRedactor();

    const resultPromise = execWithTimeout({
      client,
      commandName: 'discovery.hostname',
      timeoutMs: TIMEOUT_MS,
      redactor,
    });
    client.triggerChannel(channel);
    channel.emitData(Buffer.from('short stdout'));
    channel.emitStderrData(Buffer.alloc(MAX_OUTPUT_BYTES + 100, 'e'));
    channel.emitClose(1);

    const result = await resultPromise;

    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.stderr)).toBeLessThanOrEqual(MAX_OUTPUT_BYTES);
    expect(result.stdout).toBe('short stdout');
  });
});
