-- 21-06: v0.4 enum values and types only (0015 owns tables and columns). The three
-- deployment_error_code values are never used by a migration: the migrator runs pending
-- migrations in one transaction (55P04). New types are guarded for a re-run.
ALTER TYPE "public"."deployment_error_code" ADD VALUE IF NOT EXISTS 'SECRET_UNRESOLVED';
--> statement-breakpoint
ALTER TYPE "public"."deployment_error_code" ADD VALUE IF NOT EXISTS 'ENV_INJECTION_FAILED';
--> statement-breakpoint
ALTER TYPE "public"."deployment_error_code" ADD VALUE IF NOT EXISTS 'PROXY_ROUTE_FAILED';
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."domain_cert_status" AS ENUM('NONE', 'PENDING', 'ISSUED', 'RENEWING', 'FAILED', 'EXPIRED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."domain_dns_status" AS ENUM('RESOLVES', 'MISMATCH', 'UNRESOLVED', 'UNAVAILABLE');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."env_scope" AS ENUM('project', 'environment', 'service');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 CREATE TYPE "public"."proxy_status" AS ENUM('NOT_INSTALLED', 'INSTALLING', 'RUNNING', 'FAILED');
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
