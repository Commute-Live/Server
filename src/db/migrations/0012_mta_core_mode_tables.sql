CREATE TABLE "mta_subway_stations" (
    "stop_id" text PRIMARY KEY NOT NULL,
    "stop_name" text NOT NULL,
    "stop_lat" numeric,
    "stop_lon" numeric,
    "parent_station" text,
    "child_stop_ids_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "imported_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "mta_subway_routes" (
    "route_id" text PRIMARY KEY NOT NULL,
    "agency_id" text,
    "route_short_name" text NOT NULL DEFAULT '',
    "route_long_name" text NOT NULL DEFAULT '',
    "route_desc" text,
    "route_type" integer NOT NULL,
    "route_url" text,
    "route_color" text,
    "route_text_color" text,
    "route_sort_order" integer,
    "imported_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "mta_subway_route_stops" (
    "route_id" text NOT NULL,
    "direction_id" integer NOT NULL,
    "stop_id" text NOT NULL,
    "route_stop_sort_order" integer,
    "imported_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_mta_subway_route_stops"
        PRIMARY KEY ("route_id", "direction_id", "stop_id")
);

CREATE TABLE "mta_bus_stations" (
    "stop_id" text PRIMARY KEY NOT NULL,
    "stop_name" text NOT NULL,
    "stop_lat" numeric,
    "stop_lon" numeric,
    "parent_station" text,
    "child_stop_ids_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "imported_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "mta_bus_routes" (
    "route_id" text PRIMARY KEY NOT NULL,
    "agency_id" text,
    "route_short_name" text NOT NULL DEFAULT '',
    "route_long_name" text NOT NULL DEFAULT '',
    "route_desc" text,
    "route_type" integer NOT NULL,
    "route_url" text,
    "route_color" text,
    "route_text_color" text,
    "route_sort_order" integer,
    "imported_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "mta_bus_route_stops" (
    "route_id" text NOT NULL,
    "direction_id" integer NOT NULL,
    "stop_id" text NOT NULL,
    "route_stop_sort_order" integer,
    "imported_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_mta_bus_route_stops"
        PRIMARY KEY ("route_id", "direction_id", "stop_id")
);

CREATE TABLE "mta_lirr_stations" (
    "stop_id" text PRIMARY KEY NOT NULL,
    "stop_name" text NOT NULL,
    "stop_lat" numeric,
    "stop_lon" numeric,
    "parent_station" text,
    "child_stop_ids_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "imported_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "mta_lirr_routes" (
    "route_id" text PRIMARY KEY NOT NULL,
    "agency_id" text,
    "route_short_name" text NOT NULL DEFAULT '',
    "route_long_name" text NOT NULL DEFAULT '',
    "route_desc" text,
    "route_type" integer NOT NULL,
    "route_url" text,
    "route_color" text,
    "route_text_color" text,
    "route_sort_order" integer,
    "imported_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "mta_lirr_route_stops" (
    "route_id" text NOT NULL,
    "direction_id" integer NOT NULL,
    "stop_id" text NOT NULL,
    "route_stop_sort_order" integer,
    "imported_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_mta_lirr_route_stops"
        PRIMARY KEY ("route_id", "direction_id", "stop_id")
);

CREATE TABLE "mta_mnr_stations" (
    "stop_id" text PRIMARY KEY NOT NULL,
    "stop_name" text NOT NULL,
    "stop_lat" numeric,
    "stop_lon" numeric,
    "parent_station" text,
    "child_stop_ids_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "imported_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "mta_mnr_routes" (
    "route_id" text PRIMARY KEY NOT NULL,
    "agency_id" text,
    "route_short_name" text NOT NULL DEFAULT '',
    "route_long_name" text NOT NULL DEFAULT '',
    "route_desc" text,
    "route_type" integer NOT NULL,
    "route_url" text,
    "route_color" text,
    "route_text_color" text,
    "route_sort_order" integer,
    "imported_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "mta_mnr_route_stops" (
    "route_id" text NOT NULL,
    "direction_id" integer NOT NULL,
    "stop_id" text NOT NULL,
    "route_stop_sort_order" integer,
    "imported_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_mta_mnr_route_stops"
        PRIMARY KEY ("route_id", "direction_id", "stop_id")
);

CREATE INDEX "idx_mta_subway_stations_name" ON "mta_subway_stations" ("stop_name");
CREATE INDEX "idx_mta_subway_route_stops_stop" ON "mta_subway_route_stops" ("stop_id");
CREATE INDEX "idx_mta_subway_route_stops_route" ON "mta_subway_route_stops" ("route_id");

CREATE INDEX "idx_mta_bus_stations_name" ON "mta_bus_stations" ("stop_name");
CREATE INDEX "idx_mta_bus_route_stops_stop" ON "mta_bus_route_stops" ("stop_id");
CREATE INDEX "idx_mta_bus_route_stops_route" ON "mta_bus_route_stops" ("route_id");

CREATE INDEX "idx_mta_lirr_stations_name" ON "mta_lirr_stations" ("stop_name");
CREATE INDEX "idx_mta_lirr_route_stops_stop" ON "mta_lirr_route_stops" ("stop_id");
CREATE INDEX "idx_mta_lirr_route_stops_route" ON "mta_lirr_route_stops" ("route_id");

CREATE INDEX "idx_mta_mnr_stations_name" ON "mta_mnr_stations" ("stop_name");
CREATE INDEX "idx_mta_mnr_route_stops_stop" ON "mta_mnr_route_stops" ("stop_id");
CREATE INDEX "idx_mta_mnr_route_stops_route" ON "mta_mnr_route_stops" ("route_id");
