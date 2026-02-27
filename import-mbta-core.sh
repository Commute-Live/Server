#!/bin/bash
set -euo pipefail

GTFS_URL="${GTFS_URL:-https://cdn.mbta.com/MBTA_GTFS.zip}"
ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
WORK_DIR="$(mktemp -d "/tmp/mbta-core-import-XXXXXX")"

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

ZIP_PATH="${WORK_DIR}/mbta_gtfs.zip"
EXTRACT_DIR="${WORK_DIR}/extract"
NORMALIZED_DIR="${WORK_DIR}/mbta"

echo "[1/6] Downloading MBTA GTFS from ${GTFS_URL}"
curl -fL "${GTFS_URL}" -o "${ZIP_PATH}"

echo "[2/6] Extracting MBTA GTFS"
mkdir -p "${EXTRACT_DIR}"
unzip -oq "${ZIP_PATH}" -d "${EXTRACT_DIR}"

echo "[3/6] Locating dataset directory"
DATASET_DIR="$(find_dataset_dir "${EXTRACT_DIR}" || true)"
if [[ -z "${DATASET_DIR}" ]]; then
  echo "ERROR: Could not locate MBTA dataset (needs stops/routes/trips/stop_times)"
  exit 1
fi
echo "Dataset: ${DATASET_DIR}"

echo "[4/6] Preparing normalized core files"
mkdir -p "${NORMALIZED_DIR}"
cp "${DATASET_DIR}/stops.txt" "${NORMALIZED_DIR}/stops.txt"
cp "${DATASET_DIR}/routes.txt" "${NORMALIZED_DIR}/routes.txt"
cp "${DATASET_DIR}/trips.txt" "${NORMALIZED_DIR}/trips.txt"
cp "${DATASET_DIR}/stop_times.txt" "${NORMALIZED_DIR}/stop_times.txt"

echo "[5/6] Running DB import in api container"
docker compose exec -T api sh -lc "rm -rf /tmp/mbta_core_import && mkdir -p /tmp/mbta_core_import"
docker cp "${NORMALIZED_DIR}/." "${API_CID}:/tmp/mbta_core_import/"
docker compose exec -T api bun run src/scripts/mbta_import_core_local.ts /tmp/mbta_core_import

echo "[6/6] Verifying core table counts"
docker compose exec -T postgres psql \
  -U "${POSTGRES_USER:-postgres}" \
  -d "${POSTGRES_DB:-commutelive}" \
  -c "SELECT 'mbta_subway_stations' t, count(*) FROM mbta_subway_stations
UNION ALL SELECT 'mbta_subway_routes', count(*) FROM mbta_subway_routes
UNION ALL SELECT 'mbta_subway_route_stops', count(*) FROM mbta_subway_route_stops
UNION ALL SELECT 'mbta_bus_stations', count(*) FROM mbta_bus_stations
UNION ALL SELECT 'mbta_bus_routes', count(*) FROM mbta_bus_routes
UNION ALL SELECT 'mbta_bus_route_stops', count(*) FROM mbta_bus_route_stops
UNION ALL SELECT 'mbta_rail_stations', count(*) FROM mbta_rail_stations
UNION ALL SELECT 'mbta_rail_routes', count(*) FROM mbta_rail_routes
UNION ALL SELECT 'mbta_rail_route_stops', count(*) FROM mbta_rail_route_stops
UNION ALL SELECT 'mbta_ferry_stations', count(*) FROM mbta_ferry_stations
UNION ALL SELECT 'mbta_ferry_routes', count(*) FROM mbta_ferry_routes
UNION ALL SELECT 'mbta_ferry_route_stops', count(*) FROM mbta_ferry_route_stops;"

echo "MBTA core import complete."
