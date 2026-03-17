CREATE TABLE "displays" (
    "id" text PRIMARY KEY NOT NULL,
    "device_id" text NOT NULL REFERENCES "devices"("id") ON DELETE cascade,
    "config" jsonb NOT NULL DEFAULT '{}'::jsonb,
    "created_at" timestamp with time zone NOT NULL DEFAULT now(),
    "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX "idx_displays_device_id" ON "displays" ("device_id");
CREATE INDEX "idx_displays_device_created" ON "displays" ("device_id", "created_at");

INSERT INTO "displays" ("id", "device_id", "config", "created_at", "updated_at")
SELECT
    "id" || '-default',
    "id",
    "config",
    "created_at",
    "updated_at"
FROM "devices"
WHERE "config" IS NOT NULL
  AND "config" <> '{}'::jsonb;

ALTER TABLE "devices" DROP COLUMN "config";
