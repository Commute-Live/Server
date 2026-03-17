ALTER TABLE "devices"
    ADD COLUMN IF NOT EXISTS "firmware_version" text;
