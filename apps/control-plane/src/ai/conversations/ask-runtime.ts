// 28-05 (A3, H1, H2): process-level state of the AI ask route. One in-flight ask per conversation
// (the DB pending check backs it up across processes), a per-user question rate limit, a count of
// in-flight provider requests, and closeAll() so shutdown aborts every open stream.
import type { AIChatRequest, AIProvider, AIStreamRequest, AIToolCallRequest } from '@noodara/ai';

export interface AiRateLimit {
  readonly max: number;
  readonly windowMs: number;
}

export const DEFAULT_AI_RATE_LIMIT: AiRateLimit = Object.freeze({ max: 10, windowMs: 60_000 });

export type RateDecision = { readonly ok: true } | { readonly ok: false; readonly retryAfterMs: number };

export interface AskSlot {
  readonly signal: AbortSignal;
  abort(reason: AskAbortReason): void;
  /** Why the slot was aborted, or null while it runs. */
  readonly reason: AskAbortReason | null;
  /** Marks the ask settled and frees the conversation. Idempotent. */
  release(): void;
}

export type AskAbortReason = 'client_gone' | 'timeout' | 'deleted' | 'shutdown';

export interface AiAskRuntime {
  /** Counts one question for `userId`; refuses past the limit in the sliding window. */
  takeQuestion(userId: string, nowMs: number): RateDecision;
  /** Claims the conversation for one ask; null when one is already running here. */
  acquire(conversationId: string): AskSlot | null;
  isBusy(conversationId: string): boolean;
  /** Aborts the running ask of a conversation (it is being deleted) and waits for it to settle. */
  abortConversation(conversationId: string, reason: AskAbortReason, waitMs?: number): Promise<void>;
  /** Wraps a provider so every request it makes is counted while in flight. */
  track(provider: AIProvider): AIProvider;
  inFlightProviderRequests(): number;
  activeAsks(): number;
  /** Aborts every running ask and waits (bounded) for them to settle. */
  closeAll(waitMs?: number): Promise<void>;
}

const DEFAULT_SETTLE_WAIT_MS = 5_000;

export function createAiAskRuntime(options: { readonly rateLimit?: Partial<AiRateLimit> } = {}): AiAskRuntime {
  const rateLimit: AiRateLimit = { ...DEFAULT_AI_RATE_LIMIT, ...options.rateLimit };
  const questions = new Map<string, number[]>();
  const slots = new Map<string, { slot: AskSlot; settled: Promise<void> }>();
  let providerRequests = 0;

  async function waitSettled(settled: readonly Promise<void>[], waitMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, waitMs);
      timer.unref();
    });
    try {
      await Promise.race([Promise.all(settled).then(() => undefined), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  function counted<T>(work: () => Promise<T>): Promise<T> {
    providerRequests += 1;
    let promise: Promise<T>;
    try {
      promise = work();
    } catch (error) {
      providerRequests -= 1;
      throw error;
    }
    return promise.finally(() => {
      providerRequests -= 1;
    });
  }

  return {
    takeQuestion(userId, nowMs) {
      const since = nowMs - rateLimit.windowMs;
      const recent = (questions.get(userId) ?? []).filter((at) => at > since);
      if (recent.length >= rateLimit.max) {
        questions.set(userId, recent);
        const oldest = recent[0] ?? nowMs;
        return { ok: false, retryAfterMs: Math.max(1, oldest + rateLimit.windowMs - nowMs) };
      }
      recent.push(nowMs);
      questions.set(userId, recent);
      return { ok: true };
    },

    acquire(conversationId) {
      if (slots.has(conversationId)) return null;
      const controller = new AbortController();
      let reason: AskAbortReason | null = null;
      let resolveSettled!: () => void;
      const settled = new Promise<void>((resolve) => {
        resolveSettled = resolve;
      });
      let released = false;
      const slot: AskSlot = {
        signal: controller.signal,
        get reason() {
          return reason;
        },
        abort(why) {
          if (controller.signal.aborted) return;
          reason = why;
          controller.abort();
        },
        release() {
          if (released) return;
          released = true;
          if (slots.get(conversationId)?.slot === slot) slots.delete(conversationId);
          resolveSettled();
        },
      };
      slots.set(conversationId, { slot, settled });
      return slot;
    },

    isBusy: (conversationId) => slots.has(conversationId),

    async abortConversation(conversationId, reason, waitMs = DEFAULT_SETTLE_WAIT_MS) {
      const entry = slots.get(conversationId);
      if (entry === undefined) return;
      entry.slot.abort(reason);
      await waitSettled([entry.settled], waitMs);
    },

    track(provider) {
      return {
        id: provider.id,
        model: provider.model,
        chat: (request: AIChatRequest) => counted(() => provider.chat(request)),
        toolCall: (request: AIToolCallRequest) => counted(() => provider.toolCall(request)),
        stream: (request: AIStreamRequest) =>
          (async function* () {
            providerRequests += 1;
            try {
              yield* provider.stream(request);
            } finally {
              providerRequests -= 1;
            }
          })(),
      };
    },

    inFlightProviderRequests: () => providerRequests,
    activeAsks: () => slots.size,

    async closeAll(waitMs = DEFAULT_SETTLE_WAIT_MS) {
      const entries = [...slots.values()];
      for (const { slot } of entries) slot.abort('shutdown');
      await waitSettled(
        entries.map((entry) => entry.settled),
        waitMs,
      );
    },
  };
}
