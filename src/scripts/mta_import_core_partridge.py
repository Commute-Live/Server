#!/usr/bin/env python3
import gc
import json
import os
import sys
import time
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Set, Tuple

import pandas as pd
import partridge as ptg
import psycopg2
from psycopg2.extras import Json, execute_values

REQUIRED_CORE_FILES = ("stops.txt", "routes.txt", "trips.txt", "stop_times.txt")
INSERT_PAGE_SIZE = 1000

MODE_DEFAULT_ROUTE_TYPE = {
    "subway": 1,
    "bus": 3,
    "lirr": 2,
    "mnr": 2,
}


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def log(message: str) -> None:
    print(f"[mta-import-py] {now_iso()} {message}", flush=True)


def elapsed_seconds(started_at: float) -> str:
    return f"{time.time() - started_at:.1f}s"


def normalize_text(value: Any) -> str:
    if value is None:
        return ""
    if pd.isna(value):
        return ""
    return str(value).strip()


def normalize_optional_text(value: Any) -> Optional[str]:
    normalized = normalize_text(value)
    return normalized or None


def normalize_route_id(value: Any) -> str:
    return normalize_text(value).upper()


def parse_int_or_none(value: Any) -> Optional[int]:
    normalized = normalize_text(value)
    if not normalized:
        return None
    try:
        return int(float(normalized))
    except ValueError:
        return None


def parse_direction_id(value: Any) -> int:
    raw = normalize_text(value).upper()
    if not raw:
        return 0
    if raw == "N":
        return 0
    if raw == "S":
        return 1
    parsed = parse_int_or_none(raw)
    if parsed in (0, 1):
        return int(parsed)
    return 0


def parse_numeric_or_none(value: Any) -> Optional[str]:
    normalized = normalize_text(value)
    if not normalized:
        return None
    try:
        float(normalized)
        return normalized
    except ValueError:
        return None


def has_required_core_files(path: Path) -> bool:
    return all((path / file_name).is_file() for file_name in REQUIRED_CORE_FILES)


def collect_dataset_dirs(root: Path) -> List[Path]:
    resolved = root.resolve()
    if has_required_core_files(resolved):
        return [resolved]

    out: List[Path] = []
    queue: List[Path] = [resolved]
    while queue:
        current = queue.pop(0)
        if not current.exists():
            continue

        try:
            entries = list(current.iterdir())
        except OSError:
            continue

        for entry in entries:
            if not entry.is_dir():
                continue
            if has_required_core_files(entry):
                out.append(entry)
            else:
                queue.append(entry)

    deduped = sorted({path.resolve() for path in out}, key=lambda path: str(path))
    return deduped


def resolve_single_dataset_dir(root: Path, mode: str) -> Path:
    dirs = collect_dataset_dirs(root)
    if not dirs:
        raise RuntimeError(f"Missing GTFS dataset for mode {mode}: {root}")
    if len(dirs) > 1:
        raise RuntimeError(f"Expected one GTFS dataset for mode {mode}, found {len(dirs)} under {root}")
    return dirs[0]


def require_columns(df: pd.DataFrame, required: Iterable[str], context: str) -> None:
    missing = [column for column in required if column not in df.columns]
    if missing:
        raise RuntimeError(f"Missing required columns in {context}: {', '.join(missing)}")


def process_mode(mode: str, dataset_dirs: List[Path], label: str) -> Dict[str, Any]:
    mode_started_at = time.time()
    log(f"{label}: parsing {len(dataset_dirs)} dataset(s)")

    station_map: Dict[str, Dict[str, Any]] = {}
    route_map: Dict[str, Dict[str, Any]] = {}
    route_stop_map: Dict[Tuple[str, int, str], Optional[int]] = {}

    missing_trip_refs = 0
    missing_stop_ids: Set[str] = set()

    for dataset_dir in dataset_dirs:
        dataset_started_at = time.time()
        feed = ptg.load_feed(str(dataset_dir), view={})

        stops_df = feed.stops
        routes_df = feed.routes
        trips_df = feed.trips
        stop_times_df = feed.stop_times

        require_columns(stops_df, ("stop_id", "stop_name"), f"{dataset_dir}/stops.txt")
        require_columns(routes_df, ("route_id",), f"{dataset_dir}/routes.txt")
        require_columns(trips_df, ("trip_id", "route_id"), f"{dataset_dir}/trips.txt")
        require_columns(stop_times_df, ("trip_id", "stop_id"), f"{dataset_dir}/stop_times.txt")

        for optional in ("stop_lat", "stop_lon", "parent_station"):
            if optional not in stops_df.columns:
                stops_df[optional] = None
        for optional in (
            "agency_id",
            "route_short_name",
            "route_long_name",
            "route_desc",
            "route_type",
            "route_url",
            "route_color",
            "route_text_color",
            "route_sort_order",
        ):
            if optional not in routes_df.columns:
                routes_df[optional] = None
        if "direction_id" not in trips_df.columns:
            trips_df["direction_id"] = None
        if "stop_sequence" not in stop_times_df.columns:
            stop_times_df["stop_sequence"] = None

        raw_stop_to_station: Dict[str, str] = {}

        stops_rows_parsed = 0
        routes_rows_parsed = 0
        trips_rows_parsed = 0
        stop_times_rows_parsed = 0

        for stop_id, stop_name, stop_lat, stop_lon, parent_station in stops_df[
            ["stop_id", "stop_name", "stop_lat", "stop_lon", "parent_station"]
        ].itertuples(index=False, name=None):
            stops_rows_parsed += 1

            raw_stop_id = normalize_text(stop_id)
            if not raw_stop_id:
                continue
            normalized_name = normalize_text(stop_name) or raw_stop_id
            normalized_parent = normalize_text(parent_station)

            station_id = raw_stop_id if mode == "bus" else (normalized_parent or raw_stop_id)
            raw_stop_to_station[raw_stop_id] = station_id

            station = station_map.get(station_id)
            if station is None:
                station = {
                    "stop_id": station_id,
                    "stop_name": normalized_name,
                    "stop_lat": parse_numeric_or_none(stop_lat),
                    "stop_lon": parse_numeric_or_none(stop_lon),
                    "parent_station": normalized_parent or None,
                    "child_stop_ids": set(),
                }
                station_map[station_id] = station
            else:
                if not station["stop_name"] or station["stop_name"] == station["stop_id"]:
                    station["stop_name"] = normalized_name
                if station["stop_lat"] is None:
                    station["stop_lat"] = parse_numeric_or_none(stop_lat)
                if station["stop_lon"] is None:
                    station["stop_lon"] = parse_numeric_or_none(stop_lon)

            if mode != "bus":
                station["child_stop_ids"].add(raw_stop_id)

        for (
            route_id,
            agency_id,
            route_short_name,
            route_long_name,
            route_desc,
            route_type,
            route_url,
            route_color,
            route_text_color,
            route_sort_order,
        ) in routes_df[
            [
                "route_id",
                "agency_id",
                "route_short_name",
                "route_long_name",
                "route_desc",
                "route_type",
                "route_url",
                "route_color",
                "route_text_color",
                "route_sort_order",
            ]
        ].itertuples(index=False, name=None):
            routes_rows_parsed += 1

            normalized_route_id = normalize_route_id(route_id)
            if not normalized_route_id:
                continue

            incoming = {
                "route_id": normalized_route_id,
                "agency_id": normalize_optional_text(agency_id),
                "route_short_name": normalize_text(route_short_name),
                "route_long_name": normalize_text(route_long_name),
                "route_desc": normalize_optional_text(route_desc),
                "route_type": parse_int_or_none(route_type) or MODE_DEFAULT_ROUTE_TYPE[mode],
                "route_url": normalize_optional_text(route_url),
                "route_color": normalize_optional_text(route_color),
                "route_text_color": normalize_optional_text(route_text_color),
                "route_sort_order": parse_int_or_none(route_sort_order),
            }

            existing = route_map.get(normalized_route_id)
            if existing is None:
                route_map[normalized_route_id] = incoming
            else:
                if not existing["agency_id"] and incoming["agency_id"]:
                    existing["agency_id"] = incoming["agency_id"]
                if not existing["route_short_name"] and incoming["route_short_name"]:
                    existing["route_short_name"] = incoming["route_short_name"]
                if not existing["route_long_name"] and incoming["route_long_name"]:
                    existing["route_long_name"] = incoming["route_long_name"]
                if not existing["route_desc"] and incoming["route_desc"]:
                    existing["route_desc"] = incoming["route_desc"]
                if existing["route_type"] == MODE_DEFAULT_ROUTE_TYPE[mode] and incoming["route_type"] != MODE_DEFAULT_ROUTE_TYPE[mode]:
                    existing["route_type"] = incoming["route_type"]
                if not existing["route_url"] and incoming["route_url"]:
                    existing["route_url"] = incoming["route_url"]
                if not existing["route_color"] and incoming["route_color"]:
                    existing["route_color"] = incoming["route_color"]
                if not existing["route_text_color"] and incoming["route_text_color"]:
                    existing["route_text_color"] = incoming["route_text_color"]
                if existing["route_sort_order"] is None and incoming["route_sort_order"] is not None:
                    existing["route_sort_order"] = incoming["route_sort_order"]

        trip_map: Dict[str, Tuple[str, int]] = {}
        for trip_id, route_id, direction_id in trips_df[["trip_id", "route_id", "direction_id"]].itertuples(
            index=False, name=None
        ):
            trips_rows_parsed += 1
            normalized_trip_id = normalize_text(trip_id)
            normalized_route_id = normalize_route_id(route_id)
            if not normalized_trip_id or not normalized_route_id:
                continue
            trip_map[normalized_trip_id] = (normalized_route_id, parse_direction_id(direction_id))

        for trip_id, stop_id, stop_sequence in stop_times_df[["trip_id", "stop_id", "stop_sequence"]].itertuples(
            index=False, name=None
        ):
            stop_times_rows_parsed += 1
            if stop_times_rows_parsed % 500000 == 0:
                log(f"{label}: processed stop_times rows={stop_times_rows_parsed}")

            normalized_trip_id = normalize_text(trip_id)
            raw_stop_id = normalize_text(stop_id)
            if not normalized_trip_id or not raw_stop_id:
                continue

            trip_lookup = trip_map.get(normalized_trip_id)
            if trip_lookup is None:
                missing_trip_refs += 1
                continue
            route_id_value, direction_id_value = trip_lookup

            station_stop_id = raw_stop_to_station.get(raw_stop_id, raw_stop_id)
            if station_stop_id not in station_map:
                missing_stop_ids.add(raw_stop_id)
                continue

            route_stop_key = (route_id_value, direction_id_value, station_stop_id)
            next_sequence = parse_int_or_none(stop_sequence)
            existing_sequence = route_stop_map.get(route_stop_key)
            if existing_sequence is None:
                route_stop_map[route_stop_key] = next_sequence
            elif next_sequence is not None and next_sequence < existing_sequence:
                route_stop_map[route_stop_key] = next_sequence

        log(
            f"{label}: processed {dataset_dir} in {elapsed_seconds(dataset_started_at)} "
            f"(rows stops={stops_rows_parsed}, routes={routes_rows_parsed}, trips={trips_rows_parsed}, stop_times={stop_times_rows_parsed})"
        )

        del feed
        del stops_df
        del routes_df
        del trips_df
        del stop_times_df
        gc.collect()

    stations_rows: List[Dict[str, Any]] = []
    for station in sorted(station_map.values(), key=lambda item: item["stop_id"]):
        if mode == "bus":
            child_ids: List[str] = []
        else:
            child_ids = sorted(station["child_stop_ids"])
            if not child_ids:
                child_ids = [station["stop_id"]]

        stations_rows.append(
            {
                "stop_id": station["stop_id"],
                "stop_name": station["stop_name"] or station["stop_id"],
                "stop_lat": station["stop_lat"],
                "stop_lon": station["stop_lon"],
                "parent_station": station["parent_station"],
                "child_stop_ids_json": child_ids,
            }
        )

    routes_rows = [
        {
            "route_id": route["route_id"],
            "agency_id": route["agency_id"],
            "route_short_name": route["route_short_name"],
            "route_long_name": route["route_long_name"],
            "route_desc": route["route_desc"],
            "route_type": route["route_type"],
            "route_url": route["route_url"],
            "route_color": route["route_color"],
            "route_text_color": route["route_text_color"],
            "route_sort_order": route["route_sort_order"],
        }
        for route in sorted(route_map.values(), key=lambda item: item["route_id"])
    ]

    def route_stop_sort_key(item: Tuple[Tuple[str, int, str], Optional[int]]) -> Tuple[str, int, int, str]:
        (route_id, direction_id, stop_id), stop_sequence = item
        sequence = stop_sequence if stop_sequence is not None else 2**31 - 1
        return (route_id, direction_id, sequence, stop_id)

    route_stops_rows = [
        {
            "route_id": route_id,
            "direction_id": direction_id,
            "stop_id": stop_id,
            "route_stop_sort_order": stop_sequence,
        }
        for (route_id, direction_id, stop_id), stop_sequence in sorted(route_stop_map.items(), key=route_stop_sort_key)
    ]

    log(
        f"{label}: parse complete in {elapsed_seconds(mode_started_at)} "
        f"(unique stations={len(stations_rows)}, routes={len(routes_rows)}, routeStops={len(route_stops_rows)})"
    )

    return {
        "counts": {
            "stations": len(stations_rows),
            "routes": len(routes_rows),
            "routeStops": len(route_stops_rows),
        },
        "warnings": {
            "missingTripRefs": missing_trip_refs,
            "missingStopRefs": len(missing_stop_ids),
            "sampleMissingStopIds": sorted(list(missing_stop_ids))[:50],
        },
        "missing_stop_ids": missing_stop_ids,
        "stations_rows": stations_rows,
        "routes_rows": routes_rows,
        "route_stops_rows": route_stops_rows,
    }


def parse_host_port() -> Tuple[str, int]:
    host = os.environ.get("POSTGRES_HOST", "").strip() or "127.0.0.1"
    port_env = os.environ.get("POSTGRES_PORT", "").strip()
    if port_env:
        try:
            return host, int(port_env)
        except ValueError:
            pass

    bind = os.environ.get("POSTGRES_PORT_BIND", "").strip()
    if bind:
        maybe = bind.split(":")[-1]
        try:
            return host, int(maybe)
        except ValueError:
            pass

    return host, 5432


def get_db_connection() -> psycopg2.extensions.connection:
    host, port = parse_host_port()
    dbname = os.environ.get("POSTGRES_DB", "").strip() or "commutelive"
    user = os.environ.get("POSTGRES_USER", "").strip() or "postgres"
    password = os.environ.get("POSTGRES_PASSWORD", "")
    conn = psycopg2.connect(
        host=host,
        port=port,
        dbname=dbname,
        user=user,
        password=password,
    )
    conn.autocommit = False
    return conn


def execute_values_if_rows(
    cursor: psycopg2.extensions.cursor,
    query: str,
    rows: List[Tuple[Any, ...]],
    page_size: int = INSERT_PAGE_SIZE,
) -> None:
    if not rows:
        return
    execute_values(cursor, query, rows, page_size=page_size)


def rows_for_stations(rows: List[Dict[str, Any]]) -> List[Tuple[Any, ...]]:
    return [
        (
            row["stop_id"],
            row["stop_name"],
            row["stop_lat"],
            row["stop_lon"],
            row["parent_station"],
            Json(row["child_stop_ids_json"]),
        )
        for row in rows
    ]


def rows_for_routes(rows: List[Dict[str, Any]]) -> List[Tuple[Any, ...]]:
    return [
        (
            row["route_id"],
            row["agency_id"],
            row["route_short_name"],
            row["route_long_name"],
            row["route_desc"],
            row["route_type"],
            row["route_url"],
            row["route_color"],
            row["route_text_color"],
            row["route_sort_order"],
        )
        for row in rows
    ]


def rows_for_route_stops(rows: List[Dict[str, Any]]) -> List[Tuple[Any, ...]]:
    return [
        (
            row["route_id"],
            row["direction_id"],
            row["stop_id"],
            row["route_stop_sort_order"],
        )
        for row in rows
    ]


def clear_mta_tables(cursor: psycopg2.extensions.cursor) -> None:
    cursor.execute(
        """
        TRUNCATE TABLE
            mta_subway_route_stops,
            mta_subway_routes,
            mta_subway_stations,
            mta_bus_route_stops,
            mta_bus_routes,
            mta_bus_stations,
            mta_lirr_route_stops,
            mta_lirr_routes,
            mta_lirr_stations,
            mta_mnr_route_stops,
            mta_mnr_routes,
            mta_mnr_stations;
        """
    )


def insert_non_bus_mode(cursor: psycopg2.extensions.cursor, mode: str, result: Dict[str, Any]) -> None:
    station_table = f"mta_{mode}_stations"
    route_table = f"mta_{mode}_routes"
    route_stop_table = f"mta_{mode}_route_stops"

    execute_values_if_rows(
        cursor,
        f"""
        INSERT INTO {station_table}
            (stop_id, stop_name, stop_lat, stop_lon, parent_station, child_stop_ids_json)
        VALUES %s
        """,
        rows_for_stations(result["stations_rows"]),
    )
    execute_values_if_rows(
        cursor,
        f"""
        INSERT INTO {route_table}
            (route_id, agency_id, route_short_name, route_long_name, route_desc, route_type, route_url, route_color, route_text_color, route_sort_order)
        VALUES %s
        """,
        rows_for_routes(result["routes_rows"]),
    )
    execute_values_if_rows(
        cursor,
        f"""
        INSERT INTO {route_stop_table}
            (route_id, direction_id, stop_id, route_stop_sort_order)
        VALUES %s
        """,
        rows_for_route_stops(result["route_stops_rows"]),
    )


def upsert_bus_mode(cursor: psycopg2.extensions.cursor, result: Dict[str, Any]) -> None:
    execute_values_if_rows(
        cursor,
        """
        INSERT INTO mta_bus_stations
            (stop_id, stop_name, stop_lat, stop_lon, parent_station, child_stop_ids_json)
        VALUES %s
        ON CONFLICT (stop_id) DO UPDATE SET
            stop_name = EXCLUDED.stop_name,
            stop_lat = COALESCE(EXCLUDED.stop_lat, mta_bus_stations.stop_lat),
            stop_lon = COALESCE(EXCLUDED.stop_lon, mta_bus_stations.stop_lon),
            parent_station = COALESCE(EXCLUDED.parent_station, mta_bus_stations.parent_station),
            child_stop_ids_json = EXCLUDED.child_stop_ids_json,
            imported_at = now()
        """,
        rows_for_stations(result["stations_rows"]),
    )
    execute_values_if_rows(
        cursor,
        """
        INSERT INTO mta_bus_routes
            (route_id, agency_id, route_short_name, route_long_name, route_desc, route_type, route_url, route_color, route_text_color, route_sort_order)
        VALUES %s
        ON CONFLICT (route_id) DO UPDATE SET
            agency_id = COALESCE(EXCLUDED.agency_id, mta_bus_routes.agency_id),
            route_short_name = COALESCE(NULLIF(EXCLUDED.route_short_name, ''), mta_bus_routes.route_short_name),
            route_long_name = COALESCE(NULLIF(EXCLUDED.route_long_name, ''), mta_bus_routes.route_long_name),
            route_desc = COALESCE(EXCLUDED.route_desc, mta_bus_routes.route_desc),
            route_type = EXCLUDED.route_type,
            route_url = COALESCE(EXCLUDED.route_url, mta_bus_routes.route_url),
            route_color = COALESCE(EXCLUDED.route_color, mta_bus_routes.route_color),
            route_text_color = COALESCE(EXCLUDED.route_text_color, mta_bus_routes.route_text_color),
            route_sort_order = COALESCE(EXCLUDED.route_sort_order, mta_bus_routes.route_sort_order),
            imported_at = now()
        """,
        rows_for_routes(result["routes_rows"]),
    )
    execute_values_if_rows(
        cursor,
        """
        INSERT INTO mta_bus_route_stops
            (route_id, direction_id, stop_id, route_stop_sort_order)
        VALUES %s
        ON CONFLICT DO NOTHING
        """,
        rows_for_route_stops(result["route_stops_rows"]),
    )


def main() -> int:
    started_at = time.time()
    source_dir = Path(sys.argv[1] if len(sys.argv) > 1 else Path.cwd() / "mta").resolve()

    subway_dir = resolve_single_dataset_dir(source_dir / "subway", "subway")
    lirr_dir = resolve_single_dataset_dir(source_dir / "lirr", "lirr")
    mnr_dir = resolve_single_dataset_dir(source_dir / "mnr", "mnr")
    bus_dirs = collect_dataset_dirs(source_dir / "bus")
    if not bus_dirs:
        raise RuntimeError(f"Missing GTFS dataset for mode bus: {source_dir / 'bus'}")

    counts: Dict[str, Dict[str, int]] = {
        "subway": {"stations": 0, "routes": 0, "routeStops": 0},
        "bus": {"stations": 0, "routes": 0, "routeStops": 0},
        "lirr": {"stations": 0, "routes": 0, "routeStops": 0},
        "mnr": {"stations": 0, "routes": 0, "routeStops": 0},
    }
    warnings: Dict[str, Dict[str, Any]] = {
        "subway": {"missingTripRefs": 0, "missingStopRefs": 0, "sampleMissingStopIds": []},
        "bus": {"missingTripRefs": 0, "missingStopRefs": 0, "sampleMissingStopIds": []},
        "lirr": {"missingTripRefs": 0, "missingStopRefs": 0, "sampleMissingStopIds": []},
        "mnr": {"missingTripRefs": 0, "missingStopRefs": 0, "sampleMissingStopIds": []},
    }

    bus_station_ids: Set[str] = set()
    bus_route_ids: Set[str] = set()
    bus_route_stop_keys: Set[Tuple[str, int, str]] = set()
    bus_missing_stop_ids: Set[str] = set()
    bus_missing_trip_refs = 0

    conn = get_db_connection()
    try:
        with conn:
            with conn.cursor() as cursor:
                log("clearing all MTA core tables")
                clear_mta_tables(cursor)

                subway = process_mode("subway", [subway_dir], "subway")
                insert_non_bus_mode(cursor, "subway", subway)
                counts["subway"] = subway["counts"]
                warnings["subway"] = subway["warnings"]
                log(
                    f"subway: wrote stations={counts['subway']['stations']}, "
                    f"routes={counts['subway']['routes']}, routeStops={counts['subway']['routeStops']}"
                )

                lirr = process_mode("lirr", [lirr_dir], "lirr")
                insert_non_bus_mode(cursor, "lirr", lirr)
                counts["lirr"] = lirr["counts"]
                warnings["lirr"] = lirr["warnings"]
                log(
                    f"lirr: wrote stations={counts['lirr']['stations']}, "
                    f"routes={counts['lirr']['routes']}, routeStops={counts['lirr']['routeStops']}"
                )

                mnr = process_mode("mnr", [mnr_dir], "mnr")
                insert_non_bus_mode(cursor, "mnr", mnr)
                counts["mnr"] = mnr["counts"]
                warnings["mnr"] = mnr["warnings"]
                log(
                    f"mnr: wrote stations={counts['mnr']['stations']}, "
                    f"routes={counts['mnr']['routes']}, routeStops={counts['mnr']['routeStops']}"
                )

                for index, bus_dir in enumerate(bus_dirs, start=1):
                    dataset_name = bus_dir.name
                    label = f"bus dataset {index}/{len(bus_dirs)} ({dataset_name})"
                    bus = process_mode("bus", [bus_dir], label)
                    upsert_bus_mode(cursor, bus)

                    for row in bus["stations_rows"]:
                        bus_station_ids.add(row["stop_id"])
                    for row in bus["routes_rows"]:
                        bus_route_ids.add(row["route_id"])
                    for row in bus["route_stops_rows"]:
                        bus_route_stop_keys.add((row["route_id"], row["direction_id"], row["stop_id"]))

                    bus_missing_trip_refs += bus["warnings"]["missingTripRefs"]
                    bus_missing_stop_ids.update(bus["missing_stop_ids"])

                    log(
                        f"bus: merged {label}; cumulative unique stations={len(bus_station_ids)}, "
                        f"routes={len(bus_route_ids)}, routeStops={len(bus_route_stop_keys)}"
                    )

                counts["bus"] = {
                    "stations": len(bus_station_ids),
                    "routes": len(bus_route_ids),
                    "routeStops": len(bus_route_stop_keys),
                }
                warnings["bus"] = {
                    "missingTripRefs": bus_missing_trip_refs,
                    "missingStopRefs": len(bus_missing_stop_ids),
                    "sampleMissingStopIds": sorted(list(bus_missing_stop_ids))[:50],
                }

        result = {
            "sourceDir": str(source_dir),
            "busDatasets": len(bus_dirs),
            "counts": counts,
            "warnings": warnings,
        }
        log(f"import complete in {elapsed_seconds(started_at)}")
        print(json.dumps(result, indent=2))
        return 0
    finally:
        conn.close()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"[mta-import-py] {now_iso()} ERROR: {exc}", file=sys.stderr, flush=True)
        raise
