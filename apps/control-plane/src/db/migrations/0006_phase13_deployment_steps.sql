ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "building_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "deploying_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "verifying_started_at" timestamp with time zone;
