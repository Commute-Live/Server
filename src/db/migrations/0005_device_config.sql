-- Add device configuration blob for brightness/lines and keep heartbeat column in sync
ALTER TABLE "devices"
    ADD COLUMN IF NOT EXISTS "config" jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "devices"
    ADD COLUMN IF NOT EXISTS "last_active" timestamptz;
