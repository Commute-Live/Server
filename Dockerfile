FROM oven/bun:1.3.8 AS installer

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production

FROM oven/bun:1.3.8-slim

WORKDIR /app

COPY --from=installer /app/node_modules ./node_modules
COPY src ./src
COPY package.json bun.lock ./

EXPOSE 8080

CMD ["bun", "run", "src/index.ts"]
