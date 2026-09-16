DO $$ BEGIN
 CREATE TYPE "public"."discovery_outcome" AS ENUM('ok', 'partial', 'failed');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "discovery_snapshots" (
	"id" uuid PRIMARY KEY NOT NULL,
	"server_id" uuid NOT NULL,
	"collected_at" timestamp with time zone NOT NULL,
	"outcome" "discovery_outcome" NOT NULL,
	"error_code" "server_error_code",
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "docker_compose_version" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "discovery_snapshots" ADD CONSTRAINT "discovery_snapshots_server_id_servers_id_fk" FOREIGN KEY ("server_id") REFERENCES "public"."servers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "discovery_snapshots_server_id_collected_at_idx" ON "discovery_snapshots" USING btree ("server_id","collected_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "servers_name_lower_unique_idx" ON "servers" USING btree (lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "servers_host_port_unique_idx" ON "servers" USING btree ("host","ssh_port");
