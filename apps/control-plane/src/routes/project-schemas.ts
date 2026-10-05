// Zod request/response schemas for the `/api/projects` routes (12-07). Shapes only: the domain
// validators in `@noodara/domain` decide what a valid name, slug or description is, and the
// services decide every status. The raw length caps here only bound the work before them.
import { z } from 'zod';

/** Route-level body cap: a project or environment body is a few short strings. */
export const PROJECT_ROUTE_BODY_LIMIT_BYTES = 16 * 1024;

const MAX_RAW_NAME_LENGTH = 1024;
const MAX_RAW_DESCRIPTION_LENGTH = 4096;
const MAX_RAW_KIND_LENGTH = 1024;

export const ProjectIdParamSchema = z.object({ projectId: z.uuid() });

export const EnvironmentParamsSchema = z.object({ projectId: z.uuid(), environmentId: z.uuid() });

export const CreateProjectBodySchema = z
  .object({
    name: z.string().max(MAX_RAW_NAME_LENGTH),
    description: z.string().max(MAX_RAW_DESCRIPTION_LENGTH).nullable().optional(),
  })
  .strict();

export type CreateProjectBody = z.infer<typeof CreateProjectBodySchema>;

export const UpdateProjectBodySchema = z
  .object({
    name: z.string().max(MAX_RAW_NAME_LENGTH).optional(),
    description: z.string().max(MAX_RAW_DESCRIPTION_LENGTH).nullable().optional(),
  })
  .strict();

export type UpdateProjectBody = z.infer<typeof UpdateProjectBodySchema>;

/** The exact project name is compared server-side; an empty string is a mismatch, not a 400. */
export const DeleteProjectBodySchema = z.object({ confirmName: z.string().max(MAX_RAW_NAME_LENGTH) }).strict();

export const CreateEnvironmentBodySchema = z
  .object({
    name: z.string().max(MAX_RAW_NAME_LENGTH),
    kind: z.string().max(MAX_RAW_KIND_LENGTH).optional(),
  })
  .strict();

export type CreateEnvironmentBody = z.infer<typeof CreateEnvironmentBodySchema>;

export const UpdateEnvironmentBodySchema = z
  .object({
    name: z.string().max(MAX_RAW_NAME_LENGTH).optional(),
    kind: z.string().max(MAX_RAW_KIND_LENGTH).optional(),
  })
  .strict();

export type UpdateEnvironmentBody = z.infer<typeof UpdateEnvironmentBodySchema>;

export const ProjectViewSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  archivedAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const EnvironmentViewSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  name: z.string(),
  kind: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const ListProjectsResponseSchema = z.object({ items: z.array(ProjectViewSchema) });

export const ListEnvironmentsResponseSchema = z.object({ items: z.array(EnvironmentViewSchema) });

export const DeleteProjectResponseSchema = z.object({ ok: z.literal(true), projectId: z.uuid() });
