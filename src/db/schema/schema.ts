import { jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

// Devices: physical hardware unit
export const devices = pgTable("devices", {
    id: text("id").primaryKey(),
    timezone: text("timezone").notNull().default("UTC"),
    preferences: jsonb("preferences").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
});

// Users: one per device
export const users = pgTable(
    "users",
    {
        id: uuid("id").primaryKey().defaultRandom(),
        email: text("email").notNull(),
        passwordHash: text("password_hash").notNull(),
        deviceId: text("device_id")
            .notNull()
            .references(() => devices.id, { onDelete: "cascade" }),
        createdAt: timestamp("created_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
        updatedAt: timestamp("updated_at", { withTimezone: true, mode: "string" }).defaultNow().notNull(),
    },
    (table) => ({
        emailIdx: uniqueIndex("idx_users_email").on(table.email),
        deviceIdIdx: uniqueIndex("idx_users_device_id").on(table.deviceId),
    })
);
