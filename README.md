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
- Mosquitto (`commutelive-mosquitto`)

The API container runs DB migrations on startup (`bun run db:migrate`) before starting the server.

## Useful Commands

```bash
docker compose logs -f
docker compose down
docker compose down -v
```

```bash
docker exec -it commutelive-postgres psql -U commute -d commutelive
```
