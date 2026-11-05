import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, renderUi, screen, waitFor } from '@noodara/ui/testing';
import type { AskEvent, AskOptions } from '../../lib/api/ai-api';
import { AiChat } from './AiChat';

const CONV = '0190a000-0000-7000-8000-000000000001';

const api = vi.hoisted(() => ({
  createConversation: vi.fn(),
  askQuestion: vi.fn(),
}));
vi.mock('../../lib/api/ai-api', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/api/ai-api')>();
  return { ...real, createConversation: api.createConversation, askQuestion: api.askQuestion };
});
vi.mock('./entity-links', async (importOriginal) => {
  const real = await importOriginal<typeof import('./entity-links')>();
  return { ...real, useEntityIndex: () => real.EMPTY_ENTITY_INDEX };
});

function scripted(events: readonly AskEvent[]) {
  return (options: AskOptions) => {
    for (const event of events) options.onEvent(event);
    return Promise.resolve({ ok: true as const, reason: 'ended' as const });
  };
}

function ask(question: string): void {
  fireEvent.change(screen.getByTestId('ai-question-input'), { target: { value: question } });
  fireEvent.click(screen.getByTestId('ai-ask'));
}

beforeEach(() => {
  api.createConversation.mockResolvedValue({ ok: true, data: { id: CONV } });
});
afterEach(() => {
  vi.clearAllMocks();
});

describe('AiChat', () => {
  it('starts empty with the read-only note', () => {
    renderUi(<AiChat />);
    expect(screen.getByTestId('ai-chat-empty')).toBeTruthy();
    expect(screen.getByTestId('ai-read-only-note').textContent).toMatch(/Read-only/);
    expect(screen.getByTestId('ai-ask').hasAttribute('disabled')).toBe(true);
  });

  it('streams tools then shows the structured answer', async () => {
    api.askQuestion.mockImplementation(
      scripted([
        { type: 'tool_call', call: { name: 'get_service_status', scope: null } },
        { type: 'text', text: 'partial' },
        {
          type: 'answer',
          answer: { answer: 'api is down', diagnosis: 'container_stopped', confidence: 0.9, entities: [], evidence: [], missingEvidence: [] },
        },
        { type: 'done', status: 'complete' },
      ]),
    );
    renderUi(<AiChat />);
    ask('why is api down?');
    await waitFor(() => {
      expect(screen.getByTestId('ai-answer-text').textContent).toBe('api is down');
    });
    expect(screen.getByTestId('ai-turn').getAttribute('data-status')).toBe('complete');
    expect(screen.queryByTestId('ai-streamed-text')).toBeNull();
    expect(screen.getByTestId('ai-tools').textContent).toContain('Tools consulted (1)');
    expect(api.askQuestion).toHaveBeenCalledWith(expect.objectContaining({ conversationId: CONV, question: 'why is api down?' }));
  });

  it('reuses one conversation for follow-up questions', async () => {
    api.askQuestion.mockImplementation(scripted([{ type: 'text', text: 'ok' }, { type: 'done', status: 'complete' }]));
    renderUi(<AiChat />);
    ask('one');
    await waitFor(() => {
      expect(screen.getAllByTestId('ai-turn')[0]?.getAttribute('data-status')).toBe('complete');
    });
    ask('two');
    await waitFor(() => {
      expect(screen.getAllByTestId('ai-turn')).toHaveLength(2);
    });
    await waitFor(() => {
      expect(api.askQuestion).toHaveBeenCalledTimes(2);
    });
    expect(api.createConversation).toHaveBeenCalledTimes(1);
  });

  it('sends a missing key to Settings', async () => {
    api.askQuestion.mockImplementation(
      scripted([
        { type: 'error', code: 'AI_PROVIDER_NOT_CONFIGURED' },
        { type: 'done', status: 'failed' },
      ]),
    );
    renderUi(<AiChat />);
    ask('hello');
    await waitFor(() => {
      expect(screen.getByTestId('ai-error-settings').getAttribute('href')).toBe('/settings');
    });
  });

  it('offers a retry on a transient failure and retries the same question', async () => {
    api.askQuestion.mockResolvedValueOnce({ ok: false, code: 'NETWORK_ERROR', message: 'x' });
    api.askQuestion.mockImplementation(scripted([{ type: 'text', text: 'second try' }, { type: 'done', status: 'complete' }]));
    renderUi(<AiChat />);
    ask('hello');
    await waitFor(() => {
      expect(screen.getByTestId('ai-error').textContent).toMatch(/connection/);
    });
    fireEvent.click(screen.getByTestId('ai-error-retry'));
    await waitFor(() => {
      expect(screen.getByText('second try')).toBeTruthy();
    });
    expect(api.askQuestion).toHaveBeenLastCalledWith(expect.objectContaining({ question: 'hello' }));
  });

  it('reports a failed conversation create', async () => {
    api.createConversation.mockResolvedValue({ ok: false, code: 'RATE_LIMITED', message: 'x' });
    renderUi(<AiChat />);
    ask('hello');
    await waitFor(() => {
      expect(screen.getByTestId('ai-error').textContent).toMatch(/Too many questions/);
    });
    expect(api.askQuestion).not.toHaveBeenCalled();
  });

  it('says the stream was cut when it ends with nothing', async () => {
    api.askQuestion.mockImplementation(scripted([]));
    renderUi(<AiChat />);
    ask('hello');
    await waitFor(() => {
      expect(screen.getByTestId('ai-turn').getAttribute('data-status')).toBe('failed');
    });
    expect(screen.getByTestId('ai-error')).toBeTruthy();
  });

  it('stops a running question', async () => {
    api.askQuestion.mockImplementation(
      (options: AskOptions) =>
        new Promise((resolve) => {
          options.signal.addEventListener('abort', () => {
            resolve({ ok: true, reason: 'aborted' });
          });
        }),
    );
    renderUi(<AiChat />);
    ask('hello');
    await waitFor(() => {
      expect(screen.getByTestId('ai-stop')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('ai-stop'));
    await waitFor(() => {
      expect(screen.getByTestId('ai-stopped')).toBeTruthy();
    });
  });

  it('asks on Enter but not on Shift+Enter', async () => {
    api.askQuestion.mockImplementation(scripted([{ type: 'done', status: 'complete' }]));
    renderUi(<AiChat />);
    const input = screen.getByTestId('ai-question-input');
    fireEvent.change(input, { target: { value: 'hi' } });
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(screen.queryByTestId('ai-turn')).toBeNull();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => {
      expect(screen.getByTestId('ai-turn')).toBeTruthy();
    });
  });
});
