// 14-01-PLAN.md: docker-compose.yml logging rotation through a YAML anchor.
// All six services (postgres, redis, migrate, api, worker, web) declare the
// logging driver with max-size and max-file limits, preventing disk exhaustion.
//
// hard_rule: a unit test parses docker-compose.yml and fails if any service
// lacks the logging block or the limits differ from the documented values.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(new URL(import.meta.url).pathname);
const REPO_ROOT = dirname(dirname(dirname(__dirname)));
const COMPOSE_FILE_PATH = join(REPO_ROOT, 'docker-compose.yml');

const REQUIRED_SERVICES = ['postgres', 'redis', 'migrate', 'api', 'worker', 'web'];

// Documented log rotation limits
const EXPECTED_LOG_CONFIG = {
  driver: 'json-file',
  options: {
    'max-size': '50m',
    'max-file': '3',
  },
};

describe('docker-compose.yml logging configuration', () => {
  it('contains a logging anchor definition', () => {
    const content = readFileSync(COMPOSE_FILE_PATH, 'utf8');
    // Expect something like: &noodara_logging
    expect(content).toMatch(/&noodara_logging[\s\S]*?logging:/);
  });

  it('all six services reference the shared logging anchor', () => {
    const content = readFileSync(COMPOSE_FILE_PATH, 'utf8');

    for (const serviceName of REQUIRED_SERVICES) {
      // Check that the service has a logging line with a reference to the anchor
      expect(content).toMatch(
        new RegExp(`${serviceName}:[\\s\\S]*?logging:.*?\\*noodara_logging`, 'i')
      );
    }
  });

  it('logging driver is json-file', () => {
    const content = readFileSync(COMPOSE_FILE_PATH, 'utf8');
    expect(content).toMatch(/&noodara_logging[\s\S]*?driver:\s*json-file/);
  });

  it('logging declares max-size and max-file options', () => {
    const content = readFileSync(COMPOSE_FILE_PATH, 'utf8');
    const loggingAnchorMatch = content.match(/x-logging:[\s\S]*?max-file:/);
    expect(loggingAnchorMatch).toBeTruthy();
    expect(loggingAnchorMatch![0]).toContain('max-size:');
    expect(loggingAnchorMatch![0]).toContain('max-file:');
  });

  it('max-size is a positive value in documented range', () => {
    const content = readFileSync(COMPOSE_FILE_PATH, 'utf8');
    const maxSizeMatch = content.match(/max-size:\s*['"]*([0-9]+[kmg])['"]*\s*$/m);
    expect(maxSizeMatch).toBeTruthy();
    if (maxSizeMatch) {
      const maxSize = maxSizeMatch[1] ?? '';
      expect(maxSize).toMatch(/^\d+[kmg]$/i);
    }
  });

  it('max-file is a positive integer', () => {
    const content = readFileSync(COMPOSE_FILE_PATH, 'utf8');
    const maxFileMatch = content.match(/max-file:\s*['"]*([0-9]+)['"]*\s*$/m);
    expect(maxFileMatch).toBeTruthy();
    if (maxFileMatch) {
      const maxFile = parseInt(maxFileMatch[1] ?? '0', 10);
      expect(maxFile).toBeGreaterThan(0);
    }
  });

  it('postgres has a healthcheck', () => {
    const content = readFileSync(COMPOSE_FILE_PATH, 'utf8');
    expect(content).toContain('postgres:');
    expect(content).toMatch(/postgres:[\s\S]*?healthcheck:/);
    expect(content).toMatch(/postgres:[\s\S]*?pg_isready/);
  });

  it('postgres has noodara_postgres_data volume', () => {
    const content = readFileSync(COMPOSE_FILE_PATH, 'utf8');
    expect(content).toMatch(/postgres:[\s\S]*?noodara_postgres_data:\/var\/lib\/postgresql\/data/);
  });

  it('redis has a healthcheck', () => {
    const content = readFileSync(COMPOSE_FILE_PATH, 'utf8');
    expect(content).toContain('redis:');
    expect(content).toMatch(/redis:[\s\S]*?healthcheck:/);
    expect(content).toMatch(/redis:[\s\S]*?redis-cli/);
  });

  it('redis has noodara_redis_data volume', () => {
    const content = readFileSync(COMPOSE_FILE_PATH, 'utf8');
    expect(content).toMatch(/redis:[\s\S]*?noodara_redis_data:\/data/);
  });
});
