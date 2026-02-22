import tracer from "./tracer.ts";

const PREFIX = "commutelive.";

export const metrics = {
    increment(name: string, tags?: string[]) {
        tracer.dogstatsd.increment(`${PREFIX}${name}`, 1, tags);
    },
    gauge(name: string, value: number, tags?: string[]) {
        tracer.dogstatsd.gauge(`${PREFIX}${name}`, value, tags);
    },
    histogram(name: string, value: number, tags?: string[]) {
        tracer.dogstatsd.histogram(`${PREFIX}${name}`, value, tags);
    },
};
