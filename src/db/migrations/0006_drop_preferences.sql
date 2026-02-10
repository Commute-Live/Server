-- Remove deprecated preferences column; config jsonb now holds device settings
ALTER TABLE "devices"
    DROP COLUMN IF EXISTS "preferences";
