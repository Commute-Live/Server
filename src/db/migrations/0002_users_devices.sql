CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

-- Simplify devices table to new shape
ALTER TABLE "devices" RENAME COLUMN "device_id" TO "id";
ALTER TABLE "devices" DROP COLUMN IF EXISTS "device_name";
ALTER TABLE "devices" DROP COLUMN IF EXISTS "config";
ALTER TABLE "devices" DROP COLUMN IF EXISTS "password_hash";
ALTER TABLE "devices" DROP COLUMN IF EXISTS "last_seen_at";

ALTER TABLE "devices"
  ADD COLUMN IF NOT EXISTS "timezone" text NOT NULL DEFAULT 'UTC',
  ADD COLUMN IF NOT EXISTS "preferences" jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "created_at" timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS "updated_at" timestamptz NOT NULL DEFAULT now();

DROP TRIGGER IF EXISTS "trg_devices_set_updated_at" ON "devices";
CREATE TRIGGER "trg_devices_set_updated_at"
BEFORE UPDATE ON "devices"
FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Users table 1:1 with device
CREATE TABLE IF NOT EXISTS "users" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "email" text NOT NULL UNIQUE,
  "password_hash" text NOT NULL,
  "device_id" uuid NOT NULL UNIQUE REFERENCES "devices"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS "trg_users_set_updated_at" ON "users";
CREATE TRIGGER "trg_users_set_updated_at"
BEFORE UPDATE ON "users"
FOR EACH ROW EXECUTE FUNCTION set_updated_at();
