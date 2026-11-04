-- 26-05: v0.5 tables (metric samples, container observations, AI provider settings,
-- conversations, messages, tool calls). Hand-guarded for a re-run: IF NOT EXISTS on tables and
-- indexes, DO blocks on constraints, CREATE OR REPLACE on the function and trigger. The trigger
-- deletes the encrypted provider key (credentials row) when its settings row is deleted or points
-- to a new key, inside the same statement and transaction. No statement names a value 0018 adds.
CREATE TABLE IF NOT EXISTS "container_metric_samples" (
	"id" uuid PRIMARY KEY NOT NULL,
	"service_id" uuid NOT NULL,
	"container_id" text NOT NULL,
	"sampled_at" timestamp with time zone NOT NULL,
	"running" boolean NOT NULL,
	"cpu_percent" double precision,
	"memory_used_bytes" bigint,
	"memory_limit_bytes" bigint,
	"restart_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "container_metric_samples_values_check" CHECK ("container_id" ~ '^[0-9a-f]{64}$' AND ("cpu_percent" IS NULL OR "cpu_percent" >= 0) AND ("memory_used_bytes" IS NULL OR "memory_used_bytes" >= 0) AND ("memory_limit_bytes" IS NULL OR "memory_limit_bytes" > 0) AND "restart_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "container_observations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"service_id" uuid NOT NULL,
	"container_id" text,
	"observed_at" timestamp with time zone NOT NULL,
	"status" text,
	"running" boolean DEFAULT false NOT NULL,
	"restarting" boolean DEFAULT false NOT NULL,
	"restart_count" integer DEFAULT 0 NOT NULL,
	"oom_killed" boolean DEFAULT false NOT NULL,
	"exit_code" integer,
	"health" text,
	"health_exit_codes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"memory_used_bytes" bigint,
	"memory_limit_bytes" bigint,
	"parse_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "container_observations_state_check" CHECK (("parse_error" IS NULL AND "status" IS NOT NULL AND "container_id" IS NOT NULL) OR ("parse_error" IS NOT NULL AND "status" IS NULL)),
	CONSTRAINT "container_observations_values_check" CHECK (("status" IS NULL OR "status" IN ('created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead')) AND ("health" IS NULL OR "health" IN ('starting', 'healthy', 'unhealthy')) AND ("parse_error" IS NULL OR "parse_error" IN ('OUTPUT_TOO_LARGE', 'OUTPUT_TRUNCATED', 'HOST_SAMPLE_MALFORMED', 'HOST_SAMPLE_INCOMPLETE', 'CONTAINER_SAMPLE_MALFORMED')) AND ("container_id" IS NULL OR "container_id" ~ '^[0-9a-f]{64}$') AND "restart_count" >= 0 AND jsonb_typeof("health_exit_codes") = 'array')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "host_metric_samples" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"sampled_at" timestamp with time zone NOT NULL,
	"cpu_percent" double precision,
	"memory_total_bytes" bigint NOT NULL,
	"memory_used_bytes" bigint NOT NULL,
	"disk_used_percent" double precision,
	"filesystems" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"uptime_seconds" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "host_metric_samples_values_check" CHECK (("cpu_percent" IS NULL OR "cpu_percent" BETWEEN 0 AND 100) AND ("disk_used_percent" IS NULL OR "disk_used_percent" BETWEEN 0 AND 100) AND "memory_total_bytes" >= 0 AND "memory_used_bytes" BETWEEN 0 AND "memory_total_bytes" AND "uptime_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_conversations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_conversations_title_check" CHECK (char_length("title") <= 200)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_messages" (
	"id" uuid PRIMARY KEY NOT NULL,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"content" text NOT NULL,
	"answer" jsonb,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_messages_shape_check" CHECK ("role" IN ('user', 'assistant') AND "status" IN ('pending', 'complete', 'failed', 'aborted') AND char_length("content") <= 16000 AND ("error_code" IS NULL OR "error_code" IN ('METRICS_UNAVAILABLE', 'LOG_SOURCE_UNAVAILABLE', 'LOG_QUERY_INVALID', 'AI_PROVIDER_NOT_CONFIGURED', 'AI_PROVIDER_AUTH_FAILED', 'AI_PROVIDER_UNAVAILABLE', 'AI_PROVIDER_RATE_LIMITED', 'AI_BUDGET_EXCEEDED', 'AI_TOOL_NOT_ALLOWED')) AND ("answer" IS NULL OR jsonb_typeof("answer") = 'object'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_provider_settings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"credential_id" uuid NOT NULL,
	"key_hint" text NOT NULL,
	"validated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_provider_settings_shape_check" CHECK ("singleton" AND "provider" IN ('anthropic', 'openai') AND char_length("model") BETWEEN 1 AND 128 AND char_length("key_hint") <= 12)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ai_tool_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"message_id" uuid NOT NULL,
	"name" text NOT NULL,
	"scope_kind" text,
	"scope_id" uuid,
	"status" text NOT NULL,
	"error_code" text,
	"duration_ms" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_tool_calls_shape_check" CHECK ("name" ~ '^[a-z][a-z0-9_]{0,63}$' AND "status" IN ('ok', 'error', 'refused') AND ("error_code" IS NULL OR "error_code" IN ('METRICS_UNAVAILABLE', 'LOG_SOURCE_UNAVAILABLE', 'LOG_QUERY_INVALID', 'AI_PROVIDER_NOT_CONFIGURED', 'AI_PROVIDER_AUTH_FAILED', 'AI_PROVIDER_UNAVAILABLE', 'AI_PROVIDER_RATE_LIMITED', 'AI_BUDGET_EXCEEDED', 'AI_TOOL_NOT_ALLOWED')) AND "duration_ms" >= 0 AND (("scope_kind" IS NULL AND "scope_id" IS NULL) OR ("scope_kind" IN ('Server', 'Project', 'Environment', 'Service', 'Domain', 'Deployment') AND "scope_id" IS NOT NULL)))
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "container_metric_samples" ADD CONSTRAINT "container_metric_samples_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "container_observations" ADD CONSTRAINT "container_observations_service_id_services_id_fk" FOREIGN KEY ("service_id") REFERENCES "public"."services"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "host_metric_samples" ADD CONSTRAINT "host_metric_samples_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_conversations" ADD CONSTRAINT "ai_conversations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_messages" ADD CONSTRAINT "ai_messages_conversation_id_ai_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."ai_conversations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_provider_settings" ADD CONSTRAINT "ai_provider_settings_credential_id_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."credentials"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_tool_calls" ADD CONSTRAINT "ai_tool_calls_message_id_ai_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."ai_messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "container_metric_samples_service_sampled_at_idx" ON "container_metric_samples" USING btree ("service_id","sampled_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "container_metric_samples_sampled_at_idx" ON "container_metric_samples" USING btree ("sampled_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "container_observations_service_observed_at_idx" ON "container_observations" USING btree ("service_id","observed_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "container_observations_observed_at_idx" ON "container_observations" USING btree ("observed_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "host_metric_samples_server_sampled_at_idx" ON "host_metric_samples" USING btree ("server_id","sampled_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "host_metric_samples_sampled_at_idx" ON "host_metric_samples" USING btree ("sampled_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_conversations_user_updated_at_idx" ON "ai_conversations" USING btree ("user_id","updated_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_messages_conversation_created_at_idx" ON "ai_messages" USING btree ("conversation_id","created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_provider_settings_singleton_idx" ON "ai_provider_settings" USING btree ("singleton");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_provider_settings_credential_id_idx" ON "ai_provider_settings" USING btree ("credential_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "ai_tool_calls_message_created_at_idx" ON "ai_tool_calls" USING btree ("message_id","created_at");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "public"."ai_provider_settings_delete_credential"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN
  DELETE FROM "public"."credentials" WHERE "id" = OLD."credential_id";
  RETURN OLD;
 END IF;
 IF NEW."credential_id" IS DISTINCT FROM OLD."credential_id" THEN
  DELETE FROM "public"."credentials" WHERE "id" = OLD."credential_id";
 END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE TRIGGER "ai_provider_settings_delete_credential_trg"
AFTER DELETE OR UPDATE OF "credential_id" ON "ai_provider_settings"
FOR EACH ROW EXECUTE FUNCTION "public"."ai_provider_settings_delete_credential"();
