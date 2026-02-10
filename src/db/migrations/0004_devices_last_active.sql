-- Track device heartbeat timestamps
ALTER TABLE "devices"
    ADD COLUMN IF NOT EXISTS "last_active" timestamptz;
