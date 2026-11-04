// 27-05: request and response schemas of the Infrastructure Graph routes. Ids and the node cap are
// taken as strings and validated in the handler, which answers with a named 400
// (GRAPH_QUERY_INVALID) that never echoes the input. The response is the v0.5 graph contract
// (26-04) with DEPENDS_ON edges narrowed to their two service ids, plus a `truncated` flag.
import { GRAPH_MAX_RELATIONS, GraphViewSchema } from '@noodara/domain/api-contract';
import { GRAPH_RELATION_TYPES } from '@noodara/domain';
import { z } from 'zod';

export const GRAPH_QUERY_INVALID = 'GRAPH_QUERY_INVALID';
export const GRAPH_QUERY_INVALID_STATUS = 400;

const IdParam = z.string().max(128);

export const GraphQuerySchema = z.strictObject({ limit: z.string().max(16).optional() });
export const ProjectGraphParamsSchema = z.object({ projectId: IdParam });
export const EnvironmentGraphParamsSchema = z.object({ projectId: IdParam, environmentId: IdParam });

const NodeId = z.string().max(64);

export const GraphResponseSchema = GraphViewSchema.extend({
  relations: z
    .array(z.strictObject({ id: z.string().max(160), type: z.enum(GRAPH_RELATION_TYPES), from: NodeId, to: NodeId }))
    .max(GRAPH_MAX_RELATIONS),
  truncated: z.boolean(),
});

export const GraphQueryErrorBodySchema = z.strictObject({
  error: z.literal(GRAPH_QUERY_INVALID),
  message: z.string(),
  issues: z.array(z.strictObject({ path: z.string(), message: z.string() })).max(4),
});
