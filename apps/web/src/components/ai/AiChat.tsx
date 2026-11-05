'use client';

// 30-04: the read-only AI chat shown in the inspector. One conversation per open panel, created on
// the first question. Each question streams (askQuestion): tool names appear as they are consulted,
// then the structured answer replaces the streamed text. Closing the panel aborts the running ask.
// Questions and answers live only in component state: nothing is written to browser storage.
import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { Button, Textarea } from '@noodara/ui';
import {
  AI_QUESTION_MAX_LENGTH,
  askQuestion,
  createConversation,
  type AiAnswer,
  type AiToolCall,
  type AskEvent,
} from '../../lib/api/ai-api';
import { askErrorCopy, askFailureCopy, type AiErrorCopy } from './ai-copy';
import { AiAnswerView, ToolCallList } from './AiAnswerView';

type TurnStatus = 'pending' | 'complete' | 'failed' | 'aborted';

interface Turn {
  readonly id: number;
  readonly question: string;
  readonly status: TurnStatus;
  readonly text: string;
  readonly answer: AiAnswer | null;
  readonly toolCalls: readonly AiToolCall[];
  readonly error: AiErrorCopy | null;
}

export const AI_READ_ONLY_COPY = 'Read-only. The assistant can look at your infrastructure but never changes it.';
const MAX_STREAMED_TEXT = 16_000;

function applyEvent(turn: Turn, event: AskEvent): Turn {
  switch (event.type) {
    case 'text':
      return { ...turn, text: (turn.text + event.text).slice(0, MAX_STREAMED_TEXT) };
    case 'tool_call':
      return { ...turn, toolCalls: [...turn.toolCalls, event.call].slice(0, 16) };
    case 'answer':
      return { ...turn, answer: event.answer };
    case 'error':
      return { ...turn, error: askErrorCopy(event.code) };
    case 'done':
      return { ...turn, status: event.status };
    default:
      return turn;
  }
}

function ErrorBlock({ copy, onRetry }: { copy: AiErrorCopy; onRetry: () => void }): ReactNode {
  return (
    <div data-testid="ai-error" role="alert" className="flex flex-col items-start gap-2 rounded-[10px] bg-status-error-soft px-3 py-2">
      <p className="text-callout text-status-error-text">{copy.message}</p>
      {copy.action === 'settings' ? (
        <Link href="/settings" data-testid="ai-error-settings" className="text-callout font-medium text-accent-text hover:underline">
          Open Settings
        </Link>
      ) : null}
      {copy.action === 'retry' ? (
        <Button variant="secondary" onClick={onRetry} data-testid="ai-error-retry">
          Try again
        </Button>
      ) : null}
    </div>
  );
}

function TurnView({ turn, onRetry }: { turn: Turn; onRetry: (question: string) => void }): ReactNode {
  const retry = (): void => {
    onRetry(turn.question);
  };
  return (
    <li data-testid="ai-turn" data-status={turn.status} className="flex flex-col gap-3">
      <p data-testid="ai-question" className="self-end whitespace-pre-wrap break-words rounded-[12px] bg-surface-3 px-3 py-2 text-body text-ink">
        {turn.question}
      </p>
      {turn.answer !== null ? <AiAnswerView answer={turn.answer} toolCalls={turn.toolCalls} /> : null}
      {turn.answer === null && turn.text !== '' ? (
        <p data-testid="ai-streamed-text" className="whitespace-pre-wrap break-words text-body text-ink">
          {turn.text}
        </p>
      ) : null}
      {turn.status === 'pending' ? (
        <div data-testid="ai-pending" aria-live="polite" className="flex flex-col gap-1">
          <span className="text-callout text-ink-secondary">
            {turn.toolCalls.length === 0 ? 'Thinking…' : 'Consulting your infrastructure…'}
          </span>
          {turn.answer === null && turn.toolCalls.length > 0 ? <ToolCallList calls={turn.toolCalls} /> : null}
        </div>
      ) : null}
      {turn.status === 'aborted' && turn.error === null ? (
        <p data-testid="ai-stopped" className="text-callout text-ink-secondary">
          Stopped.
        </p>
      ) : null}
      {turn.error !== null ? <ErrorBlock copy={turn.error} onRetry={retry} /> : null}
    </li>
  );
}

export function AiChat(): ReactNode {
  const [turns, setTurns] = useState<readonly Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const conversationRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const nextIdRef = useRef(1);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' });
  }, [turns]);

  function update(id: number, change: (turn: Turn) => Turn): void {
    setTurns((all) => all.map((turn) => (turn.id === id ? change(turn) : turn)));
  }

  async function ask(question: string): Promise<void> {
    const trimmed = question.trim();
    if (trimmed === '' || busy) return;
    const id = nextIdRef.current++;
    setTurns((all) => [...all, { id, question: trimmed, status: 'pending', text: '', answer: null, toolCalls: [], error: null }]);
    setDraft('');
    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      if (conversationRef.current === null) {
        const created = await createConversation();
        if (!created.ok) {
          update(id, (turn) => ({ ...turn, status: 'failed', error: askFailureCopy(created) }));
          return;
        }
        conversationRef.current = created.data.id;
      }
      const result = await askQuestion({
        conversationId: conversationRef.current,
        question: trimmed,
        signal: controller.signal,
        onEvent: (event) => {
          update(id, (turn) => applyEvent(turn, event));
        },
      });
      update(id, (turn) => {
        if (!result.ok) return { ...turn, status: 'failed', error: askFailureCopy(result) };
        if (result.reason === 'aborted') return { ...turn, status: 'aborted' };
        if (turn.status === 'pending') {
          // The stream ended without `done`: show what arrived, or say it was cut.
          return turn.answer !== null || turn.text !== ''
            ? { ...turn, status: 'complete' }
            : { ...turn, status: 'failed', error: turn.error ?? askErrorCopy('INTERNAL_ERROR') };
        }
        if (turn.status === 'failed' && turn.error === null) return { ...turn, error: askErrorCopy('INTERNAL_ERROR') };
        return turn;
      });
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
    }
  }

  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    void ask(draft);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void ask(draft);
    }
  }

  return (
    <div data-testid="ai-chat" className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {turns.length === 0 ? (
          <div data-testid="ai-chat-empty" className="flex flex-col gap-1 py-6">
            <p className="text-headline font-semibold text-ink">Ask about your infrastructure</p>
            <p className="text-callout text-ink-secondary">
              Why is a service down, what is using memory, what changed in the last deploy. Answers cite the resources and
              evidence they rest on.
            </p>
          </div>
        ) : (
          <ol data-testid="ai-turns" className="flex flex-col gap-6">
            {turns.map((turn) => (
              <TurnView key={turn.id} turn={turn} onRetry={(q) => void ask(q)} />
            ))}
          </ol>
        )}
        <div ref={endRef} />
      </div>
      <form onSubmit={submit} method="post" className="flex flex-col gap-2 border-t border-hairline px-4 py-3">
        <label htmlFor="ai-question-input" className="sr-only">
          Ask a question
        </label>
        <Textarea
          id="ai-question-input"
          data-testid="ai-question-input"
          rows={2}
          placeholder="Ask a question"
          maxLength={AI_QUESTION_MAX_LENGTH}
          value={draft}
          autoComplete="off"
          onChange={(event) => {
            setDraft(event.target.value);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="flex items-center justify-between gap-3">
          <span data-testid="ai-read-only-note" className="text-caption text-ink-tertiary">
            {AI_READ_ONLY_COPY}
          </span>
          {busy ? (
            <Button
              type="button"
              variant="secondary"
              data-testid="ai-stop"
              onClick={() => {
                abortRef.current?.abort();
              }}
            >
              Stop
            </Button>
          ) : (
            <Button type="submit" data-testid="ai-ask" disabled={draft.trim() === ''}>
              Ask
            </Button>
          )}
        </div>
      </form>
    </div>
  );
}
