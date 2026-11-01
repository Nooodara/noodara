// 23-03 (A2, H1): the activity event a secret write records in the same transaction as the row.
// Metadata is exactly { scope, name }: never the value and never its hint.
import type { SecretAction } from '@noodara/domain/activity';
import type { EnvScope } from '@noodara/domain';
import { writeActivityEvent, type ActivityWriteHandle } from './write-activity-event.js';

export interface SecretEventInput {
  readonly actor: { readonly type: 'user'; readonly id: string } | { readonly type: 'system' };
  readonly action: SecretAction;
  readonly secretId: string;
  readonly scope: EnvScope;
  readonly name: string;
}

export function writeSecretEvent(handle: ActivityWriteHandle, input: SecretEventInput, at: Date): Promise<string> {
  return writeActivityEvent(
    handle,
    {
      actorType: input.actor.type,
      actorId: input.actor.type === 'user' ? input.actor.id : null,
      entityType: 'secret',
      entityId: input.secretId,
      action: input.action,
      outcome: 'success',
      metadata: { scope: input.scope, name: input.name },
    },
    at,
  );
}
