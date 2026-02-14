Philadelphia providers

- `philly-rail` - Regional Rail arrivals via `/Arrivals/index.php` (provider: `"philly-rail"`). Requires `stop` (station name or id), optional `direction` (`N`/`S`), optional `line`. Legacy alias: `septa-rail`.
- `philly-bus` - Bus/trolley arrivals via GTFS-RT TripUpdates (provider: `"philly-bus"`). Requires `line` (route id) and `stop` (stop_id), optional `direction`. Legacy alias: `septa-bus`.
