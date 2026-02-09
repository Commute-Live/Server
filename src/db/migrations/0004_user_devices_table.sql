BEGIN;

ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_device_id_devices_id_fk";
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_device_id_fkey";
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_device_id_key";
ALTER TABLE "users" DROP COLUMN IF EXISTS "device_id";

CREATE TABLE IF NOT EXISTS "user_devices" (
  "user_id"   uuid  NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "device_id" text  NOT NULL REFERENCES "devices"("id") ON DELETE CASCADE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "pk_user_devices" PRIMARY KEY ("user_id", "device_id"),
  CONSTRAINT "idx_user_devices_device" UNIQUE ("device_id")
);

COMMIT;
