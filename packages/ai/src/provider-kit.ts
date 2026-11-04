import { AI_PROVIDER_MODELS } from '@noodara/domain/api-contract';
import type { SecretValue } from '@noodara/domain/security';
import type { AICallLimits } from './call.js';
import { AIProviderConfigError, unavailable } from './errors.js';
import type { AIToolCall, AIToolDefinition, ImplementedAIProviderId } from './types.js';

// SDK-free helpers shared by the provider implementations.

export interface ProviderConfig {
  /** Resolved only inside the provider, per call. */
  readonly apiKey: SecretValue;
  readonly model: string;
  /** Already validated by resolveBaseUrl. */
  readonly baseUrl: string;
  readonly limits: AICallLimits;
  readonly fetchImpl?: typeof fetch | undefined;
}

export const DEFAULT_MAX_TOKENS = 16_000;

export function resolveModel(id: ImplementedAIProviderId, model?: string): string {
  const allowed: readonly string[] = AI_PROVIDER_MODELS[id];
  const chosen = model ?? allowed[0];
  if (chosen === undefined || !allowed.includes(chosen)) throw new AIProviderConfigError('invalid_model');
  return chosen;
}

export function assertTools(tools: readonly AIToolDefinition[]): void {
  const names = new Set(tools.map((tool) => tool.name));
  if (tools.length === 0 || names.size !== tools.length) throw new AIProviderConfigError('invalid_request');
}

/** Rejects a call to a tool that was not offered on this turn. */
export function assertDeclared(calls: readonly AIToolCall[], tools: readonly AIToolDefinition[] | undefined): void {
  const declared = new Set((tools ?? []).map((tool) => tool.name));
  if (calls.some((call) => !declared.has(call.name))) throw unavailable('unexpected_tool');
}

/** Parses tool arguments as JSON; anything but an object is an unexpected response. */
export function parseToolArguments(raw: string): Record<string, unknown> {
  if (raw.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw unavailable('malformed');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw unavailable('unexpected_response');
  return parsed as Record<string, unknown>;
}
