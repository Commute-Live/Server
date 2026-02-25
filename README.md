# commuteliveserver

## Run Everything With Docker (One Command)

1. Create env file:

```bash
cp .env.example .env
```

2. Set production secrets in `.env` (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, DB creds, MQTT creds, `DD_API_KEY`).
3. Start all services:

```bash
docker compose --profile datadog up --build -d
```

This runs:
- Datadog Agent (`datadog-agent` service, container `dd-agent`)
- Bun API (`commutelive-api`)
- Postgres (`commutelive-postgres`)
- Redis (`redis`)
- Mosquitto (`commutelive-mosquitto`)

Redis uses a named Docker volume (`redis_data`) so cached data persists across container recreates and deploys.

The API container runs DB migrations on startup (`bun run db:migrate`) before starting the server.

## MQTT Logs To Datadog

To send the same MQTT activity shown in `/admin/mqtt` to Datadog logs:

1. Enable structured MQTT log output in `.env`:

```bash
MQTT_DEBUG_LOG_STDOUT=true
```

2. Redeploy API:

```bash
./deploy.sh
```

3. Ensure `DD_API_KEY` is set in `.env` so the compose-managed Datadog Agent can forward logs.

Each event is emitted as JSON with `message: "mqtt_debug_event"` and includes:
- `mqtt.direction` (`incoming`, `outgoing`, `state`, `error`)
- `mqtt.topic`
- `mqtt.payloadPreview`
- `mqtt.detail`

In Datadog Logs, filter with:

```text
service:commutelive-api @message:mqtt_debug_event
```

## Datadog Autodiscovery For Integrations

`docker-compose.yml` now includes Datadog Autodiscovery labels for:
- Postgres (`postgres` check)
- Redis (`redisdb` check)
- Mosquitto (`tcp_check` on port `1883`)
- API (`http_check` on `/health`)
- Nginx (`nginx` check via `/nginx_status`)

It also sets Datadog service tags per container (`com.datadoghq.tags.service`) so telemetry is grouped under:
- `commutelive-api`
- `commutelive-postgres`
- `commutelive-redis`
- `commutelive-mosquitto`
- `commutelive-nginx`

## Datadog IDP Service Catalog Definitions

Service definition files are provided in:

```text
datadog/service-definitions/*.datadog.yaml
```

Import those definitions into Datadog Software Catalog (IDP) using your preferred source (Git import or file upload).

If your Datadog organization uses specific team slugs, update the `team` field in each file before importing.

Requirements:
- `DD_API_KEY` is set in `.env` (and optional `DD_SITE`, default `us5.datadoghq.com`).
- Datadog Agent container is running (`datadog-agent` service / `dd-agent` container).
- Shared socket path `/var/run/datadog` is mounted for APM/DogStatsD.
- Agent can reach container network addresses for `%%host%%`.

If you already run a host-level or shared Datadog Agent, start without the `datadog` profile so this stack does not launch another Agent.

For staging, point the API service at a different env file:

```bash
APP_ENV_FILE=.env.staging docker compose --env-file .env.staging -p commutelive-staging up -d --build
```

## API Routes

### Auth
| Method | Path | Notes |
|--------|------|-------|
| `POST` | `/device/register` | Register a new device |
| `POST` | `/user/register` | Register a new user |
| `POST` | `/user/device/link` | Link a device to a user (auth required) |
| `POST` | `/auth/login` | Login, receive access + refresh tokens |
| `POST` | `/user/login` | Alias for `/auth/login` |
| `POST` | `/auth/refresh` | Refresh access token |
| `POST` | `/auth/logout` | Revoke refresh token |
| `GET` | `/auth/me` | Get current user (auth required) |

### Devices & Config
| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/device/:device_id` | Get device by ID |
| `GET` | `/device/:device_id/last-command` | Get latest MQTT command for device (auth required) |
| `GET` | `/device/:deviceId/config` | Get device config (heartbeat endpoint) |
| `POST` | `/device/:deviceId/config` | Update device config (auth required) |

### Transit Data
| Method | Path | Notes |
|--------|------|-------|
| `POST` | `/refresh/device/:deviceId` | Force-refresh transit data for a device (auth required) |
| `POST` | `/refresh/key` | Force-refresh transit data for a cache key (auth required) |

### Stops & Routes
| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/stops` | List all stops |
| `GET` | `/stops/:stopId/lines` | Get lines for a stop |
| `GET` | `/providers/new-york/stops/subway` | Search NYC subway stops |
| `GET` | `/providers/new-york/stops/bus` | Search NYC bus stops |
| `GET` | `/providers/new-york/routes/bus` | List NYC bus routes |
| `GET` | `/providers/chicago/stops/subway` | List Chicago subway stops |
| `GET` | `/providers/chicago/stops/:stopId/lines` | Get lines for a Chicago stop |
| `GET` | `/providers/chicago/routes/subway` | List Chicago subway routes |
| `GET` | `/providers/boston/stops/subway` | List Boston subway stops |
| `GET` | `/providers/boston/stops/bus` | List Boston bus stops |
| `GET` | `/providers/philly/stops/rail` | List Philly rail stops |
| `GET` | `/providers/philly/stops/train` | Alias for `/providers/philly/stops/rail` |
| `GET` | `/providers/philly/stops/bus` | List Philly bus stops |
| `GET` | `/providers/philly/stops/rail/:stopId/lines` | Get lines for a Philly rail stop |
| `GET` | `/providers/philly/stops/train/:stopId/lines` | Alias for rail lines |
| `GET` | `/providers/philly/stops/bus/:stopId/lines` | Get lines for a Philly bus stop |
| `GET` | `/providers/philly/routes/rail` | List Philly rail routes |
| `GET` | `/providers/philly/routes/train` | Alias for `/providers/philly/routes/rail` |
| `GET` | `/providers/philly/routes/bus` | List Philly bus routes |
| `GET` | `/providers/philly/debug/arrivals` | Debug arrivals data for Philly |

### Admin
| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/admin/db` | Database browser UI (basic auth) |
| `GET` | `/admin/mqtt` | MQTT monitor UI (basic auth) |
| `GET` | `/admin/mqtt/events` | Live MQTT event stream (SSE) |

### System
| Method | Path | Notes |
|--------|------|-------|
| `GET` | `/` | Root |
| `GET` | `/health` | Health check |

## Useful Commands

```bash
docker compose logs -f
docker compose down
docker compose down -v
```

```bash
docker exec -it commutelive-postgres psql -U commute -d commutelive
```

Great!