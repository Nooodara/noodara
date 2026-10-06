import { describe, expect, it } from 'vitest';
import { DEPLOYMENT_STATUSES, SERVICE_STATUSES } from '@noodara/domain';
import {
  DEPLOYMENT_IN_PROGRESS_COPY,
  DEPLOYMENT_NOT_CANCELLABLE_COPY,
  deploymentStatusPresentation,
  formatDuration,
  isCancellable,
  isStateRaceCode,
  PROJECT_ARCHIVED_DEPLOY_COPY,
  SERVICE_ACTION_FAILED_COPY,
  serviceActionCopy,
  serviceStatusPresentation,
  shortSha,
  triggerWord,
} from './service-status-copy';

describe('serviceStatusPresentation (13-12 A1)', () => {
  it('has a word, tone and meaning for every derived status', () => {
    for (const status of SERVICE_STATUSES) {
      const presentation = serviceStatusPresentation(status);
      expect(presentation.word.length).toBeGreaterThan(0);
      expect(presentation.meaning.length).toBeGreaterThan(0);
    }
  });

  it('maps the five deploy outcomes to their tones', () => {
    expect(serviceStatusPresentation('RUNNING')).toMatchObject({
      word: 'Running',
      tone: 'ok',
    });
    expect(serviceStatusPresentation('STOPPED')).toMatchObject({
      word: 'Stopped',
      tone: 'idle',
    });
    expect(serviceStatusPresentation('DEPLOYING')).toMatchObject({
      word: 'Deploying',
      tone: 'warn',
      pulsing: true,
    });
    expect(serviceStatusPresentation('FAILED')).toMatchObject({
      word: 'Failed',
      tone: 'error',
    });
    expect(serviceStatusPresentation('NEVER_DEPLOYED')).toMatchObject({
      word: 'Never deployed',
      tone: 'idle',
    });
  });

  it('says honestly that UNKNOWN means the container could not be checked, not that it stopped', () => {
    const unknown = serviceStatusPresentation('UNKNOWN');
    expect(unknown.word).toBe('Unknown');
    expect(unknown.tone).not.toBe('error');
    expect(unknown.meaning).toMatch(/couldn't check the container/);
    expect(unknown.meaning).toMatch(/may still be running/);
  });

  it('treats an unrecognized value as UNKNOWN rather than guessing', () => {
    expect(serviceStatusPresentation('running')).toBe(serviceStatusPresentation('UNKNOWN'));
    expect(serviceStatusPresentation('__proto__')).toBe(serviceStatusPresentation('UNKNOWN'));
  });
});

describe('deployment presentation (13-12 A4)', () => {
  it('covers every deployment status', () => {
    for (const status of DEPLOYMENT_STATUSES) {
      expect(deploymentStatusPresentation(status).word).not.toBe(status);
    }
    expect(deploymentStatusPresentation('SUCCESS').tone).toBe('ok');
    expect(deploymentStatusPresentation('FAILED').tone).toBe('error');
    expect(deploymentStatusPresentation('CANCELLED').tone).toBe('idle');
    expect(deploymentStatusPresentation('BUILDING')).toMatchObject({
      tone: 'warn',
      pulsing: true,
    });
  });

  it('keeps an unknown status or trigger as plain text', () => {
    expect(deploymentStatusPresentation('WEIRD')).toEqual({
      word: 'WEIRD',
      tone: 'idle',
      pulsing: false,
    });
    expect(triggerWord('manual')).toBe('Manual');
    expect(triggerWord('redeploy')).toBe('Redeploy');
    expect(triggerWord('<b>x</b>')).toBe('<b>x</b>');
    expect(triggerWord('toString')).toBe('toString');
  });

  it('shortens a commit SHA to 7 characters and shows a placeholder when there is none', () => {
    expect(shortSha('0123456789abcdef0123456789abcdef01234567')).toBe('0123456');
    expect(shortSha(null)).toBe('—');
    expect(shortSha('')).toBe('—');
  });

  it('formats durations', () => {
    expect(formatDuration(null)).toBe('—');
    expect(formatDuration(-1)).toBe('—');
    expect(formatDuration(Number.NaN)).toBe('—');
    expect(formatDuration(4_400)).toBe('4s');
    expect(formatDuration(60_000)).toBe('1m');
    expect(formatDuration(95_000)).toBe('1m 35s');
    expect(formatDuration(3_600_000)).toBe('1h');
    expect(formatDuration(3_900_000)).toBe('1h 5m');
  });
});

describe('cancel and recovery copy (13-12 A3, A5, H1)', () => {
  it('allows cancel only for a queued or running deployment', () => {
    for (const status of ['QUEUED', 'PREPARING', 'BUILDING', 'DEPLOYING']) expect(isCancellable(status)).toBe(true);
    for (const status of ['SUCCESS', 'FAILED', 'CANCELLED', 'nope']) expect(isCancellable(status)).toBe(false);
  });

  it('gives fixed recovery copy and a generic fallback', () => {
    expect(serviceActionCopy('DEPLOYMENT_IN_PROGRESS')).toBe(DEPLOYMENT_IN_PROGRESS_COPY);
    expect(serviceActionCopy('DEPLOYMENT_NOT_CANCELLABLE')).toBe(DEPLOYMENT_NOT_CANCELLABLE_COPY);
    expect(serviceActionCopy('PROJECT_ARCHIVED')).toBe(PROJECT_ARCHIVED_DEPLOY_COPY);
    expect(serviceActionCopy('INTERNAL_ERROR')).toBe(SERVICE_ACTION_FAILED_COPY);
  });

  it('flags the codes that mean the state moved under the user', () => {
    expect(isStateRaceCode('DEPLOYMENT_IN_PROGRESS')).toBe(true);
    expect(isStateRaceCode('DEPLOYMENT_NOT_CANCELLABLE')).toBe(true);
    expect(isStateRaceCode('PROJECT_ARCHIVED')).toBe(false);
  });
});
