ALTER TABLE "login_attempts" ADD COLUMN IF NOT EXISTS "lockout_count" integer DEFAULT 0 NOT NULL;
