# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

CommuteLive Server is a real-time transit information aggregator that fetches arrival data from multiple transit authorities (CTA, MTA, MBTA, SEPTA), caches it in Redis, and pushes updates to hardware display devices via MQTT.

## Tech Stack

- **Runtime**: Bun 1.3.8 (TypeScript, runs .ts directly — no build step)
- **Framework**: Hono (HTTP)
- **Database**: PostgreSQL 16 + Drizzle ORM
- **Cache**: Redis 7
- **Messaging**: MQTT (Eclipse Mosquitto 2)
- **Auth**: JWT with refresh token rotation
- **Observability**: Datadog (dd-trace)
- **Formatting**: Prettier (4-space indent, 2-space for YAML)

## Common Commands

```bash
bun run dev                # Start dev server with hot reload
bun run db:generate        # Generate Drizzle migrations after schema changes
bun run db:migrate         # Run pending migrations
bun run db:studio          # Open Drizzle Studio (DB browser)
docker compose up -d       # Start all services (postgres, redis, mosquitto, api, nginx)
docker compose --profile datadog up -d  # Include Datadog agent
```

## Architecture

### Core Loop

```
Devices → HTTP API → Aggregator Engine → Provider Plugins → Transit APIs
                                              ↓
                                         Redis Cache
                                              ↓
                                    MQTT → Devices (push)
```

The **Aggregator Engine** (`src/engine.ts`) is the central orchestrator:
- Maintains a fanout map of cache keys → device IDs
- **Refresh loop** (1s): checks cache expiry, fetches stale data from providers
- **Push loop** (30s): publishes device payloads via MQTT
- Deduplicates in-flight requests

### Provider Plugin System

Each transit authority in `src/providers/` implements the `ProviderPlugin` interface (`src/types.ts`):
- `supports(sub)` — can this provider handle this subscription?
- `toKey(sub)` — normalize subscription to a cache key
- `parseKey(key)` — reverse a cache key to fetch params
- `fetch(key)` — call the transit API and return arrival data

Key format: `providerId:type:param1=val1;param2=val2`

Providers are registered in `src/providers/register.ts`.

### Database Schema

Defined in `src/db/schema/schema.ts` using Drizzle:
- `devices` — hardware units with display config and line subscriptions (JSONB)
- `users` — accounts with hashed passwords
- `userDevices` — links users to devices (many-to-one)
- `authRefreshSessions` — refresh token tracking for rotation/revocation

### Auth Flow

JWT access + refresh tokens with secure cookie transport. Refresh token rotation with family-based revocation (`src/auth/`).

### Route Structure

Routes registered in `src/routes/index.ts`. Key endpoints:
- `/device/register`, `/user/register`, `/user/login` — onboarding
- `/device/:device_id/heartbeat`, `/device/:device_id/config` — device management
- `/refresh/:device_id` — manual transit data refresh
- `/stops/:provider/:line` — stop search
- `/admin/db`, `/admin/mqtt` — admin UIs (basic auth)

## Environment

Copy `.env.example` for required variables. Key groups: database connection, JWT secrets, MQTT credentials, Redis URL, admin credentials, Datadog keys.

## Deployment

Push to `main` triggers GitHub Actions → SSH into server → runs `deploy.sh` (git pull + docker compose rebuild).
