import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  classifyDelivery,
  createFixedWindowLimiter,
  createWebhookRateLimiter,
  verifyGithubSignature,
  type DeliveryServiceState,
} from './webhook-ingest.js';

const SECRET = 'a'.repeat(64);
const sign = (secret: string, body: Buffer | string): string =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('verifyGithubSignature (A2, H1)', () => {
  const body = Buffer.from('{"zen":"Keep it logically awesome.",  "hook_id":1}\n');

  it('accepts the HMAC of the raw bytes, upper- or lowercase hex', () => {
    expect(verifyGithubSignature(SECRET, body, sign(SECRET, body))).toBe(true);
    const upper = `sha256=${sign(SECRET, body).slice('sha256='.length).toUpperCase()}`;
    expect(verifyGithubSignature(SECRET, body, upper)).toBe(true);
  });

  it('rejects a missing, malformed or wrong signature', () => {
    expect(verifyGithubSignature(SECRET, body, undefined)).toBe(false);
    expect(verifyGithubSignature(SECRET, body, '')).toBe(false);
    expect(verifyGithubSignature(SECRET, body, sign(SECRET, body).replace('sha256=', 'sha1='))).toBe(false);
    expect(verifyGithubSignature(SECRET, body, `sha256=${'z'.repeat(64)}`)).toBe(false);
    expect(verifyGithubSignature(SECRET, body, sign('b'.repeat(64), body))).toBe(false);
  });

  it('rejects a length mismatch without throwing from timingSafeEqual', () => {
    const good = sign(SECRET, body);
    expect(() => verifyGithubSignature(SECRET, body, good.slice(0, -2))).not.toThrow();
    expect(verifyGithubSignature(SECRET, body, good.slice(0, -2))).toBe(false);
    expect(verifyGithubSignature(SECRET, body, `${good}00`)).toBe(false);
    expect(verifyGithubSignature(SECRET, body, 'sha256=')).toBe(false);
  });

  it('fails when the body is re-serialized (signature covers the bytes as received)', () => {
    const reserialized = Buffer.from(JSON.stringify(JSON.parse(body.toString('utf8'))));
    expect(reserialized.equals(body)).toBe(false);
    expect(verifyGithubSignature(SECRET, reserialized, sign(SECRET, body))).toBe(false);
  });

  it('fails against a rotated-out secret', () => {
    const rotated = 'c'.repeat(64);
    expect(verifyGithubSignature(rotated, body, sign(SECRET, body))).toBe(false);
    expect(verifyGithubSignature(rotated, body, sign(rotated, body))).toBe(true);
  });
});

describe('createFixedWindowLimiter (A3, H1)', () => {
  it('allows `limit` hits per window and resets after it', () => {
    let t = 0;
    const limiter = createFixedWindowLimiter({ limit: 2, windowMs: 1000, maxKeys: 10, now: () => t });
    expect([limiter.hit('k'), limiter.hit('k'), limiter.hit('k'), limiter.hit('k')]).toEqual([true, true, false, false]);
    t = 999;
    expect(limiter.hit('k')).toBe(false);
    t = 1000;
    expect(limiter.hit('k')).toBe(true);
  });

  it('never tracks more than maxKeys keys (oldest evicted)', () => {
    let t = 0;
    const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 60_000, maxKeys: 3, now: () => t });
    for (let i = 0; i < 1000; i += 1) {
      t = i;
      limiter.hit(`ip-${String(i)}`);
      expect(limiter.size()).toBeLessThanOrEqual(3);
    }
    expect(limiter.size()).toBe(3);
  });

  it('prunes expired windows when a new key arrives', () => {
    let t = 0;
    const limiter = createFixedWindowLimiter({ limit: 1, windowMs: 100, maxKeys: 100, now: () => t });
    limiter.hit('a');
    limiter.hit('b');
    t = 150;
    limiter.hit('c');
    expect(limiter.size()).toBe(1);
  });
});

describe('createWebhookRateLimiter (A3)', () => {
  const limits = { perHook: { limit: 2, windowMs: 1000 }, perIp: { limit: 3, windowMs: 1000 }, maxKeys: 100 };

  it('caps one hook across many IPs', () => {
    const limiter = createWebhookRateLimiter(limits, () => 0);
    expect([limiter.allow('h', '1'), limiter.allow('h', '2'), limiter.allow('h', '3')]).toEqual([true, true, false]);
    expect(limiter.allow('other', '4')).toBe(true);
  });

  it('caps one IP across many hooks', () => {
    const limiter = createWebhookRateLimiter(limits, () => 0);
    expect(['a', 'b', 'c', 'd'].map((hook) => limiter.allow(hook, '9'))).toEqual([true, true, true, false]);
  });
});

describe('classifyDelivery', () => {
  const git: DeliveryServiceState = {
    sourceType: 'git',
    repositoryUrl: 'https://github.com/acme/api.git',
    branch: 'main',
    projectArchived: false,
  };
  const sha = 'f'.repeat(40);
  const push = (over: Record<string, unknown> = {}): Buffer =>
    Buffer.from(
      JSON.stringify({
        ref: 'refs/heads/main',
        after: sha,
        deleted: false,
        repository: { clone_url: 'https://github.com/acme/api.git', ssh_url: 'git@github.com:acme/api.git' },
        ...over,
      }),
    );

  it('deploys a matching push with its SHA', () => {
    expect(classifyDelivery(git, 'push', push())).toEqual({ kind: 'deploy', sha });
  });

  it('answers ping 200 and ignores other events 200', () => {
    expect(classifyDelivery(git, 'ping', Buffer.from('{"zen":"z","hook_id":7}'))).toEqual({ kind: 'record', outcome: 'ping', status: 200 });
    expect(classifyDelivery(git, 'issues', Buffer.from('{}'))).toEqual({ kind: 'record', outcome: 'ignored_event', status: 200 });
  });

  it('records ignored refs 200 and rejects bad payloads, SHAs and repositories 422', () => {
    expect(classifyDelivery(git, 'push', push({ ref: 'refs/heads/dev' }))).toMatchObject({ outcome: 'ignored_branch', status: 200 });
    expect(classifyDelivery(git, 'push', push({ ref: 'refs/tags/v1' }))).toMatchObject({ outcome: 'ignored_tag', status: 200 });
    expect(classifyDelivery(git, 'push', push({ deleted: true }))).toMatchObject({ outcome: 'ignored_deletion', status: 200 });
    expect(classifyDelivery(git, 'push', Buffer.from('not json'))).toMatchObject({ outcome: 'invalid_payload', status: 422 });
    expect(classifyDelivery(git, 'ping', Buffer.from('not json'))).toMatchObject({ outcome: 'invalid_payload', status: 422 });
    expect(
      classifyDelivery(git, 'push', push({ repository: { clone_url: 'https://github.com/evil/api.git', ssh_url: 'git@github.com:evil/api.git' } })),
    ).toMatchObject({ outcome: 'repository_mismatch', status: 422 });
  });

  it('never deploys an image service or an archived project (H3)', () => {
    expect(classifyDelivery({ ...git, sourceType: 'image', repositoryUrl: null, branch: null }, 'push', push())).toMatchObject({
      kind: 'record',
      outcome: 'source_not_git',
    });
    expect(classifyDelivery({ ...git, projectArchived: true }, 'push', push())).toMatchObject({
      kind: 'record',
      outcome: 'project_archived',
    });
  });
});
