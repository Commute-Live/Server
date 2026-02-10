import { jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
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
