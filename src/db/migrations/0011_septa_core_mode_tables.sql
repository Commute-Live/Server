CREATE TABLE "septa_rail_stops" (
    "stop_id" text PRIMARY KEY NOT NULL,
    "stop_name" text NOT NULL,
    "stop_desc" text,
    "stop_lat" numeric,
    "stop_lon" numeric,
    "zone_id" text,
    "stop_url" text,
    "imported_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "septa_rail_routes" (
    "route_id" text PRIMARY KEY NOT NULL,
    "agency_id" text,
    "route_short_name" text NOT NULL DEFAULT '',
    "route_long_name" text NOT NULL DEFAULT '',
    "route_desc" text,
    "route_type" integer NOT NULL,
    "route_url" text,
    "route_color" text,
    "route_text_color" text,
    "imported_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "septa_rail_route_stops" (
    "route_id" text NOT NULL,
    "direction_id" integer NOT NULL,
    "stop_id" text NOT NULL,
    "route_stop_sort_order" integer NOT NULL,
    "imported_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_septa_rail_route_stops"
        PRIMARY KEY ("route_id", "direction_id", "stop_id")
);

CREATE TABLE "septa_bus_stops" (
    "stop_id" text PRIMARY KEY NOT NULL,
    "stop_code" text,
    "stop_name" text NOT NULL,
    "stop_desc" text,
    "stop_lat" numeric,
    "stop_lon" numeric,
    "zone_id" text,
    "stop_url" text,
    "location_type" integer,
    "parent_station" text,
    "stop_timezone" text,
    "wheelchair_boarding" integer,
    "imported_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "septa_bus_routes" (
    "route_id" text PRIMARY KEY NOT NULL,
    "agency_id" text,
    "route_short_name" text NOT NULL DEFAULT '',
    "route_long_name" text NOT NULL DEFAULT '',
    "route_desc" text,
    "route_type" integer NOT NULL,
    "route_url" text,
    "route_color" text,
    "route_text_color" text,
    "network_id" text,
    "imported_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "septa_bus_route_stops" (
    "route_id" text NOT NULL,
    "direction_id" integer NOT NULL,
    "stop_id" text NOT NULL,
    "route_stop_sort_order" integer NOT NULL,
    "imported_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_septa_bus_route_stops"
        PRIMARY KEY ("route_id", "direction_id", "stop_id")
);

CREATE TABLE "septa_trolley_stops" (
    "stop_id" text PRIMARY KEY NOT NULL,
    "stop_code" text,
    "stop_name" text NOT NULL,
    "stop_desc" text,
    "stop_lat" numeric,
    "stop_lon" numeric,
    "zone_id" text,
    "stop_url" text,
    "location_type" integer,
    "parent_station" text,
    "stop_timezone" text,
    "wheelchair_boarding" integer,
    "imported_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "septa_trolley_routes" (
    "route_id" text PRIMARY KEY NOT NULL,
    "agency_id" text,
    "route_short_name" text NOT NULL DEFAULT '',
    "route_long_name" text NOT NULL DEFAULT '',
    "route_desc" text,
    "route_type" integer NOT NULL,
    "route_url" text,
    "route_color" text,
    "route_text_color" text,
    "network_id" text,
    "imported_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "septa_trolley_route_stops" (
    "route_id" text NOT NULL,
    "direction_id" integer NOT NULL,
    "stop_id" text NOT NULL,
    "route_stop_sort_order" integer NOT NULL,
    "imported_at" timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT "pk_septa_trolley_route_stops"
        PRIMARY KEY ("route_id", "direction_id", "stop_id")
);

CREATE INDEX "idx_septa_rail_stops_name" ON "septa_rail_stops" ("stop_name");
CREATE INDEX "idx_septa_rail_route_stops_stop" ON "septa_rail_route_stops" ("stop_id");
CREATE INDEX "idx_septa_rail_route_stops_route" ON "septa_rail_route_stops" ("route_id");

CREATE INDEX "idx_septa_bus_stops_name" ON "septa_bus_stops" ("stop_name");
CREATE INDEX "idx_septa_bus_route_stops_stop" ON "septa_bus_route_stops" ("stop_id");
CREATE INDEX "idx_septa_bus_route_stops_route" ON "septa_bus_route_stops" ("route_id");

CREATE INDEX "idx_septa_trolley_stops_name" ON "septa_trolley_stops" ("stop_name");
CREATE INDEX "idx_septa_trolley_route_stops_stop" ON "septa_trolley_route_stops" ("stop_id");
CREATE INDEX "idx_septa_trolley_route_stops_route" ON "septa_trolley_route_stops" ("route_id");
