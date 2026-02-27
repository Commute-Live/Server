# API Endpoints

Simple list of mode-based transit APIs.

## MTA
- `GET /mta/stations?mode=subway|bus|lirr|mnr&q=<optional>&limit=<optional>`
- `GET /mta/stations/:mode/lines`
- `GET /mta/stations/:mode/:stopId/lines`
- `GET /mta/stations/:mode/:stopId/arrivals?line_ids=<required>&direction=<optional>&limit_per_line=<optional>`

## CTA
- `GET /cta/stations?mode=subway|bus&q=<optional>&limit=<optional>`
- `GET /cta/stations/:mode/lines`
- `GET /cta/stations/:mode/:stopId/lines`
- `GET /cta/stations/:mode/:stopId/arrivals?line_ids=<required>&direction=<optional>&limit_per_line=<optional>`

## MBTA
- `GET /mbta/stations?mode=subway|bus|rail|ferry&q=<optional>&limit=<optional>`
- `GET /mbta/stations/:mode/lines`
- `GET /mbta/stations/:mode/:stopId/lines`
- `GET /mbta/stations/:mode/:stopId/arrivals?line_ids=<required>&direction=<optional>&limit_per_line=<optional>`

## SEPTA
- `GET /septa/stations?mode=rail|bus|trolley&q=<optional>&limit=<optional>`
- `GET /septa/stations/:mode/lines`
- `GET /septa/stations/:mode/:stopId/lines`
- `GET /septa/stations/:mode/:stopId/arrivals?line_ids=<required>&direction=<optional>&limit_per_line=<optional>`

## Bay Area
- `GET /bayarea/stations?operator_id=<required>&mode=bus|tram|cableway&q=<optional>&limit=<optional>`
- `GET /bayarea/stations/:mode/lines?operator_id=<required>`
- `GET /bayarea/stations/:mode/:stopId/lines?operator_id=<required>`
- `GET /bayarea/stations/:mode/:stopId/arrivals?operator_id=<required>&line_ids=<required>&direction=<optional>&limit_per_line=<optional>`
