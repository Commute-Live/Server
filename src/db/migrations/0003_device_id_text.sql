-- Change device id from UUID to text (handles existing constraints)
BEGIN;

-- Drop old FK/unique constraints regardless of generated name
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_device_id_devices_id_fk";
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_device_id_fkey";
ALTER TABLE "users" DROP CONSTRAINT IF EXISTS "users_device_id_key";

-- Drop PK to allow type change
ALTER TABLE "devices" DROP CONSTRAINT IF EXISTS "devices_pkey";

-- Change column types
ALTER TABLE "devices"
  ALTER COLUMN "id" DROP DEFAULT,
  ALTER COLUMN "id" TYPE text USING "id"::text;

ALTER TABLE "users"
  ALTER COLUMN "device_id" TYPE text USING "device_id"::text;

-- Recreate constraints
ALTER TABLE "devices"
  ADD CONSTRAINT devices_pkey PRIMARY KEY ("id");

ALTER TABLE "users"
  ADD CONSTRAINT users_device_id_devices_id_fk FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE,
  ADD CONSTRAINT users_device_id_key UNIQUE ("device_id");

COMMIT;
