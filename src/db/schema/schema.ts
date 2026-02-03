import { jsonb, pgTable, uuid } from "drizzle-orm/pg-core";

export const devices = pgTable("devices", {
    deviceId: uuid("device_id").primaryKey().defaultRandom(),
    config: jsonb("config").notNull(),
});
