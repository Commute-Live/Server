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

## Useful Commands

```bash
docker compose logs -f
docker compose down
docker compose down -v
```

```bash
docker exec -it commutelive-postgres psql -U commute -d commutelive
```
t! - Final test
a
