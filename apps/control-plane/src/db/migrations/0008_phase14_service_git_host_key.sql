ALTER TABLE "services" ADD COLUMN "git_host_key_host" text;--> statement-breakpoint
ALTER TABLE "services" ADD COLUMN "git_host_key" text;--> statement-breakpoint
ALTER TABLE "services" ADD CONSTRAINT "services_git_host_key_pair_check" CHECK (("services"."git_host_key_host" IS NULL) = ("services"."git_host_key" IS NULL));