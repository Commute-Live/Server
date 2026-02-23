CREATE TABLE "septa_ingest_runs" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "status" text NOT NULL DEFAULT 'running',
    "started_at" timestamptz NOT NULL DEFAULT now(),
    "finished_at" timestamptz,
    "stats_json" jsonb NOT NULL DEFAULT '{}'::jsonb,
    "error_json" jsonb,
    "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "septa_routes" (
    "mode" text NOT NULL CHECK ("mode" IN ('rail', 'bus', 'trolley')),
    "id" text NOT NULL,
    "short_name" text NOT NULL DEFAULT '',
    "long_name" text NOT NULL DEFAULT '',
    "display_name" text NOT NULL DEFAULT '',
    "active" boolean NOT NULL DEFAULT true,
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_septa_routes" PRIMARY KEY ("mode", "id")
);

CREATE TABLE "septa_stops" (
    "mode" text NOT NULL CHECK ("mode" IN ('rail', 'bus', 'trolley')),
    "id" text NOT NULL,
    "name" text NOT NULL,
    "normalized_name" text NOT NULL DEFAULT '',
    "lat" numeric,
    "lon" numeric,
    "active" boolean NOT NULL DEFAULT true,
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_septa_stops" PRIMARY KEY ("mode", "id")
);

CREATE TABLE "septa_route_stops" (
    "mode" text NOT NULL CHECK ("mode" IN ('rail', 'bus', 'trolley')),
    "route_id" text NOT NULL,
    "stop_id" text NOT NULL,
    "direction" text NOT NULL DEFAULT '',
    "stop_sequence" integer,
    "active" boolean NOT NULL DEFAULT true,
    "updated_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_septa_route_stops" PRIMARY KEY ("mode", "route_id", "stop_id", "direction"),
    CONSTRAINT "fk_septa_route_stops_route"
        FOREIGN KEY ("mode", "route_id") REFERENCES "septa_routes"("mode", "id") ON DELETE CASCADE,
    CONSTRAINT "fk_septa_route_stops_stop"
        FOREIGN KEY ("mode", "stop_id") REFERENCES "septa_stops"("mode", "id") ON DELETE CASCADE
);

CREATE INDEX "idx_septa_route_stops_mode_stop" ON "septa_route_stops" ("mode", "stop_id");
CREATE INDEX "idx_septa_route_stops_mode_route" ON "septa_route_stops" ("mode", "route_id");
CREATE INDEX "idx_septa_stops_mode_name" ON "septa_stops" ("mode", "normalized_name");
