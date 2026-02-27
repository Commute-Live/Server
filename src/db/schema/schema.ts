import {
    boolean,
    integer,
    jsonb,
    numeric,
    pgTable,
    primaryKey,
    text,
    timestamp,
    uniqueIndex,
    uuid,
} from "drizzle-orm/pg-core";
import type { DeviceConfig } from "../../types.ts";

// Devices: physical hardware unit
export const devices = pgTable("devices", {
    id: text("id").primaryKey(),
    timezone: text("timezone").notNull().default("UTC"),
    config: jsonb("config").$type<DeviceConfig>().notNull().default({}),
    lastActive: timestamp("last_active", { withTimezone: true, mode: "string" }),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
});

// Users: accounts (devices are linked separately)
export const users = pgTable(
    "users",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        email: text("email").notNull(),
        passwordHash: text("password_hash").notNull(),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
    },
    (table) => ({
        emailIdx: uniqueIndex("idx_users_email").on(table.email),
    })
);

// Join: many devices per user, device belongs to one user
export const userDevices = pgTable(
    "user_devices",
    {
        userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        deviceId: text("device_id").notNull().references(() => devices.id, { onDelete: "cascade" }),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
    },
    (table) => ({
        pk: primaryKey({ columns: [table.userId, table.deviceId], name: "pk_user_devices" }),
        deviceUnique: uniqueIndex("idx_user_devices_device").on(table.deviceId),
    })
);

// Refresh token session history for rotation + revocation
export const authRefreshSessions = pgTable(
    "auth_refresh_sessions",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
        sessionId: uuid("session_id").notNull(),
        familyId: uuid("family_id").notNull(),
        tokenJti: text("token_jti").notNull(),
        tokenHash: text("token_hash").notNull(),
        expiresAt: timestamp("expires_at", { withTimezone: true, mode: "string" }).notNull(),
        rotatedAt: timestamp("rotated_at", { withTimezone: true, mode: "string" }),
        revokedAt: timestamp("revoked_at", { withTimezone: true, mode: "string" }),
        replacedByJti: text("replaced_by_jti"),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
    },
    (table) => ({
        tokenJtiUnique: uniqueIndex("idx_auth_refresh_sessions_token_jti").on(table.tokenJti),
        sessionUserIdx: uniqueIndex("idx_auth_refresh_sessions_user_session_jti").on(
            table.userId,
            table.sessionId,
            table.tokenJti
        ),
    })
);

export type SeptaMode = "rail" | "bus" | "trolley";

export const septaIngestRuns = pgTable("septa_ingest_runs", {
    id: uuid("id").primaryKey().defaultRandom(),
    status: text("status").notNull().default("running"),
    startedAt: timestamp("started_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true, mode: "string" }),
    statsJson: jsonb("stats_json").$type<Record<string, unknown>>().notNull().default({}),
    errorJson: jsonb("error_json").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
});

export const septaRoutes = pgTable(
    "septa_routes",
    {
        mode: text("mode").$type<SeptaMode>().notNull(),
        id: text("id").notNull(),
        shortName: text("short_name").notNull().default(""),
        longName: text("long_name").notNull().default(""),
        displayName: text("display_name").notNull().default(""),
        active: boolean("active").notNull().default(true),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
            .defaultNow()
            .notNull(),
    },
    (table) => ({
        pk: primaryKey({ columns: [table.mode, table.id], name: "pk_septa_routes" }),
    }),
);

export const septaStops = pgTable(
    "septa_stops",
    {
        mode: text("mode").$type<SeptaMode>().notNull(),
        id: text("id").notNull(),
        name: text("name").notNull(),
        normalizedName: text("normalized_name").notNull().default(""),
        lat: numeric("lat"),
        lon: numeric("lon"),
        active: boolean("active").notNull().default(true),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
            .defaultNow()
            .notNull(),
    },
    (table) => ({
        pk: primaryKey({ columns: [table.mode, table.id], name: "pk_septa_stops" }),
        normalizedNameIdx: uniqueIndex("idx_septa_stops_mode_name_id").on(
            table.mode,
            table.normalizedName,
            table.id,
        ),
    }),
);

export const septaRouteStops = pgTable(
    "septa_route_stops",
    {
        mode: text("mode").$type<SeptaMode>().notNull(),
        routeId: text("route_id").notNull(),
        stopId: text("stop_id").notNull(),
        direction: text("direction").notNull().default(""),
        stopSequence: integer("stop_sequence"),
        active: boolean("active").notNull().default(true),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
            .defaultNow()
            .notNull(),
    },
    (table) => ({
        pk: primaryKey({
            columns: [table.mode, table.routeId, table.stopId, table.direction],
            name: "pk_septa_route_stops",
        }),
    }),
);

export const septaScheduledStopTimes = pgTable(
    "septa_scheduled_stop_times",
    {
        mode: text("mode").$type<SeptaMode>().notNull(),
        routeId: text("route_id").notNull(),
        stopId: text("stop_id").notNull(),
        direction: text("direction").notNull().default(""),
        tripId: text("trip_id").notNull(),
        serviceId: text("service_id").notNull(),
        headsign: text("headsign").notNull().default(""),
        arrivalSeconds: integer("arrival_seconds").notNull(),
        departureSeconds: integer("departure_seconds"),
        stopSequence: integer("stop_sequence"),
        active: boolean("active").notNull().default(true),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
            .defaultNow()
            .notNull(),
    },
    (table) => ({
        pk: primaryKey({
            columns: [table.mode, table.tripId, table.stopId, table.arrivalSeconds],
            name: "pk_septa_scheduled_stop_times",
        }),
    }),
);

export const septaServiceDates = pgTable(
    "septa_service_dates",
    {
        mode: text("mode").$type<SeptaMode>().notNull(),
        serviceId: text("service_id").notNull(),
        serviceDate: text("service_date").notNull(), // YYYYMMDD in America/New_York
        active: boolean("active").notNull().default(true),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" })
            .defaultNow()
            .notNull(),
    },
    (table) => ({
        pk: primaryKey({
            columns: [table.mode, table.serviceId, table.serviceDate],
            name: "pk_septa_service_dates",
        }),
    }),
);

export const septaRailStops = pgTable("septa_rail_stops", {
    stopId: text("stop_id").primaryKey(),
    stopName: text("stop_name").notNull(),
    stopDesc: text("stop_desc"),
    stopLat: numeric("stop_lat"),
    stopLon: numeric("stop_lon"),
    zoneId: text("zone_id"),
    stopUrl: text("stop_url"),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
});

export const septaRailRoutes = pgTable("septa_rail_routes", {
    routeId: text("route_id").primaryKey(),
    agencyId: text("agency_id"),
    routeShortName: text("route_short_name").notNull().default(""),
    routeLongName: text("route_long_name").notNull().default(""),
    routeDesc: text("route_desc"),
    routeType: integer("route_type").notNull(),
    routeUrl: text("route_url"),
    routeColor: text("route_color"),
    routeTextColor: text("route_text_color"),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
});

export const septaRailRouteStops = pgTable(
    "septa_rail_route_stops",
    {
        routeId: text("route_id").notNull(),
        directionId: integer("direction_id").notNull(),
        stopId: text("stop_id").notNull(),
        routeStopSortOrder: integer("route_stop_sort_order").notNull(),
        importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
            .defaultNow()
            .notNull(),
    },
    (table) => ({
        pk: primaryKey({
            columns: [table.routeId, table.directionId, table.stopId],
            name: "pk_septa_rail_route_stops",
        }),
    }),
);

export const septaBusStops = pgTable("septa_bus_stops", {
    stopId: text("stop_id").primaryKey(),
    stopCode: text("stop_code"),
    stopName: text("stop_name").notNull(),
    stopDesc: text("stop_desc"),
    stopLat: numeric("stop_lat"),
    stopLon: numeric("stop_lon"),
    zoneId: text("zone_id"),
    stopUrl: text("stop_url"),
    locationType: integer("location_type"),
    parentStation: text("parent_station"),
    stopTimezone: text("stop_timezone"),
    wheelchairBoarding: integer("wheelchair_boarding"),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
});

export const septaBusRoutes = pgTable("septa_bus_routes", {
    routeId: text("route_id").primaryKey(),
    agencyId: text("agency_id"),
    routeShortName: text("route_short_name").notNull().default(""),
    routeLongName: text("route_long_name").notNull().default(""),
    routeDesc: text("route_desc"),
    routeType: integer("route_type").notNull(),
    routeUrl: text("route_url"),
    routeColor: text("route_color"),
    routeTextColor: text("route_text_color"),
    networkId: text("network_id"),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
});

export const septaBusRouteStops = pgTable(
    "septa_bus_route_stops",
    {
        routeId: text("route_id").notNull(),
        directionId: integer("direction_id").notNull(),
        stopId: text("stop_id").notNull(),
        routeStopSortOrder: integer("route_stop_sort_order").notNull(),
        importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
            .defaultNow()
            .notNull(),
    },
    (table) => ({
        pk: primaryKey({
            columns: [table.routeId, table.directionId, table.stopId],
            name: "pk_septa_bus_route_stops",
        }),
    }),
);

export const septaTrolleyStops = pgTable("septa_trolley_stops", {
    stopId: text("stop_id").primaryKey(),
    stopCode: text("stop_code"),
    stopName: text("stop_name").notNull(),
    stopDesc: text("stop_desc"),
    stopLat: numeric("stop_lat"),
    stopLon: numeric("stop_lon"),
    zoneId: text("zone_id"),
    stopUrl: text("stop_url"),
    locationType: integer("location_type"),
    parentStation: text("parent_station"),
    stopTimezone: text("stop_timezone"),
    wheelchairBoarding: integer("wheelchair_boarding"),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
});

export const septaTrolleyRoutes = pgTable("septa_trolley_routes", {
    routeId: text("route_id").primaryKey(),
    agencyId: text("agency_id"),
    routeShortName: text("route_short_name").notNull().default(""),
    routeLongName: text("route_long_name").notNull().default(""),
    routeDesc: text("route_desc"),
    routeType: integer("route_type").notNull(),
    routeUrl: text("route_url"),
    routeColor: text("route_color"),
    routeTextColor: text("route_text_color"),
    networkId: text("network_id"),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
});

export const septaTrolleyRouteStops = pgTable(
    "septa_trolley_route_stops",
    {
        routeId: text("route_id").notNull(),
        directionId: integer("direction_id").notNull(),
        stopId: text("stop_id").notNull(),
        routeStopSortOrder: integer("route_stop_sort_order").notNull(),
        importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
            .defaultNow()
            .notNull(),
    },
    (table) => ({
        pk: primaryKey({
            columns: [table.routeId, table.directionId, table.stopId],
            name: "pk_septa_trolley_route_stops",
        }),
    }),
);

export type MtaMode = "subway" | "bus" | "lirr" | "mnr";

export const mtaSubwayStations = pgTable("mta_subway_stations", {
    stopId: text("stop_id").primaryKey(),
    stopName: text("stop_name").notNull(),
    stopLat: numeric("stop_lat"),
    stopLon: numeric("stop_lon"),
    parentStation: text("parent_station"),
    childStopIdsJson: jsonb("child_stop_ids_json").$type<string[]>().notNull().default([]),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
});

export const mtaSubwayRoutes = pgTable("mta_subway_routes", {
    routeId: text("route_id").primaryKey(),
    agencyId: text("agency_id"),
    routeShortName: text("route_short_name").notNull().default(""),
    routeLongName: text("route_long_name").notNull().default(""),
    routeDesc: text("route_desc"),
    routeType: integer("route_type").notNull(),
    routeUrl: text("route_url"),
    routeColor: text("route_color"),
    routeTextColor: text("route_text_color"),
    routeSortOrder: integer("route_sort_order"),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
});

export const mtaSubwayRouteStops = pgTable(
    "mta_subway_route_stops",
    {
        routeId: text("route_id").notNull(),
        directionId: integer("direction_id").notNull(),
        stopId: text("stop_id").notNull(),
        routeStopSortOrder: integer("route_stop_sort_order"),
        importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
            .defaultNow()
            .notNull(),
    },
    (table) => ({
        pk: primaryKey({
            columns: [table.routeId, table.directionId, table.stopId],
            name: "pk_mta_subway_route_stops",
        }),
    }),
);

export const mtaBusStations = pgTable("mta_bus_stations", {
    stopId: text("stop_id").primaryKey(),
    stopName: text("stop_name").notNull(),
    stopLat: numeric("stop_lat"),
    stopLon: numeric("stop_lon"),
    parentStation: text("parent_station"),
    childStopIdsJson: jsonb("child_stop_ids_json").$type<string[]>().notNull().default([]),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
});

export const mtaBusRoutes = pgTable("mta_bus_routes", {
    routeId: text("route_id").primaryKey(),
    agencyId: text("agency_id"),
    routeShortName: text("route_short_name").notNull().default(""),
    routeLongName: text("route_long_name").notNull().default(""),
    routeDesc: text("route_desc"),
    routeType: integer("route_type").notNull(),
    routeUrl: text("route_url"),
    routeColor: text("route_color"),
    routeTextColor: text("route_text_color"),
    routeSortOrder: integer("route_sort_order"),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
});

export const mtaBusRouteStops = pgTable(
    "mta_bus_route_stops",
    {
        routeId: text("route_id").notNull(),
        directionId: integer("direction_id").notNull(),
        stopId: text("stop_id").notNull(),
        routeStopSortOrder: integer("route_stop_sort_order"),
        importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
            .defaultNow()
            .notNull(),
    },
    (table) => ({
        pk: primaryKey({
            columns: [table.routeId, table.directionId, table.stopId],
            name: "pk_mta_bus_route_stops",
        }),
    }),
);

export const mtaLirrStations = pgTable("mta_lirr_stations", {
    stopId: text("stop_id").primaryKey(),
    stopName: text("stop_name").notNull(),
    stopLat: numeric("stop_lat"),
    stopLon: numeric("stop_lon"),
    parentStation: text("parent_station"),
    childStopIdsJson: jsonb("child_stop_ids_json").$type<string[]>().notNull().default([]),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
});

export const mtaLirrRoutes = pgTable("mta_lirr_routes", {
    routeId: text("route_id").primaryKey(),
    agencyId: text("agency_id"),
    routeShortName: text("route_short_name").notNull().default(""),
    routeLongName: text("route_long_name").notNull().default(""),
    routeDesc: text("route_desc"),
    routeType: integer("route_type").notNull(),
    routeUrl: text("route_url"),
    routeColor: text("route_color"),
    routeTextColor: text("route_text_color"),
    routeSortOrder: integer("route_sort_order"),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
});

export const mtaLirrRouteStops = pgTable(
    "mta_lirr_route_stops",
    {
        routeId: text("route_id").notNull(),
        directionId: integer("direction_id").notNull(),
        stopId: text("stop_id").notNull(),
        routeStopSortOrder: integer("route_stop_sort_order"),
        importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
            .defaultNow()
            .notNull(),
    },
    (table) => ({
        pk: primaryKey({
            columns: [table.routeId, table.directionId, table.stopId],
            name: "pk_mta_lirr_route_stops",
        }),
    }),
);

export const mtaMnrStations = pgTable("mta_mnr_stations", {
    stopId: text("stop_id").primaryKey(),
    stopName: text("stop_name").notNull(),
    stopLat: numeric("stop_lat"),
    stopLon: numeric("stop_lon"),
    parentStation: text("parent_station"),
    childStopIdsJson: jsonb("child_stop_ids_json").$type<string[]>().notNull().default([]),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
});

export const mtaMnrRoutes = pgTable("mta_mnr_routes", {
    routeId: text("route_id").primaryKey(),
    agencyId: text("agency_id"),
    routeShortName: text("route_short_name").notNull().default(""),
    routeLongName: text("route_long_name").notNull().default(""),
    routeDesc: text("route_desc"),
    routeType: integer("route_type").notNull(),
    routeUrl: text("route_url"),
    routeColor: text("route_color"),
    routeTextColor: text("route_text_color"),
    routeSortOrder: integer("route_sort_order"),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
});

export const mtaMnrRouteStops = pgTable(
    "mta_mnr_route_stops",
    {
        routeId: text("route_id").notNull(),
        directionId: integer("direction_id").notNull(),
        stopId: text("stop_id").notNull(),
        routeStopSortOrder: integer("route_stop_sort_order"),
        importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
            .defaultNow()
            .notNull(),
    },
    (table) => ({
        pk: primaryKey({
            columns: [table.routeId, table.directionId, table.stopId],
            name: "pk_mta_mnr_route_stops",
        }),
    }),
);

export type CtaMode = "subway" | "bus";

export const ctaSubwayStations = pgTable("cta_subway_stations", {
    stopId: text("stop_id").primaryKey(),
    stopName: text("stop_name").notNull(),
    stopLat: numeric("stop_lat"),
    stopLon: numeric("stop_lon"),
    parentStation: text("parent_station"),
    childStopIdsJson: jsonb("child_stop_ids_json").$type<string[]>().notNull().default([]),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
});

export const ctaSubwayRoutes = pgTable("cta_subway_routes", {
    routeId: text("route_id").primaryKey(),
    agencyId: text("agency_id"),
    routeShortName: text("route_short_name").notNull().default(""),
    routeLongName: text("route_long_name").notNull().default(""),
    routeDesc: text("route_desc"),
    routeType: integer("route_type").notNull(),
    routeUrl: text("route_url"),
    routeColor: text("route_color"),
    routeTextColor: text("route_text_color"),
    routeSortOrder: integer("route_sort_order"),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
});

export const ctaSubwayRouteStops = pgTable(
    "cta_subway_route_stops",
    {
        routeId: text("route_id").notNull(),
        directionId: integer("direction_id").notNull(),
        stopId: text("stop_id").notNull(),
        routeStopSortOrder: integer("route_stop_sort_order"),
        importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
            .defaultNow()
            .notNull(),
    },
    (table) => ({
        pk: primaryKey({
            columns: [table.routeId, table.directionId, table.stopId],
            name: "pk_cta_subway_route_stops",
        }),
    }),
);

export const ctaBusStations = pgTable("cta_bus_stations", {
    stopId: text("stop_id").primaryKey(),
    stopName: text("stop_name").notNull(),
    stopLat: numeric("stop_lat"),
    stopLon: numeric("stop_lon"),
    parentStation: text("parent_station"),
    childStopIdsJson: jsonb("child_stop_ids_json").$type<string[]>().notNull().default([]),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
});

export const ctaBusRoutes = pgTable("cta_bus_routes", {
    routeId: text("route_id").primaryKey(),
    agencyId: text("agency_id"),
    routeShortName: text("route_short_name").notNull().default(""),
    routeLongName: text("route_long_name").notNull().default(""),
    routeDesc: text("route_desc"),
    routeType: integer("route_type").notNull(),
    routeUrl: text("route_url"),
    routeColor: text("route_color"),
    routeTextColor: text("route_text_color"),
    routeSortOrder: integer("route_sort_order"),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
});

export const ctaBusRouteStops = pgTable(
    "cta_bus_route_stops",
    {
        routeId: text("route_id").notNull(),
        directionId: integer("direction_id").notNull(),
        stopId: text("stop_id").notNull(),
        routeStopSortOrder: integer("route_stop_sort_order"),
        importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
            .defaultNow()
            .notNull(),
    },
    (table) => ({
        pk: primaryKey({
            columns: [table.routeId, table.directionId, table.stopId],
            name: "pk_cta_bus_route_stops",
        }),
    }),
);

export type MbtaMode = "subway" | "bus" | "rail" | "ferry";

export const mbtaSubwayStations = pgTable("mbta_subway_stations", {
    stopId: text("stop_id").primaryKey(),
    stopName: text("stop_name").notNull(),
    stopLat: numeric("stop_lat"),
    stopLon: numeric("stop_lon"),
    parentStation: text("parent_station"),
    childStopIdsJson: jsonb("child_stop_ids_json").$type<string[]>().notNull().default([]),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
});

export const mbtaSubwayRoutes = pgTable("mbta_subway_routes", {
    routeId: text("route_id").primaryKey(),
    agencyId: text("agency_id"),
    routeShortName: text("route_short_name").notNull().default(""),
    routeLongName: text("route_long_name").notNull().default(""),
    routeDesc: text("route_desc"),
    routeType: integer("route_type").notNull(),
    routeUrl: text("route_url"),
    routeColor: text("route_color"),
    routeTextColor: text("route_text_color"),
    routeSortOrder: integer("route_sort_order"),
    lineId: text("line_id"),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
});

export const mbtaSubwayRouteStops = pgTable(
    "mbta_subway_route_stops",
    {
        routeId: text("route_id").notNull(),
        directionId: integer("direction_id").notNull(),
        stopId: text("stop_id").notNull(),
        routeStopSortOrder: integer("route_stop_sort_order"),
        importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
            .defaultNow()
            .notNull(),
    },
    (table) => ({
        pk: primaryKey({
            columns: [table.routeId, table.directionId, table.stopId],
            name: "pk_mbta_subway_route_stops",
        }),
    }),
);

export const mbtaBusStations = pgTable("mbta_bus_stations", {
    stopId: text("stop_id").primaryKey(),
    stopName: text("stop_name").notNull(),
    stopLat: numeric("stop_lat"),
    stopLon: numeric("stop_lon"),
    parentStation: text("parent_station"),
    childStopIdsJson: jsonb("child_stop_ids_json").$type<string[]>().notNull().default([]),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
});

export const mbtaBusRoutes = pgTable("mbta_bus_routes", {
    routeId: text("route_id").primaryKey(),
    agencyId: text("agency_id"),
    routeShortName: text("route_short_name").notNull().default(""),
    routeLongName: text("route_long_name").notNull().default(""),
    routeDesc: text("route_desc"),
    routeType: integer("route_type").notNull(),
    routeUrl: text("route_url"),
    routeColor: text("route_color"),
    routeTextColor: text("route_text_color"),
    routeSortOrder: integer("route_sort_order"),
    lineId: text("line_id"),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
});

export const mbtaBusRouteStops = pgTable(
    "mbta_bus_route_stops",
    {
        routeId: text("route_id").notNull(),
        directionId: integer("direction_id").notNull(),
        stopId: text("stop_id").notNull(),
        routeStopSortOrder: integer("route_stop_sort_order"),
        importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
            .defaultNow()
            .notNull(),
    },
    (table) => ({
        pk: primaryKey({
            columns: [table.routeId, table.directionId, table.stopId],
            name: "pk_mbta_bus_route_stops",
        }),
    }),
);

export const mbtaRailStations = pgTable("mbta_rail_stations", {
    stopId: text("stop_id").primaryKey(),
    stopName: text("stop_name").notNull(),
    stopLat: numeric("stop_lat"),
    stopLon: numeric("stop_lon"),
    parentStation: text("parent_station"),
    childStopIdsJson: jsonb("child_stop_ids_json").$type<string[]>().notNull().default([]),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
});

export const mbtaRailRoutes = pgTable("mbta_rail_routes", {
    routeId: text("route_id").primaryKey(),
    agencyId: text("agency_id"),
    routeShortName: text("route_short_name").notNull().default(""),
    routeLongName: text("route_long_name").notNull().default(""),
    routeDesc: text("route_desc"),
    routeType: integer("route_type").notNull(),
    routeUrl: text("route_url"),
    routeColor: text("route_color"),
    routeTextColor: text("route_text_color"),
    routeSortOrder: integer("route_sort_order"),
    lineId: text("line_id"),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
});

export const mbtaRailRouteStops = pgTable(
    "mbta_rail_route_stops",
    {
        routeId: text("route_id").notNull(),
        directionId: integer("direction_id").notNull(),
        stopId: text("stop_id").notNull(),
        routeStopSortOrder: integer("route_stop_sort_order"),
        importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
            .defaultNow()
            .notNull(),
    },
    (table) => ({
        pk: primaryKey({
            columns: [table.routeId, table.directionId, table.stopId],
            name: "pk_mbta_rail_route_stops",
        }),
    }),
);

export const mbtaFerryStations = pgTable("mbta_ferry_stations", {
    stopId: text("stop_id").primaryKey(),
    stopName: text("stop_name").notNull(),
    stopLat: numeric("stop_lat"),
    stopLon: numeric("stop_lon"),
    parentStation: text("parent_station"),
    childStopIdsJson: jsonb("child_stop_ids_json").$type<string[]>().notNull().default([]),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
});

export const mbtaFerryRoutes = pgTable("mbta_ferry_routes", {
    routeId: text("route_id").primaryKey(),
    agencyId: text("agency_id"),
    routeShortName: text("route_short_name").notNull().default(""),
    routeLongName: text("route_long_name").notNull().default(""),
    routeDesc: text("route_desc"),
    routeType: integer("route_type").notNull(),
    routeUrl: text("route_url"),
    routeColor: text("route_color"),
    routeTextColor: text("route_text_color"),
    routeSortOrder: integer("route_sort_order"),
    lineId: text("line_id"),
    importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
        .defaultNow()
        .notNull(),
});

export const mbtaFerryRouteStops = pgTable(
    "mbta_ferry_route_stops",
    {
        routeId: text("route_id").notNull(),
        directionId: integer("direction_id").notNull(),
        stopId: text("stop_id").notNull(),
        routeStopSortOrder: integer("route_stop_sort_order"),
        importedAt: timestamp("imported_at", { withTimezone: true, mode: "string" })
            .defaultNow()
            .notNull(),
    },
    (table) => ({
        pk: primaryKey({
            columns: [table.routeId, table.directionId, table.stopId],
            name: "pk_mbta_ferry_route_stops",
        }),
    }),
);
