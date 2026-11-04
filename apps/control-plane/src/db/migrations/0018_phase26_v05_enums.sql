-- 26-05: v0.5 enum values only (0019 owns the tables). Neither value is ever used by a
-- migration: the migrator runs pending migrations in one transaction (55P04).
ALTER TYPE "public"."activity_actor_type" ADD VALUE IF NOT EXISTS 'ai';
--> statement-breakpoint
ALTER TYPE "public"."credential_type" ADD VALUE IF NOT EXISTS 'ai_provider_key';
