// 30-04: the read-only AI chat in the inspector, in a real browser against the real stack. The
// conversation routes are intercepted with page.route (ADR-0005, same as graph.spec.ts): the agent
// loop, tools and redaction are proven by the 28-0x integration tests and evals. Here the UI
// contract: answer first, diagnosis and confidence, entity chips that navigate, collapsed evidence,
// tools consulted, `unknown` with its missing evidence, actionable provider errors (A2), model
// output rendered as inert text (A3) and chips built only from validated UUIDs (H1).
import { expect, test, type Page, type Route } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './fixtures/stack.js';

const CONV_ID = '0190a000-0000-7000-8000-0000000000a1';
const SERVER_ID = '6b000000-0000-4000-8000-000000000001';
const PROJECT_ID = '6b000000-0000-4000-8000-000000000002';
const DOMAIN_ID = '6b000000-0000-4000-8000-000000000003';

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/servers$/);
}

function json(route: Route, body: unknown, status = 200): Promise<void> {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

const frame = (event: string, data: unknown): string => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

interface AnswerFields {
  answer: string;
  diagnosis: string;
  confidence: number;
  entities: { kind: string; id: string; label: string }[];
  evidence: { ref: string; note: string }[];
  missingEvidence: string[];
}

function answer(overrides: Partial<AnswerFields> = {}): AnswerFields {
  return {
    answer: 'The api container exited with code 137: it ran out of memory.',
    diagnosis: 'out_of_memory',
    confidence: 0.86,
    entities: [],
    evidence: [],
    missingEvidence: [],
    ...overrides,
  };
}

/** Each question is answered by the next stream in `streams`. */
async function mockChat(page: Page, streams: string[][]): Promise<{ questions: string[] }> {
  const questions: string[] = [];
  await page.route('**/api/ai/conversations', (route) => {
    if (route.request().method() !== 'POST') return route.fallback();
    return json(route, { id: CONV_ID, title: 'New conversation' }, 201);
  });
  await page.route(`**/api/ai/conversations/${CONV_ID}/messages`, (route) => {
    const body = route.request().postDataJSON() as { question: string };
    questions.push(body.question);
    const frames = streams.shift() ?? [frame('error', { error: 'AI_PROVIDER_UNAVAILABLE' }), frame('done', { status: 'failed' })];
    return route.fulfill({ status: 200, contentType: 'text/event-stream', body: frames.join('') });
  });
  return { questions };
}

async function openChat(page: Page): Promise<void> {
  await page.goto('/servers?ask=1');
  await expect(page.getByTestId('inspector-panel').getByRole('heading', { name: 'Ask Noodara' })).toBeVisible();
  await expect(page.getByTestId('ai-read-only-note')).toContainText('Read-only');
}

async function ask(page: Page, question: string): Promise<void> {
  await page.getByTestId('ai-question-input').fill(question);
  await page.getByTestId('ai-ask').click();
}

test.describe('AI chat (30-04)', () => {
  test('A2: answer first, diagnosis and confidence, chips that navigate, collapsed evidence, tools consulted', async ({ page }) => {
    await login(page);
    const chat = await mockChat(page, [
      [
        frame('start', { messageId: '0190a000-0000-7000-8000-0000000000b1' }),
        frame('tool_call', { name: 'get_service_status', scope: { kind: 'Server', id: SERVER_ID } }),
        frame('tool_call', { name: 'get_runtime_logs', scope: null }),
        frame('text', { text: 'Looking at the logs' }),
        frame('answer', {
          answer: answer({
            entities: [
              { kind: 'Server', id: SERVER_ID, label: 'web-1' },
              { kind: 'Project', id: PROJECT_ID, label: 'shop' },
              { kind: 'Domain', id: DOMAIN_ID, label: 'shop.example.com' },
            ],
            evidence: [{ ref: 'logs:api', note: 'OOMKilled at 12:01' }],
          }),
        }),
        frame('done', { status: 'complete' }),
      ],
    ]);
    await openChat(page);
    await ask(page, 'Why did api restart?');

    const turn = page.getByTestId('ai-turn');
    await expect(turn).toHaveAttribute('data-status', 'complete');
    expect(chat.questions).toEqual(['Why did api restart?']);

    const view = turn.getByTestId('ai-answer');
    // Answer first: the answer text is the first thing in the answer block.
    const firstTestId = await view.evaluate((el) => el.firstElementChild?.getAttribute('data-testid'));
    expect(firstTestId).toBe('ai-answer-text');
    await expect(view.getByTestId('ai-answer-text')).toHaveText('The api container exited with code 137: it ran out of memory.');
    await expect(view.getByTestId('ai-diagnosis')).toContainText('Out of memory');
    await expect(view.getByTestId('ai-confidence')).toHaveText('High confidence · 86%');
    await expect(turn.getByTestId('ai-streamed-text')).toHaveCount(0);

    // Evidence and tools start collapsed.
    await expect(view.getByText('OOMKilled at 12:01')).toBeHidden();
    await view.getByTestId('ai-evidence').getByRole('button').click();
    await expect(view.getByText('OOMKilled at 12:01')).toBeVisible();
    await expect(view.getByTestId('ai-tools')).toContainText('Tools consulted (2)');
    await view.getByTestId('ai-tools').getByRole('button').click();
    await expect(view.getByTestId('ai-tools-list')).toContainText('get_service_status');
    await expect(view.getByTestId('ai-tools-list')).toContainText('get_runtime_logs');

    // Chips: routable ones are links built from the ids; a Domain is a plain chip.
    const chips = view.getByTestId('ai-entity-chip');
    await expect(chips).toHaveCount(3);
    await expect(chips.nth(0)).toHaveAttribute('href', `/servers/${SERVER_ID}`);
    await expect(chips.nth(1)).toHaveAttribute('href', `/projects/${PROJECT_ID}`);
    expect(await chips.nth(2).evaluate((el) => el.tagName)).toBe('SPAN');
    await chips.nth(0).click();
    await expect(page).toHaveURL(new RegExp(`/servers/${SERVER_ID}$`));
  });

  test('A2: unknown says which evidence was missing', async ({ page }) => {
    await login(page);
    await mockChat(page, [
      [
        frame('answer', {
          answer: answer({
            answer: 'I could not find why the service is slow.',
            diagnosis: 'unknown',
            confidence: 0.2,
            missingEvidence: ['No request latency metrics for api', 'Runtime logs older than 1 hour'],
          }),
        }),
        frame('done', { status: 'complete' }),
      ],
    ]);
    await openChat(page);
    await ask(page, 'Why is api slow?');
    const missing = page.getByTestId('ai-missing-evidence');
    await expect(missing).toContainText('Missing evidence');
    await expect(missing).toContainText('No request latency metrics for api');
    await expect(missing).toContainText('Runtime logs older than 1 hour');
    await expect(page.getByTestId('ai-diagnosis')).toContainText('Unknown');
    await expect(page.getByTestId('ai-confidence')).toHaveText('Low confidence · 20%');
  });

  test('A2: provider errors have actionable copy', async ({ page }) => {
    await login(page);
    await mockChat(page, [
      [frame('error', { error: 'AI_PROVIDER_NOT_CONFIGURED' }), frame('done', { status: 'failed' })],
      [frame('error', { error: 'AI_PROVIDER_UNAVAILABLE' }), frame('done', { status: 'failed' })],
      [frame('answer', { answer: answer() }), frame('done', { status: 'complete' })],
    ]);
    await openChat(page);

    await ask(page, 'Is anything down?');
    const first = page.getByTestId('ai-turn').nth(0);
    await expect(first.getByTestId('ai-error')).toBeVisible();
    await expect(first.getByTestId('ai-error-settings')).toHaveAttribute('href', '/settings');

    await ask(page, 'Is anything down now?');
    const second = page.getByTestId('ai-turn').nth(1);
    await expect(second.getByTestId('ai-error')).toBeVisible();
    await second.getByTestId('ai-error-retry').click();
    const third = page.getByTestId('ai-turn').nth(2);
    await expect(third).toHaveAttribute('data-status', 'complete');
    await expect(third.getByTestId('ai-question')).toHaveText('Is anything down now?');
  });

  test('A3/H1: markup, scripts and URLs in an answer stay inert text; chips need validated UUIDs', async ({ page }) => {
    await login(page);
    const hostile =
      'Restarted. <img src=x onerror="window.__aiPwned=1"> <script>window.__aiPwned=2</script> ' +
      '<a href="https://evil.example/a">click</a> see https://evil.example/login and [docs](javascript:alert(1))';
    await mockChat(page, [
      [
        frame('text', { text: '<img src=y onerror="window.__aiPwned=3">' }),
        frame('answer', {
          answer: answer({
            answer: hostile,
            entities: [
              { kind: 'Server', id: 'https://evil.example', label: 'evil' },
              { kind: 'Server', id: '../../settings', label: 'traversal' },
              { kind: 'Script', id: SERVER_ID, label: 'bad kind' },
              { kind: 'Server', id: SERVER_ID, label: '<b>web-1</b>' },
            ],
            evidence: [{ ref: '<script>x</script>', note: '<img src=z onerror="window.__aiPwned=4">' }],
            missingEvidence: [],
          }),
        }),
        frame('done', { status: 'complete' }),
      ],
    ]);
    await openChat(page);
    await ask(page, 'What happened?');

    const text = page.getByTestId('ai-answer-text');
    await expect(text).toHaveText(hostile);
    const answerBlock = page.getByTestId('ai-answer');
    await answerBlock.getByTestId('ai-evidence').getByRole('button').click();
    await expect(answerBlock.getByTestId('ai-evidence-list')).toContainText('<script>x</script>');

    expect(await text.locator('img, script, a, b').count()).toBe(0);
    expect(await answerBlock.locator('img, script, b').count()).toBe(0);
    expect(await page.locator('[data-testid="ai-chat"] img, [data-testid="ai-chat"] script').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __aiPwned?: number }).__aiPwned)).toBeUndefined();

    // Only the chip with a UUID id and a known kind survives; its label stays text.
    const chips = answerBlock.getByTestId('ai-entity-chip');
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toHaveAttribute('href', `/servers/${SERVER_ID}`);
    await expect(chips.first()).toContainText('<b>web-1</b>');
    // No anchor in the answer points anywhere but a validated route.
    const hrefs = await answerBlock.locator('a').evaluateAll((els) => els.map((el) => el.getAttribute('href')));
    expect(hrefs).toEqual([`/servers/${SERVER_ID}`]);
  });

  test('the question never reaches browser storage or the URL', async ({ page }) => {
    await login(page);
    await mockChat(page, [[frame('answer', { answer: answer() }), frame('done', { status: 'complete' })]]);
    await openChat(page);
    const question = 'private-question-marker-8c41';
    await ask(page, question);
    await expect(page.getByTestId('ai-turn')).toHaveAttribute('data-status', 'complete');
    const stored = await page.evaluate(() => JSON.stringify({ ...window.localStorage }) + JSON.stringify({ ...window.sessionStorage }));
    expect(stored).not.toContain(question);
    expect(page.url()).not.toContain(question);
  });
});
