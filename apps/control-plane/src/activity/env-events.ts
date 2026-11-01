// 23-02 (A1): the activity event a variable write records in the same transaction as the row.
// Metadata is exactly { scope, key }: never the value and never a secret reference.
import type { EnvAction } from '@noodara/domain/activity';
import type { EnvScope } from '@noodara/domain';
import { writeActivityEvent, type ActivityWriteHandle } from './write-activity-event.js';

export interface EnvVariableEventInput {
  readonly actor: { readonly type: 'user'; readonly id: string } | { readonly type: 'system' };
  readonly action: EnvAction;
  readonly variableId: string;
  readonly scope: EnvScope;
  readonly key: string;
}

export function writeEnvVariableEvent(handle: ActivityWriteHandle, input: EnvVariableEventInput, at: Date): Promise<string> {
  return writeActivityEvent(
    handle,
    {
      actorType: input.actor.type,
      actorId: input.actor.type === 'user' ? input.actor.id : null,
      entityType: 'environment_variable',
      entityId: input.variableId,
      action: input.action,
      outcome: 'success',
      metadata: { scope: input.scope, key: input.key },
    },
    at,
  );
}
