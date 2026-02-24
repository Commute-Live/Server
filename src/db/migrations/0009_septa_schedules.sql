CREATE TABLE "septa_scheduled_stop_times" (
    "mode" text NOT NULL CHECK ("mode" IN ('rail', 'bus', 'trolley')),
    "route_id" text NOT NULL,
    "stop_id" text NOT NULL,
    "direction" text NOT NULL DEFAULT '',
    "trip_id" text NOT NULL,
    "service_id" text NOT NULL,
    "headsign" text NOT NULL DEFAULT '',
    "arrival_seconds" integer NOT NULL,
    "departure_seconds" integer,
    "stop_sequence" integer,
    "active" boolean NOT NULL DEFAULT true,
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_septa_scheduled_stop_times"
        PRIMARY KEY ("mode", "trip_id", "stop_id", "arrival_seconds")
);

CREATE TABLE "septa_service_dates" (
    "mode" text NOT NULL CHECK ("mode" IN ('rail', 'bus', 'trolley')),
    "service_id" text NOT NULL,
    "service_date" text NOT NULL,
    "active" boolean NOT NULL DEFAULT true,
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_septa_service_dates" PRIMARY KEY ("mode", "service_id", "service_date")
);

CREATE INDEX "idx_septa_sched_mode_route_stop_dir_arrival"
    ON "septa_scheduled_stop_times" ("mode", "route_id", "stop_id", "direction", "arrival_seconds");
CREATE INDEX "idx_septa_sched_mode_stop_arrival"
    ON "septa_scheduled_stop_times" ("mode", "stop_id", "arrival_seconds");
CREATE INDEX "idx_septa_service_dates_mode_date_service"
    ON "septa_service_dates" ("mode", "service_date", "service_id");
