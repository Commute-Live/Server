# commuteliveserver

Install Bun
https://github.com/oven-sh/bun?tab=readme-ov-file

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

This project was created using `bun init` in bun v1.3.8. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.

Initialize database
docker compuse up -d

Database Schema:

If on server:

set -a
source /opt/commute-live/app.env
set +a
bun run db:migrate

After local & server:
bun run db:migrate

MQTT (local server -> DigitalOcean broker):

Set these in `.env`:

```bash
MQTT_HOST=YOUR_DROPLET_IP_OR_DOMAIN
MQTT_PORT=1883
MQTT_USERNAME=YOUR_MQTT_USERNAME
MQTT_PASSWORD=YOUR_MQTT_PASSWORD
MQTT_PROTOCOL=mqtt
```

On `POST /device/:device_id/heartbeat`, the server publishes to:

`devices/:device_id/commands`

SERVER: View Database information
docker exec -it commutelive-postgres psql -U commute_live_user -d commutelive

List Tables: \dt
Describe Table: \d devices

View Logs:
journalctl -u commute-live -f
