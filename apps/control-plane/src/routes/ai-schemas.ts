// 28-05: wire schemas and named errors for /api/ai/conversations. Bodies are strict, so a
// client-supplied id is a 400; ids are always minted by the server (UUID v7). The question length
// is checked by the route, not the schema, so an over-long question is a named 422 instead of a
// validation error that could quote it.
import { z } from 'zod';
import {
  AI_CONVERSATION_TITLE_MAX_LENGTH,
  AI_QUESTION_MAX_LENGTH,
  AiConversationDetailSchema,
  AiConversationViewSchema,
  ListAiConversationsResponseSchema,
} from '@noodara/domain/api-contract';

/** Far above a 4000-character question in JSON; anything larger is refused with 413. */
export const AI_ASK_BODY_LIMIT_BYTES = 32 * 1024;
export const AI_CONVERSATION_BODY_LIMIT_BYTES = 4 * 1024;

export const CreateAiConversationBodySchema = z
  .strictObject({ title: z.string().max(AI_CONVERSATION_TITLE_MAX_LENGTH).optional() })
  .optional();

export const AskRouteBodySchema = z.strictObject({ question: z.string() });

export const ConversationParamsSchema = z.strictObject({ id: z.uuid() });

/** Named errors of this surface that are not v0.5 service codes; each has one fixed message. */
export const AI_CONVERSATION_ERRORS = Object.freeze({
  AI_CONVERSATION_NOT_FOUND: { status: 404, message: 'Conversation not found.' },
  AI_CONVERSATION_BUSY: {
    status: 409,
    message: 'This conversation is already answering a question. Wait for it to finish.',
  },
  AI_QUESTION_EMPTY: { status: 422, message: 'Ask a question.' },
  AI_QUESTION_TOO_LONG: {
    status: 422,
    message: `Questions are limited to ${AI_QUESTION_MAX_LENGTH.toString()} characters.`,
  },
  RATE_LIMITED: { status: 429, message: 'Too many questions. Wait a moment and try again.' },
} as const);

export type AiConversationErrorCode = keyof typeof AI_CONVERSATION_ERRORS;

export { AiConversationDetailSchema, AiConversationViewSchema, ListAiConversationsResponseSchema };
