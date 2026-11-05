import { describe, expect, it, vi } from 'vitest';
import { fireEvent, renderUi, screen, within } from '@noodara/ui/testing';
import type { AiAnswer } from '../../lib/api/ai-api';
import { AiAnswerView } from './AiAnswerView';

const SERVICE = '44444444-4444-4444-8444-444444444444';
const PROJECT = '11111111-1111-4111-8111-111111111111';
const ids = vi.hoisted(() => ({ service: '44444444-4444-4444-8444-444444444444', project: '11111111-1111-4111-8111-111111111111' }));
const SERVER = '66666666-6666-4666-8666-666666666666';

vi.mock('./entity-links', async (importOriginal) => {
  const real = await importOriginal<typeof import('./entity-links')>();
  return {
    ...real,
    useEntityIndex: () => ({
      environments: new Map<string, string>(),
      services: new Map([[ids.service, ids.project]]),
      deployments: new Map<string, string>(),
    }),
  };
});


const HOSTILE =
  'Fixed. <img src=x onerror="window.__pwned=1"> <script>window.__pwned=2</script> see https://evil.example/login and [click](javascript:alert(1))';

function answer(overrides: Partial<AiAnswer> = {}): AiAnswer {
  return {
    answer: 'The api service is crash looping.',
    diagnosis: 'crash_loop',
    confidence: 0.82,
    entities: [],
    evidence: [],
    missingEvidence: [],
    ...overrides,
  };
}

describe('AiAnswerView', () => {
  it('shows the answer first, then diagnosis and confidence', () => {
    renderUi(<AiAnswerView answer={answer()} toolCalls={[]} />);
    const root = screen.getByTestId('ai-answer');
    expect(root.firstElementChild).toBe(screen.getByTestId('ai-answer-text'));
    expect(screen.getByTestId('ai-answer-text').textContent).toBe('The api service is crash looping.');
    expect(screen.getByTestId('ai-diagnosis').textContent).toContain('Crash loop');
    expect(screen.getByTestId('ai-confidence').textContent).toBe('High confidence · 82%');
    expect(screen.queryByTestId('ai-missing-evidence')).toBeNull();
  });

  it('renders markup, scripts and URLs in the answer as inert text (A3, H1)', () => {
    renderUi(<AiAnswerView answer={answer({ answer: HOSTILE, evidence: [{ ref: '<b>ref</b>', note: '<img src=x>' }] })} toolCalls={[]} />);
    const text = screen.getByTestId('ai-answer-text');
    expect(text.textContent).toBe(HOSTILE);
    expect(text.querySelector('img, script, a, b')).toBeNull();
    const root = screen.getByTestId('ai-answer');
    expect(root.querySelector('img, script, b')).toBeNull();
    expect(root.querySelectorAll('a')).toHaveLength(0);
    expect((window as unknown as { __pwned?: number }).__pwned).toBeUndefined();
  });

  it('links chips only for routable entities', () => {
    renderUi(
      <AiAnswerView
        answer={answer({
          entities: [
            { kind: 'Service', id: SERVICE, label: 'api' },
            { kind: 'Server', id: SERVER, label: 'web-1' },
            { kind: 'Domain', id: SERVER, label: 'https://evil.example' },
          ],
        })}
        toolCalls={[]}
      />,
    );
    const chips = screen.getAllByTestId('ai-entity-chip');
    expect(chips).toHaveLength(3);
    expect(chips[0]?.getAttribute('href')).toBe(`/projects/${PROJECT}/services/${SERVICE}`);
    expect(chips[1]?.getAttribute('href')).toBe(`/servers/${SERVER}`);
    expect(chips[2]?.tagName).toBe('SPAN');
    expect(chips[2]?.hasAttribute('href')).toBe(false);
  });

  it('says which evidence was missing for unknown', () => {
    renderUi(<AiAnswerView answer={answer({ diagnosis: 'unknown', missingEvidence: ['No logs for api in the last hour'] })} toolCalls={[]} />);
    expect(screen.getByTestId('ai-missing-evidence').textContent).toContain('No logs for api in the last hour');
  });

  it('falls back when unknown names no missing evidence', () => {
    renderUi(<AiAnswerView answer={answer({ diagnosis: 'unknown' })} toolCalls={[]} />);
    expect(screen.getByTestId('ai-missing-evidence').textContent).toContain('did not say');
  });

  it('keeps evidence and tools collapsed until opened', () => {
    renderUi(
      <AiAnswerView
        answer={answer({ evidence: [{ ref: 'logs:api', note: 'OOMKilled at 12:01' }] })}
        toolCalls={[{ name: 'get_service_logs', scope: { kind: 'Service', id: SERVICE } }]}
      />,
    );
    const evidence = screen.getByTestId('ai-evidence');
    expect(within(evidence).queryByText('OOMKilled at 12:01')).toBeNull();
    fireEvent.click(within(evidence).getByRole('button'));
    expect(within(evidence).getByText('OOMKilled at 12:01')).toBeTruthy();
    const tools = screen.getByTestId('ai-tools');
    expect(tools.textContent).toContain('Tools consulted (1)');
    fireEvent.click(within(tools).getByRole('button'));
    expect(within(tools).getByText('get_service_logs')).toBeTruthy();
  });

  it('says when no tools were needed', () => {
    renderUi(<AiAnswerView answer={answer()} toolCalls={[]} />);
    fireEvent.click(within(screen.getByTestId('ai-tools')).getByRole('button'));
    expect(screen.getByTestId('ai-tools').textContent).toContain('No tools were needed');
  });
});
