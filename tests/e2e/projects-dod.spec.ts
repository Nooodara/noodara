// 13-17: UI Definition of Done for the Phase 13 screens -- /projects, a project, a service, the
// Project/Environment/Service create sheets and the inspector's build and runtime logs -- measured
// in a real browser against the real stack and the e2e deploy host (a CONNECTED server with Docker
// is required to create a service at all).
//
// A1 contrast, A2 widths x themes, A3 reduced motion, H1 keyboard/focus/status text, H2 long
// content. Screenshots for the UI review (docs/ui-review/phase-13/) are written only when
// NOODARA_UI_REVIEW_CAPTURE=1, so a normal gate run never rewrites tracked images.
//
// Two stand-ins, both on top of real responses: a project name is capped at 64 code points by
// the domain (packages/domain/src/project/project.ts), so H2's 200-character name is injected into
// the real /api/projects responses; and the 10,000-line build log replaces the real (failed)
// deployment's log pages. Everything else is real data created through the API.
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { AxeBuilder } from '@axe-core/playwright';
import type { Locator, Page } from '@playwright/test';
import { E2E_ADMIN_EMAIL, E2E_ADMIN_PASSWORD } from './fixtures/stack.js';
import { expect, test, type DeployHost } from './fixtures/deploy-host.js';

const BASE_URL = 'http://localhost:3000';
const WIDTHS = [375, 900, 1280, 1920] as const;
const THEMES = ['light', 'dark'] as const;
type Theme = (typeof THEMES)[number];
const CAPTURE = process.env.NOODARA_UI_REVIEW_CAPTURE === '1';
const SHOTS_DIR = path.resolve('docs/ui-review/phase-13');
const SHOTS_DIR_14 = path.resolve('docs/ui-review/phase-14');

const LONG_NAME_LENGTH = 200;
const LONG_REPO_URL_LENGTH = 300;
const LONG_LOG_LINES = 10_000;

// ---- API helpers ----

interface ApiResult {
  readonly status: number;
  readonly body: unknown;
}

/** Mutations need the web origin (CSRF check); /api/* is proxied to the control plane. */
async function api(page: Page, method: string, url: string, data?: unknown): Promise<ApiResult> {
  const response = await page.request.fetch(url, {
    method,
    headers: { origin: BASE_URL },
    ...(data === undefined ? {} : { data }),
    failOnStatusCode: false,
    timeout: 30_000,
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status(), body };
}

function field(body: unknown, key: string): string {
  const value = (body as Record<string, unknown> | null)?.[key];
  if (typeof value !== 'string') throw new Error(`response has no string '${key}': ${JSON.stringify(body)}`);
  return value;
}

async function created(page: Page, url: string, data: unknown, what: string): Promise<string> {
  const result = await api(page, 'POST', url, data);
  expect(result.status, `${what}: ${JSON.stringify(result.body)}`).toBe(201);
  return field(result.body, 'id');
}

async function login(page: Page): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('Email').fill(E2E_ADMIN_EMAIL);
  await page.getByLabel('Password').fill(E2E_ADMIN_PASSWORD);
  await page.getByTestId('login-submit').click();
  await expect(page).toHaveURL(/\/servers$/);
}

function suffix(): string {
  return Math.floor(Math.random() * 0xffffff)
    .toString(16)
    .padStart(6, '0');
}

// ---- fixture data (one set per worker) ----

interface Fixture {
  serverId: string;
  serverName: string;
  projectId: string;
  projectName: string;
  environmentId: string;
  imageServiceId: string;
  gitServiceId: string;
  deploymentId: string;
  longProjectId: string;
  longProjectName: string;
}

const fx: Fixture = {
  serverId: '',
  serverName: '',
  projectId: '',
  projectName: '',
  environmentId: '',
  imageServiceId: '',
  gitServiceId: '',
  deploymentId: '',
  longProjectId: '',
  longProjectName: '',
};

/** A 300-character https repository URL (the validator allows 512): long path segments. */
function longRepositoryUrl(): string {
  const prefix = 'https://git.example.test/platform-engineering/';
  const tail = '.git';
  let middle = '';
  let segment = 0;
  while (prefix.length + middle.length + tail.length < LONG_REPO_URL_LENGTH) {
    middle += `${middle === '' ? '' : '/'}service-catalog-component-${String(segment)}`;
    segment += 1;
  }
  const url = `${prefix}${middle}`.slice(0, LONG_REPO_URL_LENGTH - tail.length).replace(/[/-]+$/, 'x') + tail;
  return url.padEnd(LONG_REPO_URL_LENGTH, 'x');
}

async function seed(page: Page, host: DeployHost): Promise<void> {
  fx.serverName = `dod-${suffix()}`;
  fx.serverId = await created(
    page,
    '/api/servers',
    {
      name: fx.serverName,
      host: host.ssh.host,
      sshPort: host.ssh.port,
      sshUser: host.ssh.user,
      credential: { type: 'ssh_private_key', privateKey: host.ssh.privateKey },
    },
    'create server',
  );
  const connect = await api(page, 'POST', `/api/servers/${fx.serverId}/connect`);
  expect(connect.status, 'connect server').toBe(202);
  await expect
    .poll(async () => field((await api(page, 'GET', `/api/servers/${fx.serverId}`)).body, 'status'), { timeout: 120_000 })
    .toBe('CONNECTED');

  fx.projectName = `Payments ${suffix()}`;
  fx.projectId = await created(
    page,
    '/api/projects',
    { name: fx.projectName, description: 'Card processing, settlement and the merchant dashboard.' },
    'create project',
  );
  fx.environmentId = await created(page, `/api/projects/${fx.projectId}/environments`, { name: 'production' }, 'create environment');

  fx.imageServiceId = await created(
    page,
    `/api/projects/${fx.projectId}/services`,
    {
      environmentId: fx.environmentId,
      name: 'api',
      serverId: fx.serverId,
      // Unreachable registry: the deploy fails fast at the pull step, leaving a real FAILED
      // deployment with a classified error and a build log.
      source: { kind: 'image', imageRef: '127.0.0.1:1/noodara-dod/missing:1' },
      internalPort: 3000,
      publishedPort: null,
    },
    'create image service',
  );
  fx.gitServiceId = await created(
    page,
    `/api/projects/${fx.projectId}/services`,
    {
      environmentId: fx.environmentId,
      name: 'web',
      serverId: fx.serverId,
      source: {
        kind: 'git',
        repositoryUrl: longRepositoryUrl(),
        branch: 'main',
        buildContext: '.',
        dockerfilePath: 'Dockerfile',
        target: null,
      },
      internalPort: 8080,
      publishedPort: null,
    },
    'create git service',
  );

  const deploy = await api(page, 'POST', `/api/services/${fx.imageServiceId}/deploy`);
  expect(deploy.status, `deploy: ${JSON.stringify(deploy.body)}`).toBe(201);
  fx.deploymentId = field(deploy.body, 'id');
  await expect
    .poll(
      async () =>
        (await api(page, 'GET', `/api/services/${fx.imageServiceId}/deployments/${fx.deploymentId}`)).body as {
          completedAt?: string | null;
        },
      { timeout: 180_000, intervals: [1_000, 2_000] },
    )
    .toMatchObject({ completedAt: expect.any(String) as unknown });

  // The longest name the domain accepts (64 code points), unbroken: H2 then injects 200.
  fx.longProjectName = `W${suffix()}${'W'.repeat(57)}`;
  fx.longProjectId = await created(
    page,
    '/api/projects',
    { name: fx.longProjectName, description: 'Long content stress. '.repeat(23).trim() },
    'create long project',
  );
}

async function teardown(page: Page): Promise<void> {
  for (const [id, name] of [
    [fx.projectId, fx.projectName],
    [fx.longProjectId, fx.longProjectName],
  ] as const) {
    if (id === '') continue;
    await expect
      .poll(
        async () => {
          await api(page, 'POST', `/api/projects/${id}/archive`);
          const removed = await api(page, 'DELETE', `/api/projects/${id}`, { confirmName: name });
          return removed.status === 200 || removed.status === 404;
        },
        { timeout: 90_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toBe(true);
  }
  if (fx.serverId !== '') {
    const removed = await api(page, 'DELETE', `/api/servers/${fx.serverId}`, { confirmName: fx.serverName });
    expect([200, 204, 404]).toContain(removed.status);
  }
}

// ---- screens ----

interface Screen {
  readonly name: string;
  /** Navigates and resolves once the screen shows its real content. */
  open(page: Page): Promise<void>;
  /** A sheet: the dialog panel and the control that opened it. */
  readonly sheet?: { readonly testId: string; trigger(page: Page): Locator };
}

const serviceHref = (serviceId: string): string => `/projects/${fx.projectId}/services/${serviceId}`;

async function openWithTrigger(page: Page, href: string, trigger: Locator, sheetTestId: string): Promise<void> {
  await page.goto(href);
  await trigger.click();
  await expect(page.getByTestId(sheetTestId)).toBeVisible();
  await settle(page);
}

const SCREENS: readonly Screen[] = [
  {
    name: 'projects',
    async open(page) {
      await page.goto('/projects');
      await expect(page.getByTestId('projects-list')).toContainText(fx.projectName);
    },
  },
  {
    name: 'project',
    async open(page) {
      await page.goto(`/projects/${fx.projectId}`);
      await expect(page.getByTestId(`environment-section-${fx.environmentId}`)).toContainText('production');
      await expect(page.getByTestId(`service-row-${fx.imageServiceId}`)).toContainText('api');
      await expect(page.getByTestId(`service-row-${fx.gitServiceId}`)).toBeVisible();
    },
  },
  {
    name: 'service',
    async open(page) {
      await page.goto(serviceHref(fx.imageServiceId));
      await expect(page.getByTestId('service-toolbar')).toBeVisible();
      await expect(page.getByTestId(`deployment-row-${fx.deploymentId}`)).toBeVisible();
    },
  },
  {
    name: 'project-sheet',
    sheet: { testId: 'project-sheet', trigger: (page) => page.getByTestId('projects-new-button') },
    async open(page) {
      await openWithTrigger(page, '/projects', page.getByTestId('projects-new-button'), 'project-sheet');
    },
  },
  {
    name: 'environment-sheet',
    sheet: { testId: 'environment-sheet', trigger: (page) => page.getByTestId('project-new-environment-button') },
    async open(page) {
      await openWithTrigger(page, `/projects/${fx.projectId}`, page.getByTestId('project-new-environment-button'), 'environment-sheet');
    },
  },
  {
    name: 'service-sheet',
    sheet: { testId: 'service-sheet', trigger: (page) => page.getByTestId(`new-service-${fx.environmentId}`) },
    async open(page) {
      await openWithTrigger(page, `/projects/${fx.projectId}`, page.getByTestId(`new-service-${fx.environmentId}`), 'service-sheet');
    },
  },
  {
    name: 'inspector-build-log',
    async open(page) {
      await page.goto(`${serviceHref(fx.imageServiceId)}?deployment=${fx.deploymentId}`);
      await expect(page.getByTestId('build-log-panel')).toBeVisible();
      await expect(page.getByTestId('build-log-loading')).toHaveCount(0);
      await expect(page.getByTestId('build-log-status')).toBeVisible();
    },
  },
  {
    name: 'inspector-runtime-logs',
    async open(page) {
      await page.goto(`${serviceHref(fx.imageServiceId)}?logs=runtime`);
      await expect(page.getByTestId('runtime-log-panel')).toBeVisible();
      await expect(page.getByTestId('runtime-log-loading')).toHaveCount(0, { timeout: 30_000 });
    },
  },
];

/** Waits out entrance transitions so measurements see the settled frame. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
    );
    // The sheet's drag surface settles on a JS spring (motion's animateMotionValue), which
    // getAnimations() never sees: wait until open dialogs hold still for 6 frames (3 s cap).
    const frame = (): Promise<number> => new Promise((resolve) => requestAnimationFrame(resolve));
    const snapshot = (): string =>
      Array.from(document.querySelectorAll('[role="dialog"], [role="dialog"] *'))
        .slice(0, 50)
        .map((el) => {
          const r = el.getBoundingClientRect();
          return `${String(r.x)},${String(r.y)},${String(r.width)},${String(r.height)}`;
        })
        .join('|');
    const deadline = performance.now() + 3000;
    let previous = snapshot();
    let still = 0;
    while (still < 6 && performance.now() < deadline) {
      await frame();
      const current = snapshot();
      still = current === previous ? still + 1 : 0;
      previous = current;
    }
  });
}

async function applyTheme(page: Page, theme: Theme): Promise<void> {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate((value) => {
    document.documentElement.setAttribute('data-theme', value);
  }, theme);
  await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
}

async function show(page: Page, screen: Screen, theme: Theme, width: number): Promise<void> {
  await page.setViewportSize({ width, height: 900 });
  await page.emulateMedia({ colorScheme: theme });
  await screen.open(page);
  await applyTheme(page, theme);
  await settle(page);
}

async function capture(page: Page, file: string, dir = SHOTS_DIR): Promise<void> {
  if (!CAPTURE) return;
  mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, file), fullPage: false, animations: 'disabled' });
}

// ---- in-browser measurements (self-contained: serialized into the page) ----

interface ContrastViolation {
  readonly where: string;
  readonly text: string;
  readonly ratio: number;
  readonly threshold: number;
  readonly fg: string;
  readonly bg: string;
}

/** WCAG 2.x contrast of every visible text run against its composited background. Thresholds are
 *  the design system's (packages/ui/src/contrast.test.ts): 4.5 for text, 3.0 for large text;
 *  ratios truncate to two decimals, never round up. Disabled controls are exempt (WCAG 1.4.3). */
function scanContrast(): ContrastViolation[] {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) throw new Error('no 2d context');
  type Rgba = [number, number, number, number];
  const parse = (color: string): Rgba => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = 'rgba(0,0,0,0)';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, (d[3] ?? 0) / 255];
  };
  const over = (top: Rgba, under: Rgba): Rgba => {
    const a = top[3] + under[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    const mix = (i: 0 | 1 | 2): number => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a;
    return [mix(0), mix(1), mix(2), a];
  };
  const luminance = (c: Rgba): number => {
    const channel = (v: number): number => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(c[0]) + 0.7152 * channel(c[1]) + 0.0722 * channel(c[2]);
  };
  const ratioOf = (a: Rgba, b: Rgba): number => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
    return Math.floor(((hi + 0.05) / (lo + 0.05)) * 100) / 100;
  };
  const describe = (el: Element): string => {
    const tagged = el.closest('[data-testid]');
    return `${el.tagName.toLowerCase()}${tagged === null ? '' : ` in [data-testid="${tagged.getAttribute('data-testid') ?? ''}"]`}`;
  };
  const rootBg = parse(getComputedStyle(document.documentElement).backgroundColor);
  const base: Rgba = rootBg[3] === 0 ? [255, 255, 255, 1] : rootBg;

  // With a modal open, the page behind it sits under the scrim (an overlay sibling this walk never
  // composites), so only the modal's own text is measurable; the page itself is scanned closed.
  const modal = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"]')).find(
    (el) => el.getBoundingClientRect().width > 0,
  );
  const scope: Element = modal ?? document.body;

  const violations: ContrastViolation[] = [];
  for (const el of Array.from(scope.querySelectorAll('*'))) {
    const ownText = Array.from(el.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join('')
      .trim();
    if (ownText === '') continue;
    const style = getComputedStyle(el);
    if (style.visibility !== 'visible' || style.display === 'none') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) continue; // sr-only
    if (el.closest(':disabled, [aria-disabled="true"]') !== null) continue;
    if (el.closest('option, script, style, noscript') !== null) continue;

    const chain: Element[] = [];
    for (let node: Element | null = el; node !== null; node = node.parentElement) chain.push(node);
    let opacity = 1;
    for (const node of chain) opacity *= Number.parseFloat(getComputedStyle(node).opacity);
    if (opacity < 0.05) continue;
    let bg = base;
    for (const node of chain.reverse()) bg = over(parse(getComputedStyle(node).backgroundColor), bg);
    const fgRaw = parse(style.color);
    const fg = over([fgRaw[0], fgRaw[1], fgRaw[2], fgRaw[3] * opacity], bg);

    const size = Number.parseFloat(style.fontSize);
    const weight = Number.parseInt(style.fontWeight, 10);
    const large = size >= 24 || (size >= 18.66 && weight >= 700);
    const threshold = large ? 3 : 4.5;
    const ratio = ratioOf(fg, bg);
    if (ratio < threshold) {
      violations.push({
        where: describe(el),
        text: ownText.slice(0, 40),
        ratio,
        threshold,
        fg: style.color,
        bg: `rgb(${bg.slice(0, 3).map((v) => Math.round(v)).join(',')})`,
      });
    }
  }
  return violations;
}

/** Horizontal page scroll, elements escaping the viewport outside any clipping/scrolling
 *  container, text spilling out of its own box, and text clipped without an ellipsis. */
function scanLayout(): string[] {
  const problems: string[] = [];
  const root = document.documentElement;
  const viewport = root.clientWidth;
  if (root.scrollWidth > viewport + 1) problems.push(`page scrolls horizontally: ${String(root.scrollWidth)} > ${String(viewport)}`);
  if (document.body.scrollWidth > viewport + 1) problems.push(`body is wider than the viewport: ${String(document.body.scrollWidth)}`);
  const describe = (el: Element): string => {
    const tagged = el.closest('[data-testid]');
    const text = (el.textContent ?? '').trim().slice(0, 30);
    return `${el.tagName.toLowerCase()}${tagged === null ? '' : `[${tagged.getAttribute('data-testid') ?? ''}]`} "${text}"`;
  };
  for (const el of Array.from(document.body.querySelectorAll('*'))) {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility !== 'visible') continue;
    if (style.position === 'fixed' && Number.parseFloat(style.opacity) === 0) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) continue;
    let contained = false;
    for (let up = el.parentElement; up !== null && up !== document.body; up = up.parentElement) {
      if (getComputedStyle(up).overflowX !== 'visible') {
        contained = true;
        break;
      }
    }
    if (!contained && (rect.right > viewport + 1 || rect.left < -1)) {
      problems.push(`${describe(el)} escapes the viewport (${String(Math.round(rect.left))}..${String(Math.round(rect.right))} of ${String(viewport)})`);
    }
    const hasText = Array.from(el.childNodes).some((node) => node.nodeType === Node.TEXT_NODE && (node.textContent ?? '').trim() !== '');
    if (!hasText || el.clientWidth === 0) continue;
    const overflowing = el.scrollWidth > el.clientWidth + 1;
    if (!overflowing) continue;
    if (style.overflowX === 'visible') problems.push(`${describe(el)} text spills out of its box (${String(el.scrollWidth)} > ${String(el.clientWidth)})`);
    else if ((style.overflowX === 'hidden' || style.overflowX === 'clip') && style.textOverflow !== 'ellipsis') {
      problems.push(`${describe(el)} text is clipped without an ellipsis`);
    }
  }
  return problems;
}

interface MotionProblem {
  readonly where: string;
  readonly what: string;
}

/** Under prefers-reduced-motion: no transition that moves or scales, and no running animation
 *  other than opacity. */
function scanMotion(): MotionProblem[] {
  const problems: MotionProblem[] = [];
  const MOVING = /(^|,\s*)(all|transform|translate|scale|rotate|inset|left|right|top|bottom|width|height|margin)(\s*,|$)/;
  const describe = (el: Element): string => {
    const tagged = el.closest('[data-testid]');
    return `${el.tagName.toLowerCase()}${tagged === null ? '' : `[${tagged.getAttribute('data-testid') ?? ''}]`}.${String(el.getAttribute('class') ?? '').slice(0, 60)}`;
  };
  for (const el of Array.from(document.querySelectorAll('*'))) {
    const style = getComputedStyle(el);
    if (style.display === 'none') continue;
    const durations = style.transitionDuration.split(',').map((d) => Number.parseFloat(d));
    const properties = style.transitionProperty.split(',').map((p) => p.trim());
    properties.forEach((property, index) => {
      const duration = durations[index % durations.length] ?? 0;
      if (duration > 0.01 && MOVING.test(property)) problems.push({ where: describe(el), what: `transition ${property} ${String(duration)}s` });
    });
  }
  for (const animation of document.getAnimations()) {
    const effect = animation.effect as KeyframeEffect | null;
    if (effect === null || animation.playState !== 'running') continue;
    const timing = effect.getComputedTiming();
    if ((timing.duration as number) <= 10) continue;
    const props = new Set(effect.getKeyframes().flatMap((frame) => Object.keys(frame)));
    for (const meta of ['offset', 'easing', 'composite', 'computedOffset']) props.delete(meta);
    props.delete('opacity');
    if (props.size > 0) {
      const target = effect.target;
      problems.push({ where: target === null ? 'unknown' : describe(target), what: `animation of ${[...props].join(', ')}` });
    }
  }
  return problems;
}

interface FocusStop {
  readonly key: string;
  readonly order: number;
  readonly where: string;
  readonly ringVisible: boolean;
  readonly ringContrast: number;
}

/** Stamps the focused element and reports its document order and focus-ring. */
function inspectFocus(step: number): FocusStop | null {
  const el = document.activeElement;
  if (el === null || el === document.body || el === document.documentElement) return null;
  if (!el.hasAttribute('data-dod-focus')) el.setAttribute('data-dod-focus', String(step));
  const all = Array.from(document.querySelectorAll('*'));
  const style = getComputedStyle(el);
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) throw new Error('no 2d context');
  const parse = (color: string): [number, number, number, number] => {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = 'rgba(0,0,0,0)';
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0] ?? 0, d[1] ?? 0, d[2] ?? 0, (d[3] ?? 0) / 255];
  };
  const lum = (c: [number, number, number, number]): number => {
    const ch = (v: number): number => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2]);
  };
  // The background the ring is drawn over: the nearest opaque ancestor (outline-offset puts the
  // ring outside the element's own fill).
  let bg: [number, number, number, number] = [255, 255, 255, 1];
  for (let up = el.parentElement; up !== null; up = up.parentElement) {
    const c = parse(getComputedStyle(up).backgroundColor);
    if (c[3] >= 0.99) {
      bg = c;
      break;
    }
  }
  const outline = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) >= 1;
  const shadow = style.boxShadow !== 'none';
  const ringColor = parse(outline ? style.outlineColor : style.borderColor);
  const [hi, lo] = [lum(ringColor), lum(bg)].sort((a, b) => b - a) as [number, number];
  const tagged = el.closest('[data-testid]');
  const label = (el.getAttribute('aria-label') ?? (el.textContent ?? '')).trim().slice(0, 30);
  return {
    key: el.getAttribute('data-dod-focus') ?? '',
    order: all.indexOf(el),
    where: `${el.tagName.toLowerCase()}${tagged === null ? '' : `[${tagged.getAttribute('data-testid') ?? ''}]`} "${label}"`,
    ringVisible: outline || shadow,
    ringContrast: Math.floor(((hi + 0.05) / (lo + 0.05)) * 100) / 100,
  };
}

/** Visible, enabled, tabbable elements never stamped by the walk. A radio group counts as reached
 *  when any of its radios was (arrow keys move within it). */
function unreachedTabbables(scopeSelector: string | null): string[] {
  const scope = scopeSelector === null ? document.body : document.querySelector(scopeSelector);
  if (scope === null) return [`scope ${scopeSelector ?? ''} not found`];
  const selector =
    'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';
  const missing: string[] = [];
  const groupReached = new Map<Element, boolean>();
  const groupOf = (el: Element): Element | null =>
    el.closest('[role="radiogroup"]') ?? (el instanceof HTMLInputElement && el.type === 'radio' ? el.form ?? el.parentElement : null);
  const candidates = Array.from(scope.querySelectorAll(selector)).filter((el) => {
    if (el.closest('[inert], [aria-hidden="true"]') !== null) return false;
    if ((el as HTMLElement).tabIndex < 0) return el.getAttribute('role') === 'radio';
    if (el.matches(':disabled')) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.visibility === 'visible' && rect.width > 0 && rect.height > 0;
  });
  for (const el of candidates) {
    const isRadio = el.getAttribute('role') === 'radio' || (el instanceof HTMLInputElement && el.type === 'radio');
    const group = isRadio ? groupOf(el) : null;
    if (group !== null) {
      groupReached.set(group, (groupReached.get(group) ?? false) || el.hasAttribute('data-dod-focus'));
      continue;
    }
    // A roving-focus container (Radix RadioGroup/ToggleGroup root, tabindex 0) hands focus to its
    // active item on entry, so it is reached when one of its items was.
    const roving = el.matches('[role="radiogroup"], [role="toolbar"], [role="tablist"], [role="group"][data-orientation]');
    if (!el.hasAttribute('data-dod-focus') && !(roving && el.querySelector('[data-dod-focus]') !== null)) {
      const tagged = el.closest('[data-testid]');
      missing.push(`${el.tagName.toLowerCase()}${tagged === null ? '' : `[${tagged.getAttribute('data-testid') ?? ''}]`} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 30)}"`);
    }
  }
  for (const [group, reached] of groupReached) {
    if (!reached) missing.push(`radio group ${group.getAttribute('aria-label') ?? group.tagName.toLowerCase()}`);
  }
  return missing;
}

async function tabWalk(page: Page, maxSteps = 150): Promise<FocusStop[]> {
  // blur() keeps the sequential-focus starting point where focus was (the inspector focuses its
  // close button on open), so park focus on an untabbable marker at the top of <body> instead.
  await page.evaluate(() => {
    for (const el of Array.from(document.querySelectorAll('[data-dod-focus], [data-dod-start]'))) {
      if (el.hasAttribute('data-dod-start')) el.remove();
      else el.removeAttribute('data-dod-focus');
    }
    const start = document.createElement('span');
    start.setAttribute('data-dod-start', '');
    start.tabIndex = -1;
    document.body.prepend(start);
    start.focus();
  });
  const stops: FocusStop[] = [];
  const seen = new Set<string>();
  for (let step = 0; step < maxSteps; step += 1) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(inspectFocus, step);
    if (stop === null) break;
    if (seen.has(stop.key)) break; // wrapped around
    seen.add(stop.key);
    stops.push(stop);
  }
  return stops;
}

// ---- the spec ----

test.describe('@projects-dod Phase 13 screens', () => {
  // Default mode, not serial: one screen failing must not hide the others (workers: 1 keeps order).
  test.use({ actionTimeout: 30_000, navigationTimeout: 30_000 });

  test.beforeAll(async ({ browser, deployHost }) => {
    test.setTimeout(8 * 60_000);
    const context = await browser.newContext({ baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      await login(page);
      await seed(page, deployHost);
    } finally {
      await context.close();
    }
  });

  test.afterAll(async ({ browser }) => {
    test.setTimeout(3 * 60_000);
    const context = await browser.newContext({ baseURL: BASE_URL });
    try {
      const page = await context.newPage();
      await login(page);
      await teardown(page);
    } finally {
      await context.close();
    }
  });

  test.beforeEach(async ({ page }) => {
    await login(page);
  });

  for (const screen of SCREENS) {
    test(`A1 ${screen.name}: text contrast meets the design-system thresholds in light and dark`, async ({ page }) => {
      for (const theme of THEMES) {
        await show(page, screen, theme, 1280);
        const violations = await page.evaluate(scanContrast);
        expect.soft(violations, `${screen.name} [${theme}]`).toEqual([]);
      }
    });

    test(`A2 ${screen.name}: no horizontal scroll or clipping at 375/900/1280/1920 px in light and dark`, async ({ page }) => {
      test.setTimeout(3 * 60_000);
      for (const theme of THEMES) {
        for (const width of WIDTHS) {
          await show(page, screen, theme, width);
          const problems = await page.evaluate(scanLayout);
          expect(problems, `${screen.name} at ${String(width)}px [${theme}]`).toEqual([]);
          if (width === 1280 || (width === 375 && screen.name === 'service')) {
            await capture(page, `${screen.name}-${String(width)}-${theme}.png`);
          }
        }
      }
    });

    test(`A3 ${screen.name}: reduced motion leaves no moving transition or animation`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await show(page, screen, 'dark', 1280);
      expect(await page.evaluate(scanMotion), screen.name).toEqual([]);
      if (screen.sheet !== undefined) {
        const transform = await page.getByTestId(screen.sheet.testId).evaluate((el) => getComputedStyle(el).transform);
        expect(['none', 'matrix(1, 0, 0, 1, 0, 0)']).toContain(transform);
      }
    });
  }

  for (const screen of SCREENS) {
    test(`H1 ${screen.name}: axe reports no serious or critical violation in light and dark`, async ({ page }) => {
      for (const theme of THEMES) {
        await show(page, screen, theme, 1280);
        const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
        const blocking = results.violations
          .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
          .map((violation) => ({
            rule: violation.id,
            impact: violation.impact,
            targets: violation.nodes.slice(0, 5).map((node) => node.target.join(' ')),
          }));
        expect.soft(blocking, `${screen.name} [${theme}]`).toEqual([]);
      }
    });
  }

  for (const screen of SCREENS.filter((candidate) => candidate.sheet === undefined)) {
    test(`H1 ${screen.name}: every control is keyboard reachable in document order with a visible focus ring`, async ({ page }) => {
      for (const theme of THEMES) {
        await show(page, screen, theme, 1280);
        const stops = await tabWalk(page);
        expect(stops.length, `${screen.name} [${theme}] has focusable controls`).toBeGreaterThan(3);
        const outOfOrder = stops.filter((stop, index) => index > 0 && stop.order < (stops[index - 1]?.order ?? -1)).map((stop) => stop.where);
        expect(outOfOrder, `${screen.name} [${theme}] tab order follows the document`).toEqual([]);
        const noRing = stops.filter((stop) => !stop.ringVisible).map((stop) => stop.where);
        expect(noRing, `${screen.name} [${theme}] focus ring visible`).toEqual([]);
        const faintRing = stops.filter((stop) => stop.ringContrast < 3).map((stop) => `${stop.where} ${String(stop.ringContrast)}`);
        expect(faintRing, `${screen.name} [${theme}] focus ring contrast >= 3`).toEqual([]);
        expect(await page.evaluate(unreachedTabbables, null), `${screen.name} [${theme}] unreachable controls`).toEqual([]);
      }
    });
  }

  for (const screen of SCREENS.filter((candidate) => candidate.sheet !== undefined)) {
    test(`H1 ${screen.name}: opened from the keyboard, traps focus with a visible ring and restores it on Escape`, async ({ page }) => {
      const sheet = screen.sheet;
      if (sheet === undefined) throw new Error('not a sheet');
      for (const theme of THEMES) {
        await page.setViewportSize({ width: 1280, height: 900 });
        await page.emulateMedia({ colorScheme: theme });
        await SCREENS.find((candidate) => candidate.name === (screen.name === 'project-sheet' ? 'projects' : 'project'))?.open(page);
        await applyTheme(page, theme);
        const trigger = sheet.trigger(page);
        await trigger.focus();
        await page.keyboard.press('Enter');
        const panel = page.getByTestId(sheet.testId);
        await expect(panel).toBeVisible();
        await settle(page);

        const stops: FocusStop[] = [];
        for (let step = 0; step < 30; step += 1) {
          await page.keyboard.press(step < 25 ? 'Tab' : 'Shift+Tab');
          const inside = await panel.evaluate((el) => el.contains(document.activeElement));
          expect(inside, `${screen.name} [${theme}] focus stays in the sheet after ${String(step + 1)} keys`).toBe(true);
          const stop = await page.evaluate(inspectFocus, step);
          if (stop !== null) stops.push(stop);
        }
        expect(stops.filter((stop) => !stop.ringVisible).map((stop) => stop.where), `${screen.name} [${theme}] focus ring`).toEqual([]);
        expect(
          stops.filter((stop) => stop.ringContrast < 3).map((stop) => `${stop.where} ${String(stop.ringContrast)}`),
          `${screen.name} [${theme}] focus ring contrast`,
        ).toEqual([]);
        expect(await page.evaluate(unreachedTabbables, `[data-testid="${sheet.testId}"]`), `${screen.name} [${theme}] unreachable`).toEqual([]);

        await page.keyboard.press('Escape');
        await expect(panel).toBeHidden();
        await expect(trigger).toBeFocused();
      }
    });
  }

  test('H1 service, inspector and history convey status with text, not color alone', async ({ page }) => {
    await page.goto(`${serviceHref(fx.imageServiceId)}?deployment=${fx.deploymentId}`);
    await expect(page.getByTestId('build-log-status')).toBeVisible();
    await expect(page.getByTestId(`deployment-row-${fx.deploymentId}`)).toBeVisible();
    const silent = await page.evaluate(() =>
      Array.from(
        document.querySelectorAll(
          '[data-status], [data-severity], [data-testid="service-status-pill"], [data-testid="build-log-status"], [data-testid="deployment-status"]',
        ),
      )
        .filter((el) => {
          const text = (el as HTMLElement).innerText.trim();
          const named = el.getAttribute('aria-label') ?? '';
          return text === '' && named.trim() === '';
        })
        .map((el) => el.getAttribute('data-testid') ?? el.tagName.toLowerCase()),
    );
    expect(silent).toEqual([]);
    await expect(page.getByTestId('service-status-pill')).toHaveText(/\S/);
    await expect(page.getByTestId('build-log-status')).toHaveText(/\S/);
  });

  test.describe('H2 long content at 375 px', () => {
    const longName = (): string => {
      const head = `${fx.longProjectName} `;
      return (head + 'settlement-reconciliation-'.repeat(10)).slice(0, LONG_NAME_LENGTH);
    };

    /** Replaces the long project's name in every real /api/projects response. */
    async function injectLongName(page: Page): Promise<void> {
      const name = longName();
      expect(Array.from(name)).toHaveLength(LONG_NAME_LENGTH);
      await page.route(/\/api\/projects(\/[^/?]+)?(\?.*)?$/, async (route) => {
        const response = await route.fetch();
        const text = await response.text();
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          await route.fulfill({ response, body: text });
          return;
        }
        const swap = (value: unknown): unknown => {
          if (Array.isArray(value)) return value.map(swap);
          if (value !== null && typeof value === 'object') {
            const record = Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, swap(inner)]));
            if (record.id === fx.longProjectId && typeof record.name === 'string') record.name = name;
            return record;
          }
          return value;
        };
        await route.fulfill({ response, json: swap(json) });
      });
    }

    /** 10,000 build-log lines in 100 chunks, one of them a 2,000-character unbroken line. */
    async function injectLongLog(page: Page): Promise<void> {
      await page.route(`**/api/deployments/${fx.deploymentId}/logs**`, async (route) => {
        const url = new URL(route.request().url());
        const first = (url.searchParams.get('since') ?? '0') === '0' && (url.searchParams.get('phase') ?? 'prepare') === 'prepare';
        const linesPerChunk = LONG_LOG_LINES / 100;
        const items = first
          ? Array.from({ length: 100 }, (_unused, chunk) => {
              const lines = Array.from({ length: linesPerChunk }, (_u, i) => {
                const n = chunk * linesPerChunk + i + 1;
                return n === LONG_LOG_LINES - 5
                  ? `#${String(n)} ${'x'.repeat(2_000)}`
                  : `#${String(n)} [build] step ${String(n)}/10000 : RUN pnpm install --frozen-lockfile`;
              });
              const text = `${lines.join('\n')}\n`;
              return { phase: 'build', seq: chunk + 1, text, byteLength: text.length, createdAt: new Date().toISOString() };
            })
          : [];
        await route.fulfill({ status: 200, json: { items, hasMore: false } });
      });
    }

    for (const theme of THEMES) {
      test(`H2 [${theme}] a 200-character project name, a 300-character repo URL and a 10,000-line build log`, async ({ page }) => {
        test.setTimeout(2 * 60_000);
        await page.setViewportSize({ width: 375, height: 812 });
        await page.emulateMedia({ colorScheme: theme });
        await injectLongName(page);
        await injectLongLog(page);

        await page.goto('/projects');
        await expect(page.getByTestId('projects-list')).toContainText(longName().slice(0, 40));
        await applyTheme(page, theme);
        await settle(page);
        expect(await page.evaluate(scanLayout), `projects [${theme}]`).toEqual([]);
        await capture(page, `stress-projects-375-${theme}.png`);

        await page.goto(`/projects/${fx.longProjectId}`);
        await expect(page.getByTestId('environments-empty')).toBeVisible();
        await applyTheme(page, theme);
        await settle(page);
        expect(await page.evaluate(scanLayout), `long project [${theme}]`).toEqual([]);

        await page.goto(serviceHref(fx.gitServiceId));
        await expect(page.getByTestId('service-fact-repository')).toContainText('service-catalog-component');
        await applyTheme(page, theme);
        await settle(page);
        expect(await page.evaluate(scanLayout), `git service [${theme}]`).toEqual([]);
        await capture(page, `stress-service-375-${theme}.png`);

        await page.goto(`${serviceHref(fx.imageServiceId)}?deployment=${fx.deploymentId}`);
        const log = page.getByRole('log', { name: 'Build log' });
        await expect(log).toContainText(`#${String(LONG_LOG_LINES)} [build]`);
        await expect(page.getByTestId('build-log-panel')).toContainText('Showing the last 2,000 lines.');
        await applyTheme(page, theme);
        await settle(page);
        expect(await page.evaluate(scanLayout), `10k-line build log [${theme}]`).toEqual([]);
        await capture(page, `stress-build-log-375-${theme}.png`);
      });
    }
  });

  // 14-13: the 375 px debt from the Phase 13 review (docs/ui-review/phase-13/REPORT.md, Layout and
  // Progressive disclosure). A 300-character unbroken service name is injected into the real
  // service responses (the domain caps names well below that); the 300-character repo URL is real.
  test.describe('14-13 375 px layout', () => {
    const LONG_SERVICE_NAME = 'checkoutsettlementreconciliationworker'.repeat(8).slice(0, 300);
    const HOSTILE_URL_MARKUP = '<img src=x onerror="window.__noodaraXss=1">';
    const MAIN_SCREENS = SCREENS.filter((screen) => ['projects', 'project', 'service'].includes(screen.name));

    /** Swaps the git service's name (and, with `hostileUrl`, its repository URL) in every real
     *  services response. */
    async function injectLongService(page: Page, options: { readonly hostileUrl?: boolean } = {}): Promise<void> {
      await page.route(/\/api\/projects\/[^/?]+\/services(\/[^/?]+)?(\?.*)?$/, async (route) => {
        const response = await route.fetch();
        const text = await response.text();
        let json: unknown;
        try {
          json = JSON.parse(text);
        } catch {
          await route.fulfill({ response, body: text });
          return;
        }
        const swap = (value: unknown): unknown => {
          if (Array.isArray(value)) return value.map(swap);
          if (value !== null && typeof value === 'object') {
            const record = Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, swap(inner)]));
            if (record.id === fx.gitServiceId && typeof record.name === 'string') {
              record.name = LONG_SERVICE_NAME;
              if (options.hostileUrl === true && typeof record.repositoryUrl === 'string') {
                record.repositoryUrl = `${record.repositoryUrl}${HOSTILE_URL_MARKUP}`;
              }
            }
            return record;
          }
          return value;
        };
        await route.fulfill({ response, json: swap(json) });
      });
    }

    async function openGitService(page: Page, theme: Theme, width: number): Promise<void> {
      await page.setViewportSize({ width, height: 900 });
      await page.emulateMedia({ colorScheme: theme });
      await page.goto(serviceHref(fx.gitServiceId));
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(LONG_SERVICE_NAME);
      await expect(page.getByTestId('service-fact-repository')).toContainText('service-catalog-component');
      await applyTheme(page, theme);
      await settle(page);
    }

    async function noHorizontalScroll(page: Page, where: string): Promise<void> {
      const widths = await page.evaluate(() => ({
        scroll: document.documentElement.scrollWidth,
        client: document.documentElement.clientWidth,
      }));
      expect(widths.scroll, `${where}: scrollWidth <= clientWidth`).toBeLessThanOrEqual(widths.client);
      expect(await page.evaluate(scanLayout), where).toEqual([]);
    }

    test('A1 the service title keeps 12 characters and the toolbar stays on one row at 375 px', async ({ page }) => {
      await injectLongService(page);
      for (const theme of THEMES) {
        await openGitService(page, theme, 375);
        const toolbar = page.getByTestId('service-toolbar');
        await expect(toolbar).toHaveAttribute('data-layout', 'compact');
        const title = await page.getByRole('heading', { level: 1 }).evaluate((h1) => {
          const text = h1.firstChild;
          if (text === null || text.nodeType !== Node.TEXT_NODE) return null;
          const range = document.createRange();
          range.setStart(text, 0);
          range.setEnd(text, 12);
          const probe = document.createElement('span');
          probe.style.font = getComputedStyle(h1).font;
          probe.style.position = 'absolute';
          probe.textContent = '…';
          document.body.append(probe);
          const ellipsis = probe.getBoundingClientRect().width;
          probe.remove();
          return { box: h1.clientWidth, twelve: range.getBoundingClientRect().width, ellipsis };
        });
        expect(title, 'title text node').not.toBeNull();
        expect(title?.box ?? 0, `[${theme}] title shows its first 12 characters`).toBeGreaterThanOrEqual(
          (title?.twelve ?? Infinity) + (title?.ellipsis ?? 0),
        );
        const rows = await toolbar.evaluate((bar) => {
          const parts = ['a[href]', '[data-testid="service-title"]', '[data-testid="service-actions-menu"]', '[data-testid="service-deploy"]']
            .map((selector) => bar.querySelector(selector))
            .filter((el): el is Element => el !== null)
            .map((el) => el.getBoundingClientRect());
          return { count: parts.length, maxTop: Math.max(...parts.map((r) => r.top)), minBottom: Math.min(...parts.map((r) => r.bottom)) };
        });
        expect(rows.count, `[${theme}] back, title, menu and Deploy are in the bar`).toBe(4);
        expect(rows.maxTop, `[${theme}] all controls share one row`).toBeLessThan(rows.minBottom);
        await expect(page.getByTestId('service-edit')).toHaveCount(0);
        await expect(page.getByTestId('service-logs')).toHaveCount(0);
      }
    });

    test('A2 the 300-character repo URL truncates in the middle inside its card, the full value on demand', async ({ page }) => {
      await injectLongService(page);
      for (const theme of THEMES) {
        await openGitService(page, theme, 375);
        const row = page.getByTestId('service-fact-repository');
        const geometry = await row.evaluate((el) => {
          const card = el.closest('[data-testid="service-facts-source"]') ?? el;
          const value = el.querySelector('[data-mono]');
          const tail = el.querySelector('[data-part="tail"]');
          const right = (node: Element | null): number => node?.getBoundingClientRect().right ?? Infinity;
          return {
            cardRight: card.getBoundingClientRect().right,
            valueRight: right(value),
            tailRight: right(tail),
            tailText: tail?.textContent ?? '',
            title: value?.getAttribute('title') ?? '',
          };
        });
        expect(geometry.valueRight, `[${theme}] value inside the card`).toBeLessThanOrEqual(geometry.cardRight);
        expect(geometry.tailRight, `[${theme}] the URL's end is visible`).toBeLessThanOrEqual(geometry.cardRight);
        expect(geometry.title).toHaveLength(LONG_REPO_URL_LENGTH);
        expect(geometry.title.endsWith(geometry.tailText)).toBe(true);
        const copy = page.getByRole('button', { name: 'Copy Repository' });
        await expect(copy).toBeVisible();
        expect(await copy.evaluate((el) => getComputedStyle(el, '::after').height)).toBe('44px');
        await capture(page, `stress-service-375-${theme}.png`, SHOTS_DIR_14);
      }
    });

    test('A3 the 375 px projects list truncates the description before the project name', async ({ page }) => {
      for (const theme of THEMES) {
        await show(page, SCREENS[0] as Screen, theme, 375);
        const row = page.getByTestId('projects-list').locator('[data-row="true"]', { hasText: fx.projectName });
        const cells = await row.evaluate((el) => {
          const [name, description] = Array.from(el.querySelectorAll(':scope > a > span, :scope > button > span'));
          const cell = (node: Element | undefined) => ({ scroll: node?.scrollWidth ?? 0, client: node?.clientWidth ?? 0 });
          // scrollWidth rounds: a sub-pixel squeeze still draws an ellipsis, so compare the text's own box.
          const text = name?.firstElementChild?.getBoundingClientRect().width ?? Infinity;
          return { name: cell(name), description: cell(description), nameText: text, nameBox: name?.getBoundingClientRect().width ?? 0 };
        });
        expect(cells.name.scroll, `[${theme}] name not truncated`).toBeLessThanOrEqual(cells.name.client);
        expect(cells.nameText, `[${theme}] name not squeezed by a sub-pixel`).toBeLessThanOrEqual(cells.nameBox);
        expect(cells.description.scroll, `[${theme}] description truncated`).toBeGreaterThan(cells.description.client);
        await capture(page, `stress-projects-375-${theme}.png`, SHOTS_DIR_14);
      }
    });

    test('the 375 px status row keeps the status word whole (the caption takes the leftover width)', async ({ page }) => {
      await injectLongService(page);
      for (const theme of THEMES) {
        await openGitService(page, theme, 375);
        const value = page.getByTestId('service-fact-status').locator('[data-mono]');
        const lines = await value.evaluate((el) => el.getBoundingClientRect().height / parseFloat(getComputedStyle(el).lineHeight));
        expect(lines, `[${theme}] status word wraps`).toBeLessThan(1.5);
      }
    });

    test('H1 the overflow menu is keyboard operable at 375 px: labelled, expanded state, focus trapped, Escape returns focus', async ({ page }) => {
      await injectLongService(page);
      await openGitService(page, 'dark', 375);
      const trigger = page.getByTestId('service-actions-menu');
      await expect(trigger).toHaveAccessibleName(`Actions for ${LONG_SERVICE_NAME}`);
      await expect(trigger).toHaveAttribute('aria-expanded', 'false');
      const box = await trigger.boundingBox();
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(44);
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(44);
      const back = await page.getByRole('link', { name: `Back to ${fx.projectName}` }).boundingBox();
      expect(Math.min(back?.width ?? 0, back?.height ?? 0)).toBeGreaterThanOrEqual(44);
      expect(await page.getByTestId('service-deploy').evaluate((el) => getComputedStyle(el, '::after').height)).toBe('44px');

      await trigger.focus();
      await page.keyboard.press('Enter');
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await expect(menu.getByRole('menuitem', { name: 'Edit' })).toBeFocused();
      for (let step = 0; step < 9; step += 1) {
        await page.keyboard.press(step % 3 === 2 ? 'Shift+Tab' : 'Tab');
        expect(await menu.evaluate((el) => el.contains(document.activeElement)), `focus stays in the menu after ${String(step + 1)} keys`).toBe(true);
      }
      await page.keyboard.press('Escape');
      await expect(menu).toBeHidden();
      await expect(trigger).toBeFocused();
    });

    test('H1 axe reports no serious or critical violation on the three screens at 375 px', async ({ page }) => {
      await injectLongService(page);
      for (const screen of MAIN_SCREENS) {
        for (const theme of THEMES) {
          await show(page, screen, theme, 375);
          const results = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'best-practice']).analyze();
          const blocking = results.violations
            .filter((violation) => violation.impact === 'serious' || violation.impact === 'critical')
            .map((violation) => ({ rule: violation.id, targets: violation.nodes.slice(0, 5).map((node) => node.target.join(' ')) }));
          expect.soft(blocking, `${screen.name} at 375 [${theme}]`).toEqual([]);
        }
      }
    });

    test('H2 no horizontal scroll at 375 and 1280 px with a 300-character service name and repo URL', async ({ page }) => {
      test.setTimeout(3 * 60_000);
      await injectLongService(page);
      for (const theme of THEMES) {
        for (const width of [375, 1280] as const) {
          for (const screen of MAIN_SCREENS) {
            await show(page, screen, theme, width);
            await noHorizontalScroll(page, `${screen.name} at ${String(width)} [${theme}]`);
            await capture(page, `${screen.name}-${String(width)}-${theme}.png`, SHOTS_DIR_14);
          }
          await openGitService(page, theme, width);
          await noHorizontalScroll(page, `long service at ${String(width)} [${theme}]`);
          // The long title must give way to the status pill, never push it over the actions.
          const edges = await page.evaluate(() => ({
            pill: document.querySelector('[data-testid="service-status-pill"]')?.getBoundingClientRect().right ?? Infinity,
            title: document.querySelector('[data-testid="service-title"]')?.getBoundingClientRect().right ?? 0,
          }));
          expect(edges.pill, `pill inside the title block at ${String(width)} [${theme}]`).toBeLessThanOrEqual(edges.title + 0.5);
          if (width === 1280) await capture(page, `stress-service-1280-${theme}.png`, SHOTS_DIR_14);
        }
      }
    });

    test('H2 the repository URL renders as inert text, never HTML', async ({ page }) => {
      await injectLongService(page, { hostileUrl: true });
      await openGitService(page, 'light', 375);
      const row = page.getByTestId('service-fact-repository');
      await expect(row).toContainText(HOSTILE_URL_MARKUP);
      await expect(row.locator('img')).toHaveCount(0);
      expect(await page.evaluate(() => (window as unknown as { __noodaraXss?: number }).__noodaraXss)).toBeUndefined();
    });
  });
});
