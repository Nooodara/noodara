-- 16-06: v0.3 columns and the webhook_deliveries table only (0011/0012 own the enum values and
-- the one-active index). Deployments columns are nullable without defaults and the services
-- defaults are constants, so no table is rewritten; every statement is guarded for a re-run.
-- 'webhook_secret' is never used here: the migrator runs pending migrations in one transaction.
ALTER TYPE "public"."credential_type" ADD VALUE IF NOT EXISTS 'webhook_secret';
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "webhook_deliveries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"service_id" uuid NOT NULL,
	"delivery_id" text NOT NULL,
	"event" text NOT NULL,
	"outcome" text NOT NULL,
	"pushed_sha" text,
	"deployment_id" uuid,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_outcome_check" CHECK ("webhook_deliveries"."outcome" IN ('deployed', 'coalesced', 'superseded', 'already_deployed', 'ping', 'ignored_event', 'ignored_tag', 'ignored_ref', 'ignored_branch', 'ignored_deletion', 'repository_mismatch', 'invalid_payload', 'invalid_sha', 'project_archived', 'source_not_git')),
	CONSTRAINT "webhook_deliveries_delivery_id_check" CHECK (char_length("webhook_deliveries"."delivery_id") BETWEEN 1 AND 128 AND char_length("webhook_deliveries"."event") BETWEEN 1 AND 64),
	CONSTRAINT "webhook_deliveries_pushed_sha_check" CHECK ("webhook_deliveries"."pushed_sha" IS NULL OR "webhook_deliveries"."pushed_sha" ~ '^[0-9a-f]{40}$')
);
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "image_ref" text;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "rollback_of_deployment_id" uuid;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "webhook_delivery_id" uuid;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "idempotency_key" text;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "request_fingerprint" text;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "runtime_config" jsonb;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "healthcheck_started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "rollback_started_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "healthcheck" jsonb;
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "auto_rollback" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "image_retention" integer DEFAULT 3 NOT NULL;
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "webhook_hook_id" text;
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "webhook_secret_credential_id" uuid;
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "pending_trigger_delivery_id" text;
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "pending_trigger_sha" text;
--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN IF NOT EXISTS "pending_trigger_at" timestamp with time zone;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "webhook_deliveries_service_delivery_unique_idx" ON "webhook_deliveries" USING btree ("service_id","delivery_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "webhook_deliveries_service_received_at_idx" ON "webhook_deliveries" USING btree ("service_id","received_at" DESC NULLS LAST);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deployments" ADD CONSTRAINT "deployments_rollback_of_deployment_id_deployments_id_fk" FOREIGN KEY ("rollback_of_deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deployments" ADD CONSTRAINT "deployments_webhook_delivery_id_webhook_deliveries_id_fk" FOREIGN KEY ("webhook_delivery_id") REFERENCES "public"."webhook_deliveries"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "services" ADD CONSTRAINT "services_webhook_secret_credential_id_credentials_id_fk" FOREIGN KEY ("webhook_secret_credential_id") REFERENCES "public"."credentials"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "deployments_service_idempotency_key_unique_idx" ON "deployments" USING btree ("service_id","idempotency_key") WHERE "deployments"."idempotency_key" IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "services_webhook_hook_id_unique_idx" ON "services" USING btree ("webhook_hook_id");
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deployments" ADD CONSTRAINT "deployments_idempotency_pair_check" CHECK (("deployments"."idempotency_key" IS NULL AND "deployments"."request_fingerprint" IS NULL) OR ("deployments"."idempotency_key" IS NOT NULL AND "deployments"."request_fingerprint" IS NOT NULL AND char_length("deployments"."idempotency_key") BETWEEN 1 AND 255 AND "deployments"."request_fingerprint" ~ '^[0-9a-f]{64}$'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "deployments" ADD CONSTRAINT "deployments_runtime_config_object_check" CHECK ("deployments"."runtime_config" IS NULL OR jsonb_typeof("deployments"."runtime_config") = 'object');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "services" ADD CONSTRAINT "services_webhook_hook_id_shape_check" CHECK ("services"."webhook_hook_id" IS NULL OR "services"."webhook_hook_id" ~ '^[A-Za-z0-9_-]{22,64}$');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "services" ADD CONSTRAINT "services_webhook_pair_check" CHECK ("services"."webhook_secret_credential_id" IS NULL OR "services"."webhook_hook_id" IS NOT NULL);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "services" ADD CONSTRAINT "services_pending_trigger_check" CHECK (("services"."pending_trigger_delivery_id" IS NULL AND "services"."pending_trigger_sha" IS NULL AND "services"."pending_trigger_at" IS NULL) OR ("services"."pending_trigger_delivery_id" IS NOT NULL AND "services"."pending_trigger_at" IS NOT NULL AND "services"."pending_trigger_sha" IS NOT NULL AND "services"."pending_trigger_sha" ~ '^[0-9a-f]{40}$'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "services" ADD CONSTRAINT "services_image_retention_range_check" CHECK ("image_retention" BETWEEN 1 AND 10);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "services" ADD CONSTRAINT "services_healthcheck_object_check" CHECK ("services"."healthcheck" IS NULL OR jsonb_typeof("services"."healthcheck") = 'object');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
