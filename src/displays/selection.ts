import type { DeviceConfig, DeviceDisplay, DisplayWeekday } from "../types.ts";

type DisplaySelectionInput = Omit<DeviceDisplay, "config"> & {
    config: DeviceConfig | null | undefined;
    timezone: string;
};

const WEEKDAY_INDEX: DisplayWeekday[] = [
    "sun",
    "mon",
    "tue",
    "wed",
    "thu",
    "fri",
    "sat",
];

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

const parseClockMinutes = (value: string | null | undefined) => {
    if (!value) return null;
    const match = TIME_RE.exec(value.trim());
    if (!match) return null;
    return Number(match[1]) * 60 + Number(match[2]);
};

const getLocalClock = (when: Date, timezone: string) => {
    const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: timezone || "UTC",
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    });
    const parts = formatter.formatToParts(when);
    const weekdayText =
        parts.find((part) => part.type === "weekday")?.value.toLowerCase().slice(0, 3) ?? "sun";
    const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
    const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
    const weekday = WEEKDAY_INDEX.includes(weekdayText as DisplayWeekday)
        ? (weekdayText as DisplayWeekday)
        : "sun";

    return {
        weekday,
        minutes: hour * 60 + minute,
    };
};

const dayMatches = (display: DisplaySelectionInput, weekday: DisplayWeekday) => {
    if (!display.scheduleDays.length) return true;
    return display.scheduleDays.includes(weekday);
};

const timeMatches = (display: DisplaySelectionInput, minutes: number) => {
    const start = parseClockMinutes(display.scheduleStart);
    const end = parseClockMinutes(display.scheduleEnd);

    if (start === null && end === null) return true;
    if (start !== null && end === null) return minutes >= start;
    if (start === null && end !== null) return minutes < end;
    if (start === end) return true;
    if (start! < end!) return minutes >= start! && minutes < end!;
    return minutes >= start! || minutes < end!;
};

export const isDisplayScheduledNow = (
    display: DisplaySelectionInput,
    when: Date = new Date(),
) => {
    if (display.paused) return false;

    const localClock = getLocalClock(when, display.timezone);
    return dayMatches(display, localClock.weekday) && timeMatches(display, localClock.minutes);
};

export const compareDisplayPriority = (
    left: Pick<DeviceDisplay, "priority" | "sortOrder" | "updatedAt" | "createdAt" | "displayId">,
    right: Pick<DeviceDisplay, "priority" | "sortOrder" | "updatedAt" | "createdAt" | "displayId">,
) => {
    if (left.priority !== right.priority) {
        return right.priority - left.priority;
    }
    if (left.sortOrder !== right.sortOrder) {
        return left.sortOrder - right.sortOrder;
    }
    const updatedCompare = right.updatedAt.localeCompare(left.updatedAt);
    if (updatedCompare !== 0) return updatedCompare;
    const createdCompare = left.createdAt.localeCompare(right.createdAt);
    if (createdCompare !== 0) return createdCompare;
    return left.displayId.localeCompare(right.displayId);
};

export const resolveActiveDisplay = (
    displays: DisplaySelectionInput[],
    when: Date = new Date(),
) => {
    const scheduled = displays.filter((display) => isDisplayScheduledNow(display, when));
    if (!scheduled.length) return null;
    return [...scheduled].sort(compareDisplayPriority)[0] ?? null;
};
