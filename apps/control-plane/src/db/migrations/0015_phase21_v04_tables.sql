-- 21-06: v0.4 tables (domains, environment_variables, secrets) and servers proxy columns.
-- Hand-guarded for a re-run: IF NOT EXISTS on tables/columns/indexes, DO blocks on constraints.
-- services_id_project_id_unique is added before the composite FKs that reference it.
CREATE TABLE IF NOT EXISTS "domains" (
	"id" uuid PRIMARY KEY NOT NULL,
	"project_id" uuid NOT NULL,
	"service_id" uuid NOT NULL,
	"hostname" text NOT NULL,
	"https_redirect" boolean DEFAULT true NOT NULL,
	"cert_status" "domain_cert_status" DEFAULT 'NONE' NOT NULL,
	"cert_not_after" timestamp with time zone,
	"cert_error_code" text,
	"dns_status" "domain_dns_status",
	"dns_checked_at" timestamp with time zone,
	"apply_status" text DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "domains_hostname_shape_check" CHECK ("hostname" = lower("hostname") AND char_length("hostname") BETWEEN 1 AND 253),
	CONSTRAINT "domains_cert_error_code_check" CHECK ("cert_error_code" IS NULL OR "cert_error_code" IN ('CERT_DNS_MISMATCH', 'CERT_ISSUANCE_FAILED', 'CERT_PROXY_UNAVAILABLE')),
	CONSTRAINT "domains_apply_status_check" CHECK ("apply_status" IN ('PENDING', 'APPLIED', 'FAILED'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "environment_variables" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" "env_scope" NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid,
	"service_id" uuid,
	"key" text NOT NULL,
	"value" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environment_variables_scope_owner_check" CHECK (("environment_variables"."scope" = 'project' AND "environment_variables"."environment_id" IS NULL AND "environment_variables"."service_id" IS NULL) OR ("environment_variables"."scope" = 'environment' AND "environment_variables"."environment_id" IS NOT NULL AND "environment_variables"."service_id" IS NULL) OR ("environment_variables"."scope" = 'service' AND "environment_variables"."service_id" IS NOT NULL AND "environment_variables"."environment_id" IS NULL)),
	CONSTRAINT "environment_variables_size_check" CHECK (char_length("key") BETWEEN 1 AND 128 AND octet_length("value") <= 32768)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "secrets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"scope" "env_scope" NOT NULL,
	"project_id" uuid NOT NULL,
	"environment_id" uuid,
	"service_id" uuid,
	"name" text NOT NULL,
	"encrypted_value" text NOT NULL,
	"key_version" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"hint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secrets_scope_owner_check" CHECK (("secrets"."scope" = 'project' AND "secrets"."environment_id" IS NULL AND "secrets"."service_id" IS NULL) OR ("secrets"."scope" = 'environment' AND "secrets"."environment_id" IS NOT NULL AND "secrets"."service_id" IS NULL) OR ("secrets"."scope" = 'service' AND "secrets"."service_id" IS NOT NULL AND "secrets"."environment_id" IS NULL)),
	CONSTRAINT "secrets_shape_check" CHECK (char_length("name") BETWEEN 1 AND 64 AND "version" >= 1 AND "key_version" >= 1)
);
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "proxy_status" "proxy_status" DEFAULT 'NOT_INSTALLED' NOT NULL;
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "proxy_error_code" text;
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "proxy_acme_email" text;
--> statement-breakpoint
ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "proxy_installed_at" timestamp with time zone;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "services" ADD CONSTRAINT "services_id_project_id_unique" UNIQUE("id","project_id");
EXCEPTION
 WHEN duplicate_table OR duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "domains" ADD CONSTRAINT "domains_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "domains" ADD CONSTRAINT "domains_service_project_fk" FOREIGN KEY ("service_id","project_id") REFERENCES "public"."services"("id","project_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "environment_variables" ADD CONSTRAINT "environment_variables_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "environment_variables" ADD CONSTRAINT "environment_variables_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "public"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "environment_variables" ADD CONSTRAINT "environment_variables_service_project_fk" FOREIGN KEY ("service_id","project_id") REFERENCES "public"."services"("id","project_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "secrets" ADD CONSTRAINT "secrets_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "secrets" ADD CONSTRAINT "secrets_environment_project_fk" FOREIGN KEY ("environment_id","project_id") REFERENCES "public"."environments"("id","project_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "secrets" ADD CONSTRAINT "secrets_service_project_fk" FOREIGN KEY ("service_id","project_id") REFERENCES "public"."services"("id","project_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "servers" ADD CONSTRAINT "servers_proxy_error_code_check" CHECK ("proxy_error_code" IS NULL OR "proxy_error_code" IN ('PROXY_PORT_IN_USE', 'PROXY_INSTALL_FAILED', 'PROXY_UNAVAILABLE'));
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "servers" ADD CONSTRAINT "servers_proxy_acme_email_check" CHECK ("proxy_acme_email" IS NULL OR char_length("proxy_acme_email") BETWEEN 3 AND 254);
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "domains_hostname_lower_unique_idx" ON "domains" USING btree (lower("hostname"));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "environment_variables_owner_key_unique_idx" ON "environment_variables" USING btree (COALESCE("service_id", "environment_id", "project_id"),"key");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "secrets_owner_name_unique_idx" ON "secrets" USING btree (COALESCE("service_id", "environment_id", "project_id"),"name");
