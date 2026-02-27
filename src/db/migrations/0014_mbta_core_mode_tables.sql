CREATE TABLE "mbta_subway_stations" (
    "stop_id" text PRIMARY KEY NOT NULL,
    "stop_name" text NOT NULL,
    "stop_lat" numeric,
    "stop_lon" numeric,
    "parent_station" text,
    "child_stop_ids_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "imported_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "mbta_subway_routes" (
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
    "line_id" text,
    "imported_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "mbta_subway_route_stops" (
    "route_id" text NOT NULL,
    "direction_id" integer NOT NULL,
    "stop_id" text NOT NULL,
    "route_stop_sort_order" integer,
    "imported_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_mbta_subway_route_stops"
        PRIMARY KEY ("route_id", "direction_id", "stop_id")
);

CREATE TABLE "mbta_bus_stations" (
    "stop_id" text PRIMARY KEY NOT NULL,
    "stop_name" text NOT NULL,
    "stop_lat" numeric,
    "stop_lon" numeric,
    "parent_station" text,
    "child_stop_ids_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "imported_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "mbta_bus_routes" (
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
    "line_id" text,
    "imported_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "mbta_bus_route_stops" (
    "route_id" text NOT NULL,
    "direction_id" integer NOT NULL,
    "stop_id" text NOT NULL,
    "route_stop_sort_order" integer,
    "imported_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_mbta_bus_route_stops"
        PRIMARY KEY ("route_id", "direction_id", "stop_id")
);

CREATE TABLE "mbta_rail_stations" (
    "stop_id" text PRIMARY KEY NOT NULL,
    "stop_name" text NOT NULL,
    "stop_lat" numeric,
    "stop_lon" numeric,
    "parent_station" text,
    "child_stop_ids_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "imported_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "mbta_rail_routes" (
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
    "line_id" text,
    "imported_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "mbta_rail_route_stops" (
    "route_id" text NOT NULL,
    "direction_id" integer NOT NULL,
    "stop_id" text NOT NULL,
    "route_stop_sort_order" integer,
    "imported_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_mbta_rail_route_stops"
        PRIMARY KEY ("route_id", "direction_id", "stop_id")
);

CREATE TABLE "mbta_ferry_stations" (
    "stop_id" text PRIMARY KEY NOT NULL,
    "stop_name" text NOT NULL,
    "stop_lat" numeric,
    "stop_lon" numeric,
    "parent_station" text,
    "child_stop_ids_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "imported_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "mbta_ferry_routes" (
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
    "line_id" text,
    "imported_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "mbta_ferry_route_stops" (
    "route_id" text NOT NULL,
    "direction_id" integer NOT NULL,
    "stop_id" text NOT NULL,
    "route_stop_sort_order" integer,
    "imported_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_mbta_ferry_route_stops"
        PRIMARY KEY ("route_id", "direction_id", "stop_id")
);

CREATE INDEX "idx_mbta_subway_stations_name" ON "mbta_subway_stations" ("stop_name");
CREATE INDEX "idx_mbta_subway_route_stops_stop" ON "mbta_subway_route_stops" ("stop_id");
CREATE INDEX "idx_mbta_subway_route_stops_route" ON "mbta_subway_route_stops" ("route_id");

CREATE INDEX "idx_mbta_bus_stations_name" ON "mbta_bus_stations" ("stop_name");
CREATE INDEX "idx_mbta_bus_route_stops_stop" ON "mbta_bus_route_stops" ("stop_id");
CREATE INDEX "idx_mbta_bus_route_stops_route" ON "mbta_bus_route_stops" ("route_id");

CREATE INDEX "idx_mbta_rail_stations_name" ON "mbta_rail_stations" ("stop_name");
CREATE INDEX "idx_mbta_rail_route_stops_stop" ON "mbta_rail_route_stops" ("stop_id");
CREATE INDEX "idx_mbta_rail_route_stops_route" ON "mbta_rail_route_stops" ("route_id");

CREATE INDEX "idx_mbta_ferry_stations_name" ON "mbta_ferry_stations" ("stop_name");
CREATE INDEX "idx_mbta_ferry_route_stops_stop" ON "mbta_ferry_route_stops" ("stop_id");
CREATE INDEX "idx_mbta_ferry_route_stops_route" ON "mbta_ferry_route_stops" ("route_id");
