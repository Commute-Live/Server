import { logger } from "../logger.ts";
import { getRedisClient } from "../cache.ts";

type RateLimitInput = {
    key: string;
    limit: number;
    windowSeconds: number;
};

export type RateLimitResult =
    | {
          allowed: true;
          remaining: number;
          retryAfterSeconds: number;
      }
    | {
          allowed: false;
          remaining: 0;
          retryAfterSeconds: number;
      };

const PREFIX = "commutelive:ratelimit:";

export async function enforceRateLimit(input: RateLimitInput): Promise<RateLimitResult> {
    const client = await getRedisClient();
    const redisKey = `${PREFIX}${input.key}`;
    const total = await client.incr(redisKey);

    if (total === 1) {
        await client.expire(redisKey, input.windowSeconds);
    }

    const ttl = await client.ttl(redisKey);
    const retryAfterSeconds = ttl > 0 ? ttl : input.windowSeconds;

    if (total > input.limit) {
        logger.warn(
            {
                rateLimitKey: input.key,
                limit: input.limit,
                windowSeconds: input.windowSeconds,
            },
            "rate limit exceeded",
        );

        return {
            allowed: false,
            remaining: 0,
            retryAfterSeconds,
        };
    }

    return {
        allowed: true,
        remaining: Math.max(0, input.limit - total),
        retryAfterSeconds,
    };
}
