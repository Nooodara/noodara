-- 22-07: install staleness keys on its own timestamp, not servers.updated_at (discovery/connect
-- writes bump updated_at). Guarded for a re-run; rows already INSTALLING start from updated_at.
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "proxy_install_started_at" timestamp with time zone;--> statement-breakpoint
UPDATE "servers" SET "proxy_install_started_at" = "updated_at" WHERE "proxy_status" = 'INSTALLING' AND "proxy_install_started_at" IS NULL;
