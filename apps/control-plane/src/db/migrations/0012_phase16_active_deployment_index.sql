-- One active deployment per service over the v0.3 non-terminal set. 0011 sorts HEALTHCHECK and
-- ROLLING_BACK before 'SUCCESS'; the new literals cannot appear here (same transaction, 55P04).
DROP INDEX IF EXISTS "deployments_service_active_unique_idx";--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "deployments_service_active_unique_idx" ON "deployments" USING btree ("service_id") WHERE "deployments"."status" < 'SUCCESS';
