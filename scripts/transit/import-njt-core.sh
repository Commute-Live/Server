#!/bin/bash
set -euo pipefail

NJT_RAIL_GTFS_URL="${NJT_RAIL_GTFS_URL:-https://www.njtransit.com/rail_data.zip}"
NJT_BUS_GTFS_URL="${NJT_BUS_GTFS_URL:-https://www.njtransit.com/bus_data.zip}"
ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
WORK_DIR="$(mktemp -d "/tmp/njt-core-import-XXXXXX")"

cleanup() {
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

find_dataset_dir() {
  local root="$1"
  while IFS= read -r -d '' d; do
    if [[ -f "${d}/stops.txt" && -f "${d}/routes.txt" && -f "${d}/trips.txt" && -f "${d}/stop_times.txt" ]]; then
      printf '%s\n' "${d}"
      return 0
    fi
  done < <(find "${root}" -type d -print0 2>/dev/null)
  return 1
}

require_command() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "ERROR: required command not found: ${cmd}"
    exit 1
  fi
}

require_command curl
require_command unzip
require_command docker

cd "${ROOT_DIR}"

if [[ ! -f "${ROOT_DIR}/docker-compose.yml" ]]; then
  echo "ERROR: docker-compose.yml not found in ${ROOT_DIR}"
  exit 1
fi

API_CID="$(docker compose ps -q api || true)"
if [[ -z "${API_CID}" ]]; then
  echo "ERROR: api container is not running. Start it before importing."
  exit 1
fi

if [[ -f "${ROOT_DIR}/.env" ]]; then
  set -a
  source "${ROOT_DIR}/.env"
  set +a
fi

RAIL_ZIP_PATH="${WORK_DIR}/njt_rail_gtfs.zip"
BUS_ZIP_PATH="${WORK_DIR}/njt_bus_gtfs.zip"
RAIL_EXTRACT_DIR="${WORK_DIR}/rail_extract"
BUS_EXTRACT_DIR="${WORK_DIR}/bus_extract"
NORMALIZED_DIR="${WORK_DIR}/njt"

echo "[1/7] Downloading NJ Transit rail GTFS from ${NJT_RAIL_GTFS_URL}"
curl -fL "${NJT_RAIL_GTFS_URL}" -o "${RAIL_ZIP_PATH}"

echo "[2/7] Downloading NJ Transit bus GTFS from ${NJT_BUS_GTFS_URL}"
curl -fL "${NJT_BUS_GTFS_URL}" -o "${BUS_ZIP_PATH}"

echo "[3/7] Extracting NJ Transit GTFS archives"
mkdir -p "${RAIL_EXTRACT_DIR}" "${BUS_EXTRACT_DIR}"
unzip -oq "${RAIL_ZIP_PATH}" -d "${RAIL_EXTRACT_DIR}"
unzip -oq "${BUS_ZIP_PATH}" -d "${BUS_EXTRACT_DIR}"

RAIL_DATASET_DIR="$(find_dataset_dir "${RAIL_EXTRACT_DIR}" || true)"
BUS_DATASET_DIR="$(find_dataset_dir "${BUS_EXTRACT_DIR}" || true)"
if [[ -z "${RAIL_DATASET_DIR}" || -z "${BUS_DATASET_DIR}" ]]; then
  echo "ERROR: Could not locate NJ Transit rail/bus datasets (need stops/routes/trips/stop_times)"
  exit 1
fi

echo "[4/7] Preparing normalized core files"
mkdir -p "${NORMALIZED_DIR}/rail" "${NORMALIZED_DIR}/bus"
for f in agency.txt routes.txt stops.txt trips.txt stop_times.txt calendar_dates.txt shapes.txt; do
  if [[ -f "${RAIL_DATASET_DIR}/${f}" ]]; then cp "${RAIL_DATASET_DIR}/${f}" "${NORMALIZED_DIR}/rail/${f}"; fi
  if [[ -f "${BUS_DATASET_DIR}/${f}" ]]; then cp "${BUS_DATASET_DIR}/${f}" "${NORMALIZED_DIR}/bus/${f}"; fi
done

echo "[5/7] Running DB import in api container"
docker compose exec -T api sh -lc "rm -rf /tmp/njt_core_import && mkdir -p /tmp/njt_core_import"
docker cp "${NORMALIZED_DIR}/." "${API_CID}:/tmp/njt_core_import/"
docker compose exec -T api bun run src/scripts/njt_import_core_local.ts /tmp/njt_core_import

echo "[6/7] Verifying core table counts"
docker compose exec -T postgres psql \
  -U "${POSTGRES_USER:-postgres}" \
  -d "${POSTGRES_DB:-commutelive}" \
  -c "SELECT 'njt_rail_stations' t, count(*) FROM njt_rail_stations
UNION ALL SELECT 'njt_rail_routes', count(*) FROM njt_rail_routes
UNION ALL SELECT 'njt_rail_route_stops', count(*) FROM njt_rail_route_stops
UNION ALL SELECT 'njt_bus_stations', count(*) FROM njt_bus_stations
UNION ALL SELECT 'njt_bus_routes', count(*) FROM njt_bus_routes
UNION ALL SELECT 'njt_bus_route_stops', count(*) FROM njt_bus_route_stops;"

echo "[7/7] NJ Transit core import complete."
