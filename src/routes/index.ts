import type { Hono } from "hono";
import { registerRoot } from "./root.ts";
import { registerHealth } from "./health.ts";
import type { dependency } from "../types/dependency.d.ts";

export function registerRoutes(app: Hono, deps: dependency) {
    registerRoot(app);
    registerHealth(app, deps);
}
