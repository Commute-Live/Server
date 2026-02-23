// logger.ts must be imported after tracer.ts so that dd-trace can patch pino
// before any log records are written. index.ts guarantees this ordering.
import pino from "pino";

export const logger = pino({
    level: process.env.LOG_LEVEL ?? "info",
    messageKey: "message",
    formatters: {
        level(label) {
            return { level: label };
        },
    },
    serializers: {
        err: pino.stdSerializers.err,
    },
    base: {
        service: process.env.DD_SERVICE ?? "commutelive-api",
        env: process.env.DD_ENV ?? process.env.NODE_ENV ?? "unknown",
        version: process.env.DD_VERSION ?? "unknown",
    },
});
