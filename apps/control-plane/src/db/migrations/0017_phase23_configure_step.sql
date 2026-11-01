-- 23-04 A4: configure step bounds and counts (never a key, a name or a value). Nullable without a
-- default (metadata-only ALTER); rows before 23-04 derive a skipped configure step.
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "configure_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "configure_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "configure_variables" integer;--> statement-breakpoint
ALTER TABLE "deployments" ADD COLUMN IF NOT EXISTS "configure_secrets" integer;
