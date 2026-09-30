DO $$ BEGIN
 CREATE TYPE "public"."deployment_log_phase" AS ENUM('prepare', 'build', 'deploy');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."deployment_error_code" AS ENUM('REPOSITORY_AUTH_FAILED', 'REPOSITORY_NOT_FOUND', 'BRANCH_NOT_FOUND', 'REPOSITORY_HOST_UNREACHABLE', 'UNSUPPORTED_REPOSITORY_FEATURE', 'CLONE_FAILED', 'DOCKERFILE_NOT_FOUND', 'BUILDKIT_UNAVAILABLE', 'BUILD_FAILED', 'REGISTRY_AUTH_FAILED', 'IMAGE_NOT_FOUND', 'IMAGE_PULL_FAILED', 'DISK_FULL', 'PORT_IN_USE', 'START_FAILED', 'DOCKER_UNAVAILABLE', 'SERVER_UNREACHABLE', 'BUILD_TIMEOUT', 'BUILD_STALLED', 'WORKER_CRASHED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."deployment_status" AS ENUM('QUEUED', 'PREPARING', 'BUILDING', 'DEPLOYING', 'SUCCESS', 'FAILED', 'CANCELLED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."deployment_trigger" AS ENUM('manual', 'redeploy');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."service_source_type" AS ENUM('git', 'image');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."service_status" AS ENUM('NEVER_DEPLOYED', 'DEPLOYING', 'RUNNING', 'STOPPED', 'FAILED', 'UNKNOWN');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
ALTER TYPE "public"."credential_type" ADD VALUE IF NOT EXISTS 'git_deploy_key';--> statement-breakpoint
ALTER TYPE "public"."credential_type" ADD VALUE IF NOT EXISTS 'git_https_token';--> statement-breakpoint
ALTER TYPE "public"."credential_type" ADD VALUE IF NOT EXISTS 'registry_password';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deployment_log_chunks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"deployment_id" uuid NOT NULL,
	"phase" "deployment_log_phase" NOT NULL,
	"seq" integer NOT NULL,
	"content" text NOT NULL,
	"byte_length" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "deployments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"service_id" uuid NOT NULL,
	"status" "deployment_status" DEFAULT 'QUEUED' NOT NULL,
	"trigger" "deployment_trigger" DEFAULT 'manual' NOT NULL,
	"triggered_by" text,
	"source" jsonb NOT NULL,
	"commit_sha" text,
	"previous_deployment_id" uuid,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"duration_ms" integer,
	"error_code" "deployment_error_code",
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "environments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text DEFAULT 'development' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environments_id_project_id_unique" UNIQUE("id","project_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"description" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "services" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid NOT NULL,
	"server_id" uuid NOT NULL,
	"name" text NOT NULL,
	"source_type" "service_source_type" NOT NULL,
	"repository_url" text,
	"branch" text,
	"build_context" text,
	"dockerfile_path" text,
	"build_target" text,
	"image_ref" text,
	"internal_port" integer NOT NULL,
	"published_port" integer,
	"status" "service_status" DEFAULT 'NEVER_DEPLOYED' NOT NULL,
	"repository_credential_id" uuid,
	"registry_credential_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "services_source_shape_check" CHECK (("services"."source_type" = 'git' AND "services"."repository_url" IS NOT NULL AND "services"."branch" IS NOT NULL AND "services"."build_context" IS NOT NULL AND "services"."dockerfile_path" IS NOT NULL AND "services"."image_ref" IS NULL) OR ("services"."source_type" = 'image' AND "services"."image_ref" IS NOT NULL AND "services"."repository_url" IS NULL AND "services"."branch" IS NULL AND "services"."build_context" IS NULL AND "services"."dockerfile_path" IS NULL AND "services"."build_target" IS NULL)),
	CONSTRAINT "services_ports_range_check" CHECK ("services"."internal_port" BETWEEN 1 AND 65535 AND ("services"."published_port" IS NULL OR "services"."published_port" BETWEEN 1 AND 65535))
);
--> statement-breakpoint
ALTER TABLE "credentials" ADD COLUMN IF NOT EXISTS "public_key" text;--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "docker_buildkit_available" boolean;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deployment_log_chunks" ADD CONSTRAINT "deployment_log_chunks_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deployments" ADD CONSTRAINT "deployments_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deployments" ADD CONSTRAINT "deployments_previous_deployment_id_deployments_id_fk" FOREIGN KEY ("previous_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "environments" ADD CONSTRAINT "environments_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "services" ADD CONSTRAINT "services_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "services" ADD CONSTRAINT "services_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "services" ADD CONSTRAINT "services_repository_credential_id_credentials_id_fk" FOREIGN KEY ("repository_credential_id") REFERENCES "public"."credentials"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "services" ADD CONSTRAINT "services_registry_credential_id_credentials_id_fk" FOREIGN KEY ("registry_credential_id") REFERENCES "public"."credentials"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "services" ADD CONSTRAINT "services_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "public"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "deployment_log_chunks_deployment_phase_seq_unique_idx" ON "deployment_log_chunks" USING btree ("deployment_id","phase","seq");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "deployments_service_active_unique_idx" ON "deployments" USING btree ("service_id") WHERE "deployments"."status" IN ('QUEUED', 'PREPARING', 'BUILDING', 'DEPLOYING');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "deployments_service_created_at_idx" ON "deployments" USING btree ("service_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "environments_project_name_lower_unique_idx" ON "environments" USING btree ("project_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "projects_name_lower_unique_idx" ON "projects" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "projects_slug_unique_idx" ON "projects" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "services_environment_name_lower_unique_idx" ON "services" USING btree ("environment_id",lower("name"));