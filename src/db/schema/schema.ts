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
