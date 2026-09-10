import { describe, expect, it } from 'vitest';
import { createLogger, writableForTests } from './logger.js';

interface LoggedRecord {
  level: number;
  msg?: string;
  [key: string]: unknown;
}

describe('createLogger redaction', () => {
  it('redacts req.headers.cookie, req.headers.authorization and req.body.password', () => {
    const { stream, records } = writableForTests();
    const logger = createLogger({ level: 'info', destination: stream });

    logger.info(
      {
        req: {
          headers: { cookie: 'session=abc123', authorization: 'Bearer real-token' },
          body: { password: 'super-secret' },
        },
      },
      'request received',
    );

    const [record] = records() as unknown as [
      { req: { headers: { cookie: string; authorization: string }; body: { password: string } } },
    ];
    expect(record.req.headers.cookie).toBe('[REDACTED]');
    expect(record.req.headers.authorization).toBe('[REDACTED]');
    expect(record.req.body.password).toBe('[REDACTED]');
  });

  it('canary: never leaks a nested credential, encryptedCredential or SSH private key value', () => {
    const { stream, records } = writableForTests();
    const logger = createLogger({ level: 'info', destination: stream });
    const credentialCanary = 'CANARY-CREDENTIAL-VALUE-DO-NOT-LEAK';
    const sshKeyCanary =
      '-----BEGIN OPENSSH PRIVATE KEY-----\nCANARY-KEY-BODY\n-----END OPENSSH PRIVATE KEY-----';

    logger.info(
      {
        server: { credential: credentialCanary },
        discoverySnapshot: { encryptedCredential: credentialCanary },
        req: { body: { sshPrivateKey: sshKeyCanary } },
      },
      'canary check',
    );

    const serialized = JSON.stringify(records() as unknown as LoggedRecord[]);
    expect(serialized).not.toContain(credentialCanary);
    expect(serialized).not.toContain('BEGIN OPENSSH PRIVATE KEY');
  });
});
