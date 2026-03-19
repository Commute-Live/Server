CREATE TABLE "njt_rail_stations" (
    "stop_id" text PRIMARY KEY NOT NULL,
    "stop_name" text NOT NULL,
    "stop_lat" numeric,
    "stop_lon" numeric,
    "parent_station" text,
    "child_stop_ids_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "imported_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE "njt_rail_routes" (
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
    "imported_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE "njt_rail_route_stops" (
    "route_id" text NOT NULL,
    "direction_id" integer NOT NULL,
    "stop_id" text NOT NULL,
    "route_stop_sort_order" integer,
    "imported_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "pk_njt_rail_route_stops" PRIMARY KEY("route_id","direction_id","stop_id")
);

CREATE TABLE "njt_bus_stations" (
    "stop_id" text PRIMARY KEY NOT NULL,
    "stop_name" text NOT NULL,
    "stop_lat" numeric,
    "stop_lon" numeric,
    "parent_station" text,
    "child_stop_ids_json" jsonb NOT NULL DEFAULT '[]'::jsonb,
    "imported_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE "njt_bus_routes" (
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
    "imported_at" timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE "njt_bus_route_stops" (
    "route_id" text NOT NULL,
    "direction_id" integer NOT NULL,
    "stop_id" text NOT NULL,
    "route_stop_sort_order" integer,
    "imported_at" timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT "pk_njt_bus_route_stops" PRIMARY KEY("route_id","direction_id","stop_id")
);
