import type { Subscription } from "./types.ts";

const mockSubscriptions: Subscription[] = [
    {
        deviceId: "device-a",
        provider: "mta",
        type: "arrivals",
        config: { line: "7", stop: "725N", direction: "N" },
    },
    {
        deviceId: "device-b",
        provider: "mta",
        type: "arrivals",
        config: { line: "7", stop: "725N", direction: "N" },
    },
    {
        deviceId: "device-d",
        provider: "mta-bus",
        type: "arrivals",
        config: { stop: "403150", line: "M104", direction: "1" },
    },
];

export async function loadSubscriptions(): Promise<Subscription[]> {
    // Simulate asynchronous DB access
    return mockSubscriptions;
}
