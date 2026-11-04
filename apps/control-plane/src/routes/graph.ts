// 27-05: the Infrastructure Graph, inside the guarded scope (api-scope.ts). Read only.
// - GET /api/graph                                                    every registered entity
// - GET /api/projects/:projectId/graph                                one project (and its servers)
// - GET /api/projects/:projectId/environments/:environmentId/graph    one environment of that project
// Each answer is buildGraph over one consistent snapshot (graph-snapshot.ts). A malformed id or
// `limit` is a 400 GRAPH_QUERY_INVALID; an unknown project, or an environment of another project,
// is a 404. `?limit=` (1..GRAPH_MAX_NODES, default the maximum) caps the nodes and sets `truncated`.
import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import { GRAPH_MAX_NODES } from '@noodara/domain/api-contract';
import type { FastifyPluginCallback, FastifyReply } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/client.js';
import { loadScopedGraph, type GraphScopeRequest } from '../observability/graph/graph-snapshot.js';
import { toGraphView } from '../observability/graph/graph-view.js';
import { ErrorBodySchema, toErrorBody, toValidationErrorBody, ValidationErrorBodySchema } from './http-errors.js';
import {
  EnvironmentGraphParamsSchema,
  GRAPH_QUERY_INVALID,
  GRAPH_QUERY_INVALID_STATUS,
  GraphQueryErrorBodySchema,
  GraphQuerySchema,
  GraphResponseSchema,
  ProjectGraphParamsSchema,
} from './graph-schemas.js';

const ERRORS = {
  400: z.union([GraphQueryErrorBodySchema, ValidationErrorBodySchema]),
  401: ErrorBodySchema,
  404: ErrorBodySchema,
};

const Uuid = z.uuid();
const LIMIT = /^[1-9][0-9]{0,15}$/;

interface Issue {
  readonly path: string;
  readonly message: string;
}

/** Lower-cased ids and the node cap, or the issues; messages never echo the submitted value. */
function parseRequest(
  ids: Readonly<Record<string, string>>,
  limit: string | undefined,
): { ok: true; ids: Record<string, string>; limit: number } | { ok: false; issues: Issue[] } {
  const issues: Issue[] = [];
  const parsed: Record<string, string> = {};
  for (const [name, value] of Object.entries(ids)) {
    if (Uuid.safeParse(value).success) parsed[name] = value.toLowerCase();
    else issues.push({ path: name, message: 'must be a UUID' });
  }
  let cap = GRAPH_MAX_NODES;
  if (limit !== undefined) {
    const value = LIMIT.test(limit) ? Number(limit) : Number.NaN;
    if (Number.isInteger(value) && value <= GRAPH_MAX_NODES) cap = value;
    else issues.push({ path: 'limit', message: `must be an integer from 1 to ${String(GRAPH_MAX_NODES)}` });
  }
  return issues.length > 0 ? { ok: false, issues } : { ok: true, ids: parsed, limit: cap };
}

async function answer(
  reply: FastifyReply,
  ids: Readonly<Record<string, string>>,
  limit: string | undefined,
  toScope: (ids: Readonly<Record<string, string>>) => GraphScopeRequest,
): Promise<void> {
  const request = parseRequest(ids, limit);
  if (!request.ok) {
    await reply.code(GRAPH_QUERY_INVALID_STATUS).send(
      toValidationErrorBody(
        request.issues.map((issue) => ({ path: [issue.path], message: issue.message })),
        GRAPH_QUERY_INVALID,
      ),
    );
    return;
  }
  const result = await loadScopedGraph(await getDb(), toScope(request.ids));
  if (!result.found) {
    const what = result.missing === 'project' ? 'Project' : 'Environment';
    const id = result.missing === 'project' ? request.ids.projectId : request.ids.environmentId;
    await reply.code(404).send(toErrorBody('NOT_FOUND', `${what} "${String(id)}" not found`));
    return;
  }
  await reply.send(toGraphView(result.graph, request.limit));
}

function required(ids: Readonly<Record<string, string>>, name: string): string {
  const value = ids[name];
  if (value === undefined) throw new Error(`graph scope id ${name} missing after validation`);
  return value;
}

const graphRoutes: FastifyPluginCallback = (fastify, _opts, done) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.route({
    method: 'GET',
    url: '/api/graph',
    schema: { querystring: GraphQuerySchema, response: { 200: GraphResponseSchema, ...ERRORS } },
    handler: async (request, reply) => {
      await answer(reply, {}, request.query.limit, () => ({ kind: 'global' }));
    },
  });

  app.route({
    method: 'GET',
    url: '/api/projects/:projectId/graph',
    schema: {
      params: ProjectGraphParamsSchema,
      querystring: GraphQuerySchema,
      response: { 200: GraphResponseSchema, ...ERRORS },
    },
    handler: async (request, reply) => {
      await answer(reply, { projectId: request.params.projectId }, request.query.limit, (ids) => ({
        kind: 'project',
        projectId: required(ids, 'projectId'),
      }));
    },
  });

  app.route({
    method: 'GET',
    url: '/api/projects/:projectId/environments/:environmentId/graph',
    schema: {
      params: EnvironmentGraphParamsSchema,
      querystring: GraphQuerySchema,
      response: { 200: GraphResponseSchema, ...ERRORS },
    },
    handler: async (request, reply) => {
      const { projectId, environmentId } = request.params;
      await answer(reply, { projectId, environmentId }, request.query.limit, (ids) => ({
        kind: 'environment',
        projectId: required(ids, 'projectId'),
        environmentId: required(ids, 'environmentId'),
      }));
    },
  });

  done();
};

export default graphRoutes;
