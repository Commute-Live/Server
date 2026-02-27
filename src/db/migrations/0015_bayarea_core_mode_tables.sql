CREATE TABLE "bayarea_bus_stations" (
    "operator_id" text NOT NULL,
    "stop_id" text NOT NULL,
    "stop_name" text NOT NULL,
    "stop_lat" numeric,
    "stop_lon" numeric,
    "parent_station" text,
    "child_stop_ids_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "imported_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_bayarea_bus_stations"
        PRIMARY KEY ("operator_id", "stop_id")
);

CREATE TABLE "bayarea_bus_routes" (
    "operator_id" text NOT NULL,
    "route_id" text NOT NULL,
    "agency_id" text,
    "route_short_name" text NOT NULL DEFAULT '',
    "route_long_name" text NOT NULL DEFAULT '',
    "route_desc" text,
    "route_type" integer NOT NULL,
    "route_url" text,
    "route_color" text,
    "route_text_color" text,
    "route_sort_order" integer,
    "imported_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_bayarea_bus_routes"
        PRIMARY KEY ("operator_id", "route_id")
);

CREATE TABLE "bayarea_bus_route_stops" (
    "operator_id" text NOT NULL,
    "route_id" text NOT NULL,
    "direction_id" integer NOT NULL,
    "stop_id" text NOT NULL,
    "route_stop_sort_order" integer,
    "imported_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_bayarea_bus_route_stops"
        PRIMARY KEY ("operator_id", "route_id", "direction_id", "stop_id")
);

CREATE TABLE "bayarea_tram_stations" (
    "operator_id" text NOT NULL,
    "stop_id" text NOT NULL,
    "stop_name" text NOT NULL,
    "stop_lat" numeric,
    "stop_lon" numeric,
    "parent_station" text,
    "child_stop_ids_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "imported_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_bayarea_tram_stations"
        PRIMARY KEY ("operator_id", "stop_id")
);

CREATE TABLE "bayarea_tram_routes" (
    "operator_id" text NOT NULL,
    "route_id" text NOT NULL,
    "agency_id" text,
    "route_short_name" text NOT NULL DEFAULT '',
    "route_long_name" text NOT NULL DEFAULT '',
    "route_desc" text,
    "route_type" integer NOT NULL,
    "route_url" text,
    "route_color" text,
    "route_text_color" text,
    "route_sort_order" integer,
    "imported_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_bayarea_tram_routes"
        PRIMARY KEY ("operator_id", "route_id")
);

CREATE TABLE "bayarea_tram_route_stops" (
    "operator_id" text NOT NULL,
    "route_id" text NOT NULL,
    "direction_id" integer NOT NULL,
    "stop_id" text NOT NULL,
    "route_stop_sort_order" integer,
    "imported_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_bayarea_tram_route_stops"
        PRIMARY KEY ("operator_id", "route_id", "direction_id", "stop_id")
);

CREATE TABLE "bayarea_cableway_stations" (
    "operator_id" text NOT NULL,
    "stop_id" text NOT NULL,
    "stop_name" text NOT NULL,
    "stop_lat" numeric,
    "stop_lon" numeric,
    "parent_station" text,
    "child_stop_ids_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "imported_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_bayarea_cableway_stations"
        PRIMARY KEY ("operator_id", "stop_id")
);

CREATE TABLE "bayarea_cableway_routes" (
    "operator_id" text NOT NULL,
    "route_id" text NOT NULL,
    "agency_id" text,
    "route_short_name" text NOT NULL DEFAULT '',
    "route_long_name" text NOT NULL DEFAULT '',
    "route_desc" text,
    "route_type" integer NOT NULL,
    "route_url" text,
    "route_color" text,
    "route_text_color" text,
    "route_sort_order" integer,
    "imported_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_bayarea_cableway_routes"
        PRIMARY KEY ("operator_id", "route_id")
);

CREATE TABLE "bayarea_cableway_route_stops" (
    "operator_id" text NOT NULL,
    "route_id" text NOT NULL,
    "direction_id" integer NOT NULL,
    "stop_id" text NOT NULL,
    "route_stop_sort_order" integer,
    "imported_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_bayarea_cableway_route_stops"
        PRIMARY KEY ("operator_id", "route_id", "direction_id", "stop_id")
);

CREATE INDEX "idx_bayarea_bus_stations_operator_name" ON "bayarea_bus_stations" ("operator_id", "stop_name");
CREATE INDEX "idx_bayarea_bus_route_stops_operator_stop" ON "bayarea_bus_route_stops" ("operator_id", "stop_id");
CREATE INDEX "idx_bayarea_bus_route_stops_operator_route" ON "bayarea_bus_route_stops" ("operator_id", "route_id");

CREATE INDEX "idx_bayarea_tram_stations_operator_name" ON "bayarea_tram_stations" ("operator_id", "stop_name");
CREATE INDEX "idx_bayarea_tram_route_stops_operator_stop" ON "bayarea_tram_route_stops" ("operator_id", "stop_id");
CREATE INDEX "idx_bayarea_tram_route_stops_operator_route" ON "bayarea_tram_route_stops" ("operator_id", "route_id");

CREATE INDEX "idx_bayarea_cableway_stations_operator_name" ON "bayarea_cableway_stations" ("operator_id", "stop_name");
CREATE INDEX "idx_bayarea_cableway_route_stops_operator_stop" ON "bayarea_cableway_route_stops" ("operator_id", "stop_id");
CREATE INDEX "idx_bayarea_cableway_route_stops_operator_route" ON "bayarea_cableway_route_stops" ("operator_id", "route_id");
