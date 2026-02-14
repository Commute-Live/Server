Philadelphia (SEPTA) providers

- `septa-rail` — Regional Rail arrivals via `/Arrivals/index.php` (provider: `"septa-rail"`). Requires `stop` (station name or id), optional `direction` (`N`/`S`), optional `line`.
- `septa-bus` — Bus/trolley arrivals via GTFS-RT TripUpdates (provider: `"septa-bus"`). Requires `line` (route id) and `stop` (stop_id), optional `direction`.
