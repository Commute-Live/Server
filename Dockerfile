FROM oven/bun:1.3.8 AS installer
FROM oven/bun:1.3.8 AS installer

WORKDIR /app

RUN apt-get update && apt-get install -y unzip && rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.8-slim

WORKDIR /app

COPY --from=installer /app/node_modules ./node_modules
COPY src ./src
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.8-slim

WORKDIR /app

COPY --from=installer /app/node_modules ./node_modules
COPY src ./src
COPY package.json bun.lock drizzle.config.ts ./

EXPOSE 8080

CMD ["bun", "run", "src/index.ts"]
