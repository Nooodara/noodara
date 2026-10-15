ALTER TYPE "public"."deployment_status" ADD VALUE IF NOT EXISTS 'HEALTHCHECK' BEFORE 'SUCCESS';--> statement-breakpoint
ALTER TYPE "public"."deployment_status" ADD VALUE IF NOT EXISTS 'ROLLING_BACK' BEFORE 'SUCCESS';--> statement-breakpoint
ALTER TYPE "public"."deployment_status" ADD VALUE IF NOT EXISTS 'ROLLED_BACK' BEFORE 'CANCELLED';--> statement-breakpoint
ALTER TYPE "public"."deployment_trigger" ADD VALUE IF NOT EXISTS 'webhook';--> statement-breakpoint
ALTER TYPE "public"."deployment_trigger" ADD VALUE IF NOT EXISTS 'rollback';--> statement-breakpoint
ALTER TYPE "public"."deployment_log_phase" ADD VALUE IF NOT EXISTS 'healthcheck';--> statement-breakpoint
ALTER TYPE "public"."deployment_log_phase" ADD VALUE IF NOT EXISTS 'rollback';--> statement-breakpoint
ALTER TYPE "public"."deployment_error_code" ADD VALUE IF NOT EXISTS 'HEALTHCHECK_FAILED';--> statement-breakpoint
ALTER TYPE "public"."deployment_error_code" ADD VALUE IF NOT EXISTS 'HEALTHCHECK_TIMEOUT';--> statement-breakpoint
ALTER TYPE "public"."deployment_error_code" ADD VALUE IF NOT EXISTS 'ROLLBACK_FAILED';--> statement-breakpoint
ALTER TYPE "public"."deployment_error_code" ADD VALUE IF NOT EXISTS 'ROLLBACK_TARGET_UNAVAILABLE';--> statement-breakpoint
ALTER TYPE "public"."deployment_error_code" ADD VALUE IF NOT EXISTS 'COMMIT_NOT_FOUND';
