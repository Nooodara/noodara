// 27-04: request and response schemas of the unified logs routes. Query values are taken as
// strings (or repeated strings) and validated by the handler, which answers a malformed query,
// window, search or cursor with a 422 LOG_QUERY_INVALID instead of the generic schema error.
import { LogPageSchema, ServiceParamsSchema } from '@noodara/domain/api-contract';
import { z } from 'zod';

export const LOG_QUERY_INVALID = 'LOG_QUERY_INVALID';
export const LOG_SOURCE_UNAVAILABLE = 'LOG_SOURCE_UNAVAILABLE';
export const RUNTIME_LOG_FOLLOW_LIMIT_REACHED = 'RUNTIME_LOG_FOLLOW_LIMIT_REACHED';
export const LOG_FOLLOW_LIMIT_MESSAGE =
  'Too many live log streams are open for this service or account. Close one and try again.';

const QueryValue = z.union([z.string(), z.array(z.string()).max(8)]).optional();

export const LogsQuerySchema = z.object({
  sources: QueryValue,
  since: QueryValue,
  until: QueryValue,
  level: QueryValue,
  search: QueryValue,
  cursor: QueryValue,
  limit: QueryValue,
});
export type LogsQuery = z.infer<typeof LogsQuerySchema>;

export const LogsFollowQuerySchema = LogsQuerySchema.omit({ until: true, cursor: true, limit: true });
export type LogsFollowQuery = z.infer<typeof LogsFollowQuerySchema>;

export const LogsParamsSchema = ServiceParamsSchema;

export const LogsResponseSchema = LogPageSchema.extend({
  /** Opaque, signed and bound to this service; pass it back as `cursor` for the older page. */
  nextCursor: z.string().nullable(),
  /** A cap (window, lines, bytes or a source's own output cap) cut what this page could return. */
  truncated: z.boolean(),
});
export type LogsResponse = z.infer<typeof LogsResponseSchema>;
