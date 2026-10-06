import type { DeploymentLogPhase } from '@noodara/domain/deployment';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildLogCapMarker,
  buildLogText,
  createBuildLogState,
  DEFAULT_BUILD_LOG_LIMITS,
  foldBuildLog,
  type BuildLogInput,
  type BuildLogLimits,
  type BuildLogState,
} from './build-log';

const DEPLOYMENT = 'dep_1';
const PHASES: readonly DeploymentLogPhase[] = ['prepare', 'build', 'deploy'];

interface Chunk {
  readonly phase: DeploymentLogPhase;
  readonly seq: number;
  readonly text: string;
}

function event(
  phase: DeploymentLogPhase,
  seq: number,
  text: string,
  truncated = false,
): BuildLogInput {
  return {
    kind: 'event',
    event: {
      type: 'deployment.log_chunk',
      deploymentId: DEPLOYMENT,
      phase,
      seq,
      text,
      truncated,
    },
  };
}

function page(
  after: { phase: DeploymentLogPhase; since: number },
  items: readonly Chunk[],
  hasMore = false,
): BuildLogInput {
  return {
    kind: 'page',
    after,
    items: items.map((item) => ({
      ...item,
      byteLength: item.text.length,
      createdAt: '2026-10-06T00:00:00.000Z',
    })),
    hasMore,
  };
}

function fold(
  inputs: readonly BuildLogInput[],
  limits: Partial<BuildLogLimits> = {},
): BuildLogState {
  return inputs.reduce(foldBuildLog, createBuildLogState(DEPLOYMENT, limits));
}

describe('foldBuildLog: order and duplicates (A1)', () => {
  it('starts empty with no resync and the server phase cap', () => {
    const state = createBuildLogState(DEPLOYMENT);
    expect(buildLogText(state)).toBe('');
    expect(state.resync).toBeNull();
    expect(state.limits.maxPhaseBytes).toBe(10 * 1024 * 1024);
    expect(DEFAULT_BUILD_LOG_LIMITS.maxPhaseBytes).toBe(10 * 1024 * 1024);
  });

  it('shows contiguous SSE chunks of a phase as they arrive', () => {
    const state = fold([event('prepare', 1, 'a\n'), event('prepare', 2, 'b\n')]);
    expect(buildLogText(state)).toBe('a\nb\n');
    expect(state.cursor).toEqual({ phase: 'prepare', seq: 2 });
    expect(state.resync).toBeNull();
  });

  it('orders a page by phase then seq, crossing phases through page links', () => {
    const state = fold([
      page({ phase: 'prepare', since: 0 }, [
        { phase: 'prepare', seq: 1, text: 'p1 ' },
        { phase: 'build', seq: 1, text: 'b1 ' },
        { phase: 'build', seq: 2, text: 'b2 ' },
        { phase: 'deploy', seq: 1, text: 'd1' },
      ]),
    ]);
    expect(buildLogText(state)).toBe('p1 b1 b2 d1');
    expect(state.segments.map((segment) => segment.phase)).toEqual(['prepare', 'build', 'deploy']);
    expect(state.resync).toBeNull();
  });

  it('drops duplicates from SSE and overlapping pages', () => {
    const state = fold([
      event('prepare', 1, 'a'),
      event('prepare', 1, 'a'),
      page({ phase: 'prepare', since: 0 }, [
        { phase: 'prepare', seq: 1, text: 'a' },
        { phase: 'prepare', seq: 2, text: 'b' },
      ]),
      event('prepare', 2, 'b'),
    ]);
    expect(buildLogText(state)).toBe('ab');
  });

  it('never trusts an SSE phase change alone: it buffers and asks to resync at the cursor', () => {
    const state = fold([event('prepare', 1, 'p1'), event('build', 1, 'b1')]);
    expect(buildLogText(state)).toBe('p1');
    expect(state.resync).toEqual({ phase: 'prepare', since: 1 });
    const resolved = foldBuildLog(
      state,
      page({ phase: 'prepare', since: 1 }, [{ phase: 'build', seq: 1, text: 'b1' }]),
    );
    expect(buildLogText(resolved)).toBe('p1b1');
    expect(resolved.resync).toBeNull();
    expect(resolved.links.size).toBe(0);
  });
});

describe('foldBuildLog: gaps and resync (A2)', () => {
  it('marks a seq gap with the exact cursor and fills it from GET', () => {
    const gapped = fold([event('prepare', 1, 'a'), event('prepare', 3, 'c')]);
    expect(buildLogText(gapped)).toBe('a');
    expect(gapped.resync).toEqual({ phase: 'prepare', since: 1 });
    const filled = foldBuildLog(
      gapped,
      page({ phase: 'prepare', since: 1 }, [
        { phase: 'prepare', seq: 2, text: 'b' },
        { phase: 'prepare', seq: 3, text: 'c' },
      ]),
    );
    expect(buildLogText(filled)).toBe('abc');
    expect(filled.resync).toBeNull();
    expect(filled.pending.size).toBe(0);
  });

  it('asks from the start when the first chunk seen is not the first one', () => {
    const state = fold([event('prepare', 2, 'b')]);
    expect(state.resync).toEqual({ phase: 'prepare', since: 0 });
  });

  it('ignores a chunk older than the cursor (no replay)', () => {
    const state = fold([
      event('prepare', 1, 'a'),
      event('prepare', 2, 'b'),
      event('prepare', 1, 'REPLAY'),
    ]);
    expect(buildLogText(state)).toBe('ab');
    expect(state.resync).toBeNull();
  });

  it('keeps paging while the server says there is more at the frontier', () => {
    const first = fold([
      page({ phase: 'prepare', since: 0 }, [{ phase: 'prepare', seq: 1, text: 'a' }], true),
    ]);
    expect(first.resync).toEqual({ phase: 'prepare', since: 1 });
    const second = foldBuildLog(
      first,
      page({ phase: 'prepare', since: 1 }, [{ phase: 'build', seq: 1, text: 'b' }]),
    );
    expect(buildLogText(second)).toBe('ab');
    expect(second.resync).toBeNull();
    expect(second.moreAfter).toBeNull();
  });

  it('a stale hasMore page behind the cursor does not ask again', () => {
    const state = fold([
      page({ phase: 'prepare', since: 1 }, [{ phase: 'prepare', seq: 2, text: 'b' }]),
      page({ phase: 'prepare', since: 0 }, [{ phase: 'prepare', seq: 1, text: 'a' }], true),
    ]);
    expect(buildLogText(state)).toBe('ab');
    expect(state.resync).toBeNull();
  });
});

describe('foldBuildLog: truncated SSE chunks (A3)', () => {
  it('shows a cut chunk, asks for it in full and replaces it in place', () => {
    const cut = fold([
      event('prepare', 1, 'a'),
      event('prepare', 2, 'bb', true),
      event('prepare', 3, 'c'),
    ]);
    expect(buildLogText(cut)).toBe('abbc');
    expect(cut.resync).toEqual({ phase: 'prepare', since: 1 });
    const full = foldBuildLog(
      cut,
      page({ phase: 'prepare', since: 1 }, [
        { phase: 'prepare', seq: 2, text: 'bbBBBB' },
        { phase: 'prepare', seq: 3, text: 'c' },
      ]),
    );
    expect(buildLogText(full)).toBe('abbBBBBc');
    expect(full.resync).toBeNull();
    expect(full.phaseBytes.prepare).toBe(8);
  });

  it('a cut chunk after a page-linked phase change resyncs from the chunk before it', () => {
    const state = fold([
      page({ phase: 'prepare', since: 0 }, [
        { phase: 'prepare', seq: 1, text: 'p' },
        { phase: 'build', seq: 1, text: 'b' },
      ]),
      event('build', 2, 'x', true),
    ]);
    expect(buildLogText(state)).toBe('pbx');
    expect(state.resync).toEqual({ phase: 'build', since: 1 });
  });

  it('keeps the full chunk when the cut one arrives after it, buffered or shown', () => {
    const buffered = fold([
      page({ phase: 'prepare', since: 1 }, [{ phase: 'prepare', seq: 2, text: 'FULL' }]),
      event('prepare', 2, 'FU', true),
      event('prepare', 1, 'a'),
    ]);
    expect(buildLogText(buffered)).toBe('aFULL');
    const shown = foldBuildLog(buffered, event('prepare', 2, 'FU', true));
    expect(buildLogText(shown)).toBe('aFULL');
  });

  it('upgrades a buffered cut chunk when the full one arrives', () => {
    const state = fold([
      event('prepare', 2, 'FU', true),
      page({ phase: 'prepare', since: 0 }, [
        { phase: 'prepare', seq: 1, text: 'a' },
        { phase: 'prepare', seq: 2, text: 'FULL' },
      ]),
    ]);
    expect(buildLogText(state)).toBe('aFULL');
    expect(state.resync).toBeNull();
  });

  it('a cut chunk replayed by SSE does not replace the shown cut one', () => {
    const state = fold([event('prepare', 1, 'ab', true), event('prepare', 1, 'a', true)]);
    expect(buildLogText(state)).toBe('ab');
  });

  it('stops keeping cut chunks replaceable past maxReplaceable', () => {
    const state = fold([event('prepare', 1, 'a', true), event('prepare', 2, 'b', true)], {
      maxReplaceable: 1,
    });
    expect(state.segments.filter((segment) => segment.replaceKey !== null)).toHaveLength(1);
    expect(buildLogText(state)).toBe('ab');
  });

  it('a cut chunk with empty text is not kept replaceable', () => {
    const state = fold([event('prepare', 1, '', true)]);
    expect(state.segments).toHaveLength(0);
    expect(state.resync).toBeNull();
  });
});

// --- A4: property-style convergence ----------------------------------------------------------

function prng(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value + 0x6d2b79f5) >>> 0;
    let t = value;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ALPHABET = ['a', 'b', 'Z', ' ', '\n', 'é', '日', '🚀', '\u001b[31m', '<b>'];

function randomText(random: () => number): string {
  const length = 1 + Math.floor(random() * 8);
  let text = '';
  for (let i = 0; i < length; i += 1)
    text += ALPHABET[Math.floor(random() * ALPHABET.length)] ?? 'x';
  return text;
}

function shuffle<T>(items: T[], random: () => number): T[] {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    const a = items[i] as T;
    items[i] = items[j] as T;
    items[j] = a;
  }
  return items;
}

function scenario(seed: number): {
  inputs: BuildLogInput[];
  expected: string;
  full: Map<string, string>;
} {
  const random = prng(seed);
  const chunks: Chunk[] = [];
  for (const phase of PHASES) {
    const count = Math.floor(random() * 6);
    for (let seq = 1; seq <= count; seq += 1) chunks.push({ phase, seq, text: randomText(random) });
  }
  const inputs: BuildLogInput[] = [];
  for (const chunk of chunks) {
    if (random() < 0.7) {
      const cut = random() < 0.3;
      const text = cut
        ? Array.from(chunk.text)
            .slice(0, Math.max(1, Math.floor(chunk.text.length / 2)))
            .join('')
        : chunk.text;
      inputs.push(event(chunk.phase, chunk.seq, text, cut));
      if (random() < 0.2) inputs.push(event(chunk.phase, chunk.seq, text, cut));
    }
  }
  let after = { phase: 'prepare' as DeploymentLogPhase, since: 0 };
  let index = 0;
  do {
    const size = 1 + Math.floor(random() * 4);
    const items = chunks.slice(index, index + size);
    index += items.length;
    inputs.push(page(after, items, index < chunks.length));
    const last = items.at(-1);
    if (last !== undefined) after = { phase: last.phase, since: last.seq };
  } while (index < chunks.length);
  return {
    inputs: shuffle(inputs, random),
    expected: chunks.map((chunk) => chunk.text).join(''),
    full: new Map(chunks.map((chunk) => [`${chunk.phase}:${String(chunk.seq)}`, chunk.text])),
  };
}

describe('foldBuildLog: arrival order does not matter (A4)', () => {
  it('converges to the same text for 300 shuffled scenarios, only ever extending shown text', () => {
    for (let seed = 1; seed <= 300; seed += 1) {
      const { inputs, expected, full } = scenario(seed);
      let state = createBuildLogState(DEPLOYMENT);
      for (const input of inputs) {
        state = foldBuildLog(state, input);
        // Nothing shown is ever reordered: with each cut chunk read as its full text, the shown
        // text is a prefix of the final one, and a cut chunk only ever shows a prefix of itself.
        const expanded = state.segments.map((segment) => {
          if (segment.replaceKey === null) return segment.text;
          const whole = full.get(segment.replaceKey) ?? '';
          expect(whole.startsWith(segment.text)).toBe(true);
          return whole;
        });
        expect(expected.startsWith(expanded.join('')), `seed ${String(seed)}`).toBe(true);
      }
      expect(buildLogText(state), `seed ${String(seed)}`).toBe(expected);
      expect(state.resync, `seed ${String(seed)}`).toBeNull();
      expect(state.pending.size).toBe(0);
      expect(state.links.size).toBe(0);
    }
  });

  it('converges regardless of order for the same inputs', () => {
    const { inputs, expected } = scenario(42);
    for (let seed = 1; seed <= 50; seed += 1) {
      const state = fold(shuffle([...inputs], prng(seed)));
      expect(buildLogText(state)).toBe(expected);
    }
  });
});

// --- H1: bounded --------------------------------------------------------------------------------

describe('foldBuildLog: bounded (H1)', () => {
  it('caps shown text per phase with one visible marker and drops the rest of the phase', () => {
    const state = fold(
      [
        event('prepare', 1, 'x'.repeat(20)),
        event('prepare', 2, 'y'.repeat(20)),
        event('prepare', 3, 'z'.repeat(20)),
        page({ phase: 'prepare', since: 3 }, [{ phase: 'build', seq: 1, text: 'b' }]),
      ],
      { maxPhaseBytes: 32 },
    );
    const marker = buildLogCapMarker('prepare', 32);
    expect(buildLogText(state)).toBe(`${'x'.repeat(20)}${'y'.repeat(12)}${marker}b`);
    expect(state.phaseBytes.prepare).toBe(32);
    expect(state.cappedPhases.has('prepare')).toBe(true);
    expect(state.cursor).toEqual({ phase: 'build', seq: 1 });
    expect(marker).toContain('32 bytes');
  });

  it('cuts at the cap on a code point boundary', () => {
    const state = fold([event('prepare', 1, 'ab🚀')], { maxPhaseBytes: 4 });
    expect(buildLogText(state).startsWith('ab\n[noodara]')).toBe(true);
  });

  it('names the default cap in MiB', () => {
    expect(buildLogCapMarker('build', 10 * 1024 * 1024)).toContain(
      '"build" exceeds the 10 MiB view limit',
    );
  });

  it('keeps the cut text when its full text no longer fits the phase cap', () => {
    const state = fold(
      [
        event('prepare', 1, 'ab', true),
        event('prepare', 2, 'cd'),
        page({ phase: 'prepare', since: 0 }, [{ phase: 'prepare', seq: 1, text: 'ab'.repeat(10) }]),
      ],
      { maxPhaseBytes: 8 },
    );
    expect(buildLogText(state)).toBe('abcd');
    expect(state.resync).toBeNull();
    expect(state.phaseBytes.prepare).toBe(4);
  });

  it('bounds the buffer under a flood of chunks ahead of a gap', () => {
    let state = createBuildLogState(DEPLOYMENT, { maxPendingChunks: 64 });
    for (let seq = 2; seq <= 5000; seq += 1) state = foldBuildLog(state, event('build', seq, 'x'));
    expect(state.pending.size).toBeLessThanOrEqual(64);
    expect(state.pending.has('build:2')).toBe(true);
    expect(state.pending.has('build:5000')).toBe(false);
    expect(buildLogText(state)).toBe('');
  });

  it('bounds the buffer by bytes', () => {
    let state = createBuildLogState(DEPLOYMENT, { maxPendingBytes: 100 });
    for (let seq = 2; seq <= 50; seq += 1)
      state = foldBuildLog(state, event('prepare', seq, 'y'.repeat(30)));
    expect(state.pendingBytes).toBeLessThanOrEqual(100);
    expect(state.pending.size).toBe(3);
  });

  it('a gap that never resolves stops asking after maxResyncMisses empty pages', () => {
    let state = fold([event('prepare', 1, 'a'), event('prepare', 3, 'c')]);
    const empty = page({ phase: 'prepare', since: 1 }, []);
    let requests = 0;
    for (let i = 0; i < 20 && state.resync !== null; i += 1) {
      requests += 1;
      state = foldBuildLog(state, empty);
    }
    expect(requests).toBe(DEFAULT_BUILD_LOG_LIMITS.maxResyncMisses);
    expect(state.stalled).toBe(true);
    expect(state.resync).toBeNull();
    // SSE without progress keeps it stalled; progress resumes resync.
    state = foldBuildLog(state, event('prepare', 5, 'e'));
    expect(state.resync).toBeNull();
    state = foldBuildLog(state, event('prepare', 2, 'b'));
    expect(buildLogText(state)).toBe('abc');
    expect(state.stalled).toBe(false);
    expect(state.resync).toEqual({ phase: 'prepare', since: 3 });
  });

  it('drops malformed input without throwing', () => {
    const base = fold([event('prepare', 1, 'a')]);
    const malformed: unknown[] = [
      null,
      'text',
      {
        type: 'deployment.log_chunk',
        deploymentId: DEPLOYMENT,
        phase: 'prepare',
        seq: -1,
        text: 'x',
      },
      {
        type: 'deployment.log_chunk',
        deploymentId: DEPLOYMENT,
        phase: 'prepare',
        seq: 2.5,
        text: 'x',
      },
      {
        type: 'deployment.log_chunk',
        deploymentId: DEPLOYMENT,
        phase: 'prepare',
        seq: Number.NaN,
        text: 'x',
      },
      {
        type: 'deployment.log_chunk',
        deploymentId: DEPLOYMENT,
        phase: 'prepare',
        seq: '2',
        text: 'x',
      },
      {
        type: 'deployment.log_chunk',
        deploymentId: DEPLOYMENT,
        phase: 'prepare',
        seq: 0,
        text: 'x',
      },
      {
        type: 'deployment.log_chunk',
        deploymentId: DEPLOYMENT,
        phase: 'prepare',
        seq: 2 ** 40,
        text: 'x',
      },
      {
        type: 'deployment.log_chunk',
        deploymentId: DEPLOYMENT,
        phase: 'teardown',
        seq: 2,
        text: 'x',
      },
      {
        type: 'deployment.log_chunk',
        deploymentId: DEPLOYMENT,
        phase: 'prepare',
        seq: 2,
        text: 42,
      },
      {
        type: 'deployment.log_chunk',
        deploymentId: 'other',
        phase: 'prepare',
        seq: 2,
        text: 'x',
      },
      {
        type: 'service.updated',
        deploymentId: DEPLOYMENT,
        phase: 'prepare',
        seq: 2,
        text: 'x',
      },
    ];
    let state = base;
    for (const bad of malformed) state = foldBuildLog(state, { kind: 'event', event: bad });
    state = foldBuildLog(state, {
      kind: 'page',
      after: { phase: 'prepare', since: 1 },
      items: [null, 7],
      hasMore: false,
    });
    state = foldBuildLog(state, {
      kind: 'page',
      after: null,
      items: 'nope',
      hasMore: 'yes',
    } as unknown as BuildLogInput);
    state = foldBuildLog(state, { kind: 'bogus' } as unknown as BuildLogInput);
    expect(buildLogText(state)).toBe('a');
    expect(state.pending.size).toBe(0);
    expect(state.resync).toBeNull();
  });

  it('a malformed page item breaks the link chain instead of bridging it', () => {
    const state = fold([
      {
        kind: 'page',
        after: { phase: 'prepare', since: 0 },
        items: [
          { phase: 'prepare', seq: 1, text: 'a' },
          { phase: 'prepare', seq: -4, text: 'bad' },
          { phase: 'build', seq: 1, text: 'b' },
        ],
        hasMore: false,
      },
    ]);
    expect(buildLogText(state)).toBe('a');
    expect(state.resync).toEqual({ phase: 'prepare', since: 1 });
  });

  it('a page with a malformed cursor does not link its first item', () => {
    const state = fold([
      {
        kind: 'page',
        after: { phase: 'nope', since: 0 },
        items: [{ phase: 'build', seq: 1, text: 'b' }],
        hasMore: false,
      } as unknown as BuildLogInput,
    ]);
    expect(buildLogText(state)).toBe('');
    expect(state.resync).toEqual({ phase: 'prepare', since: 0 });
  });

  it('ignores out-of-order items inside a page for linking', () => {
    const state = fold([
      page({ phase: 'prepare', since: 0 }, [
        { phase: 'build', seq: 1, text: 'b' },
        { phase: 'prepare', seq: 1, text: 'a' },
      ]),
    ]);
    expect(buildLogText(state)).toBe('a');
    expect(state.resync).toEqual({ phase: 'prepare', since: 1 });
  });

  it('returns a new state and leaves the previous one untouched', () => {
    const before = fold([event('prepare', 1, 'a')]);
    const after = foldBuildLog(before, event('prepare', 2, 'b'));
    expect(buildLogText(before)).toBe('a');
    expect(buildLogText(after)).toBe('ab');
  });
});

// --- H2: inert text -----------------------------------------------------------------------------

describe('foldBuildLog: log text is inert data (H2)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('preserves escape sequences, markup and canary strings verbatim and logs nothing', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const hostile = [
      '\u001b[31mred\u001b[0m \u001b]0;title\u0007 \r\n',
      '<script>alert(1)</script><img src=x onerror=alert(1)>',
      'NOODARA_CANARY_ghp_0123456789abcdefABCDEF0123456789abcd',
    ];
    const state = fold([
      event('prepare', 1, hostile[0] ?? ''),
      page({ phase: 'prepare', since: 1 }, [
        { phase: 'prepare', seq: 2, text: hostile[1] ?? '' },
        { phase: 'build', seq: 1, text: hostile[2] ?? '' },
      ]),
    ]);
    expect(buildLogText(state)).toBe(hostile.join(''));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
