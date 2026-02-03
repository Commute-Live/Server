import { jsonb, pgTable, text, uuid } from "drizzle-orm/pg-core";

export const devices = pgTable("devices", {
    deviceId: uuid("device_id").primaryKey().defaultRandom(),
    deviceName: text("device_name").notNull(),
    config: jsonb("config").notNull(),
});
