// 28-02 (A1): the activity event an AI provider settings write records in the same transaction as
// the row. Metadata is exactly { provider, model }: never the key and never its hint.
import type { AiSettingsAction } from '@noodara/domain/activity';
import { writeActivityEvent, type ActivityWriteHandle } from './write-activity-event.js';

export interface AiSettingsEventInput {
  readonly actor: { readonly type: 'user'; readonly id: string } | { readonly type: 'system' };
  readonly action: AiSettingsAction;
  readonly settingsId: string;
  readonly provider: string;
  readonly model: string;
}

export function writeAiSettingsEvent(handle: ActivityWriteHandle, input: AiSettingsEventInput, at: Date): Promise<string> {
  return writeActivityEvent(
    handle,
    {
      actorType: input.actor.type,
      actorId: input.actor.type === 'user' ? input.actor.id : null,
      entityType: 'ai_provider_settings',
      entityId: input.settingsId,
      action: input.action,
      outcome: 'success',
      metadata: { provider: input.provider, model: input.model },
    },
    at,
  );
}
