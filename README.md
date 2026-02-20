# commuteliveserver

## Run Everything With Docker (One Command)

1. Create env file:

```bash
cp .env.example .env
```

2. Set production secrets in `.env` (`JWT_ACCESS_SECRET`, `JWT_REFRESH_SECRET`, DB creds, MQTT creds).
3. Start all services:

```bash
docker compose up --build -d
```

This runs:
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

3. Ensure your external Datadog Agent is collecting Docker container logs (`logs_enabled: true` and container collection enabled).

Each event is emitted as JSON with `message: "mqtt_debug_event"` and includes:
- `mqtt.direction` (`incoming`, `outgoing`, `state`, `error`)
- `mqtt.topic`
- `mqtt.payloadPreview`
- `mqtt.detail`

In Datadog Logs, filter with:

```text
service:commutelive-api @message:mqtt_debug_event
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
