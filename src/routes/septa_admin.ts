import type { Hono } from "hono";
import type { dependency } from "../types/dependency.d.ts";

// Placeholder registration keeps route wiring stable even when no SEPTA admin endpoints are exposed.
export function registerSeptaAdmin(_app: Hono, _deps: dependency) {}
