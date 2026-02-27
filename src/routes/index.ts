import type { Hono } from "hono";
import type { dependency } from "../types/dependency.d.ts";
import { registerRoot } from "./root.ts";
import { registerHealth } from "./health.ts";
import { registerDevice } from "./device.ts";
import { registerAuth } from "./auth.ts";
import { registerRefresh } from "./refresh.ts";
import { registerConfig } from "./config.ts";
import { registerStops } from "./stops.ts";
import { registerDbAdmin } from "./db_admin.ts";
import { registerMqttAdmin } from "./mqtt_admin.ts";
import { registerSeptaAdmin } from "./septa_admin.ts";
import { registerSeptaRoutes } from "./septa.ts";
import { registerMtaRoutes } from "./mta.ts";
import { registerMbtaRoutes } from "./mbta.ts";
import { registerCtaRoutes } from "./cta.ts";

export function registerRoutes(app: Hono, deps: dependency) {
    registerRoot(app);
    registerHealth(app, deps);
    registerDevice(app, deps);
    registerAuth(app, deps);
    registerRefresh(app, deps);
    registerConfig(app, deps);
    registerStops(app, deps);
    registerDbAdmin(app, deps);
    registerMqttAdmin(app);
    registerSeptaAdmin(app, deps);
    registerSeptaRoutes(app, deps);
    registerMtaRoutes(app, deps);
    registerMbtaRoutes(app, deps);
    registerCtaRoutes(app, deps);
}
