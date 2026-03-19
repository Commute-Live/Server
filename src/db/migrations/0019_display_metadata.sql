ALTER TABLE "displays"
ADD COLUMN "name" text NOT NULL DEFAULT '',
ADD COLUMN "paused" boolean NOT NULL DEFAULT false,
ADD COLUMN "priority" integer NOT NULL DEFAULT 0,
ADD COLUMN "sort_order" integer NOT NULL DEFAULT 0,
ADD COLUMN "schedule_start" text,
ADD COLUMN "schedule_end" text,
ADD COLUMN "schedule_days" jsonb NOT NULL DEFAULT '[]'::jsonb;

WITH ordered_displays AS (
    SELECT
        id,
        ROW_NUMBER() OVER (
            PARTITION BY device_id
            ORDER BY created_at ASC, id ASC
        ) - 1 AS next_sort_order
    FROM displays
)
UPDATE displays
SET sort_order = ordered_displays.next_sort_order
FROM ordered_displays
WHERE displays.id = ordered_displays.id;

CREATE INDEX "idx_displays_device_sort" ON "displays" USING btree ("device_id","sort_order");
