import type { DeviceConfig, LineConfig } from "../types.ts";

export const DEFAULT_BRIGHTNESS = 60;
export const DEFAULT_DISPLAY_TYPE = 1;
export const DEFAULT_SCROLLING = false;
export const DEFAULT_ARRIVALS_TO_DISPLAY = 1;

export const SUPPORTED_PROVIDERS = new Set([
    "mta-subway",
    "mta-bus",
    "mta-lirr",
    "mta-mnr",
    "mbta",
    "cta-subway",
    "cta-bus",
    "septa-rail",
    "septa-bus",
]);

const toTrimmedString = (value: unknown) => {
    if (typeof value !== "string") return undefined;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
};

const toNumber = (value: unknown) => {
    if (typeof value === "number" && !Number.isNaN(value)) return value;
    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value);
        if (!Number.isNaN(parsed)) return parsed;
    }
    return undefined;
};

const toBoolean = (value: unknown) => {
    if (typeof value === "boolean") return value;
    return undefined;
};

export const normalizeArrivalsToDisplay = (value: unknown) => {
    const numeric = toNumber(value);
    if (numeric === undefined) return DEFAULT_ARRIVALS_TO_DISPLAY;
    if (numeric < 1) return 1;
    if (numeric > 3) return 3;
    return Math.trunc(numeric);
};

const coerceArrivalsToDisplay = (value: unknown) => {
    const numeric = toNumber(value);
    if (numeric === undefined) return undefined;
    if (numeric < 1) return 1;
    if (numeric > 3) return 3;
    return Math.trunc(numeric);
};

export const normalizeLineConfig = (value: unknown): LineConfig | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;

    const candidate = value as Record<string, unknown>;
    const provider = toTrimmedString(candidate.provider)?.toLowerCase();
    const line = toTrimmedString(candidate.line);

    if (!provider || !line) return null;

    const normalized: Record<string, unknown> = { ...candidate, provider, line };

    const stop = toTrimmedString(candidate.stop);
    if (stop !== undefined) {
        normalized.stop = stop;
    } else {
        delete normalized.stop;
    }

    const direction = toTrimmedString(candidate.direction);
    if (direction !== undefined) {
        normalized.direction = direction;
    } else {
        delete normalized.direction;
    }

    const displayType = toNumber(candidate.displayType);
    if (displayType !== undefined) {
        normalized.displayType = Math.trunc(displayType);
    } else {
        delete normalized.displayType;
    }

    const scrolling = toBoolean(candidate.scrolling);
    if (scrolling !== undefined) {
        normalized.scrolling = scrolling;
    } else {
        delete normalized.scrolling;
    }

    return normalized as LineConfig;
};

export const validateLineConfigs = (lines: unknown): lines is LineConfig[] => {
    if (!Array.isArray(lines)) return false;

    return lines.every((item) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return false;
        const candidate = item as Record<string, unknown>;
        if (typeof candidate.provider !== "string") return false;
        if (typeof candidate.line !== "string") return false;
        if (candidate.stop !== undefined && typeof candidate.stop !== "string") return false;
        if (candidate.direction !== undefined && typeof candidate.direction !== "string") return false;
        if (candidate.displayType !== undefined && typeof candidate.displayType !== "number") return false;
        if (candidate.scrolling !== undefined && typeof candidate.scrolling !== "boolean") return false;
        return true;
    });
};

const normalizeLineArray = (value: unknown) => {
    if (!Array.isArray(value)) return [];
    return value.map((item) => normalizeLineConfig(item)).filter((item): item is LineConfig => item !== null);
};

const coerceBrightness = (value: unknown) => {
    const numeric = toNumber(value);
    if (numeric === undefined) return undefined;
    return Math.max(0, Math.min(100, Math.round(numeric)));
};

const coerceDisplayType = (value: unknown) => {
    const numeric = toNumber(value);
    if (numeric === undefined) return undefined;
    return Math.trunc(numeric);
};

const coerceScrolling = (value: unknown) => {
    const booleanValue = toBoolean(value);
    if (booleanValue !== undefined) return booleanValue;
    return undefined;
};

const normalizeConfigPatch = (body: unknown) => {
    if (!body || typeof body !== "object" || Array.isArray(body)) return null;

    const raw = body as Record<string, unknown>;
    const { config, deviceId, device_id, userId, user_id, ...rest } = raw;

    if (config && typeof config === "object" && !Array.isArray(config)) {
        const {
            deviceId: nestedDeviceId,
            device_id: nestedDeviceIdLegacy,
            userId: nestedUserId,
            user_id: nestedUserIdLegacy,
            ...nestedRest
        } = config as Record<string, unknown>;
        return {
            ...rest,
            ...nestedRest,
        };
    }

    return {
        ...rest,
    };
};

export const extractDeviceConfigPatch = (body: unknown) => normalizeConfigPatch(body);

export const normalizeDeviceConfig = (
    existing: DeviceConfig | null | undefined,
    updates: Record<string, unknown> = {},
): DeviceConfig => {
    const current = (existing ?? {}) as Record<string, unknown>;
    const hasBrightness = Object.prototype.hasOwnProperty.call(updates, "brightness");
    const hasDisplayType = Object.prototype.hasOwnProperty.call(updates, "displayType");
    const hasScrolling = Object.prototype.hasOwnProperty.call(updates, "scrolling");
    const hasArrivalsToDisplay = Object.prototype.hasOwnProperty.call(updates, "arrivalsToDisplay");

    const brightness =
        coerceBrightness(hasBrightness ? updates.brightness : current.brightness) ??
        coerceBrightness(current.brightness) ??
        DEFAULT_BRIGHTNESS;
    const displayType =
        coerceDisplayType(hasDisplayType ? updates.displayType : current.displayType) ??
        coerceDisplayType(current.displayType) ??
        DEFAULT_DISPLAY_TYPE;
    const scrolling =
        coerceScrolling(hasScrolling ? updates.scrolling : current.scrolling) ??
        coerceScrolling(current.scrolling) ??
        DEFAULT_SCROLLING;
    const arrivalsToDisplay =
        coerceArrivalsToDisplay(hasArrivalsToDisplay ? updates.arrivalsToDisplay : current.arrivalsToDisplay) ??
        coerceArrivalsToDisplay(current.arrivalsToDisplay) ??
        DEFAULT_ARRIVALS_TO_DISPLAY;
    const linesSource =
        Object.prototype.hasOwnProperty.call(updates, "lines") ? updates.lines : current.lines;

    return {
        ...current,
        ...updates,
        ...(brightness !== undefined ? { brightness } : {}),
        ...(displayType !== undefined ? { displayType } : {}),
        ...(scrolling !== undefined ? { scrolling } : {}),
        arrivalsToDisplay,
        lines: normalizeLineArray(linesSource),
    };
};
