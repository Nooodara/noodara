import { describe, expect, it } from 'vitest';
import { createLogger, writableForTests } from './logger.js';

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

    const serialized = JSON.stringify(records());
    expect(serialized).not.toContain(credentialCanary);
    expect(serialized).not.toContain('BEGIN OPENSSH PRIVATE KEY');
  });
});

describe('createLogger err serialization (T-4-10, T-4-38)', () => {
  it('never puts a logged error\'s message or stack on the wire, only its name', () => {
    const { stream, records } = writableForTests();
    const logger = createLogger({ level: 'info', destination: stream });
    const secretMessage = 'CANARY-SECRET-BEARING-MESSAGE-DO-NOT-LEAK';

    logger.error({ err: new Error(secretMessage) }, 'boom');

    const [record] = records() as unknown as [{ err: { name: string; message?: string; stack?: string } }];
    expect(record.err.name).toBe('Error');
    expect(record.err.message).toBeUndefined();
    expect(record.err.stack).toBeUndefined();
    const serialized = JSON.stringify(records());
    expect(serialized).not.toContain(secretMessage);
    expect(serialized).not.toContain('stack');
  });

  it('keeps the specific error class name for a non-generic Error subtype', () => {
    const { stream, records } = writableForTests();
    const logger = createLogger({ level: 'info', destination: stream });

    logger.error({ err: new TypeError('some type error') }, 'boom');

    const [record] = records() as unknown as [{ err: { name: string } }];
    expect(record.err.name).toBe('TypeError');
  });

  it('serializes a non-Error err value to name UnknownError without echoing the value', () => {
    const { stream, records } = writableForTests();
    const logger = createLogger({ level: 'info', destination: stream });

    logger.error({ err: 'a raw string, not an Error instance' }, 'boom');

    const [record] = records() as unknown as [{ err: { name: string } }];
    expect(record.err.name).toBe('UnknownError');
    const serialized = JSON.stringify(records());
    expect(serialized).not.toContain('a raw string, not an Error instance');
  });

  it('still redacts req.headers.cookie alongside the new err serializer', () => {
    const { stream, records } = writableForTests();
    const logger = createLogger({ level: 'info', destination: stream });

    logger.info({ req: { headers: { cookie: 'session=abc123' } } }, 'request received');

    const [record] = records() as unknown as [{ req: { headers: { cookie: string } } }];
    expect(record.req.headers.cookie).toBe('[REDACTED]');
  });
});
