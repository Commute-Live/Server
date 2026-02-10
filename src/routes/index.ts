import type { Hono } from "hono";
import type { dependency } from "../types/dependency.d.ts";
import { registerRoot } from "./root.ts";
import { registerHealth } from "./health.ts";
import { registerDevice } from "./device.ts";
import { registerAuth } from "./auth.ts";
import { registerRefresh } from "./refresh.ts";

export function registerRoutes(app: Hono, deps: dependency) {
    registerRoot(app);
    registerHealth(app, deps);
    registerDevice(app, deps);
    registerAuth(app, deps);
    registerRefresh(app, deps);
}
