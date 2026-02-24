#!/bin/bash
set -euo pipefail

GTFS_URL="${GTFS_URL:-https://www3.septa.org/developer/gtfs_public.zip}"
ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
WORK_DIR="$(mktemp -d "/tmp/septa-core-import-XXXXXX")"

cleanup() {
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

find_dataset_dir() {
  local root="$1"
  while IFS= read -r -d '' d; do
    if [[ -f "${d}/stops.txt" && -f "${d}/routes.txt" && -f "${d}/route_stops.txt" ]]; then
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

OUTER_ZIP="${WORK_DIR}/gtfs_public.zip"
OUTER_DIR="${WORK_DIR}/outer"
BUS_ROOT="${WORK_DIR}/google_bus"
RAIL_ROOT="${WORK_DIR}/google_rail"
NORMALIZED_DIR="${WORK_DIR}/septa"

echo "[1/7] Downloading GTFS from ${GTFS_URL}"
curl -fL "${GTFS_URL}" -o "${OUTER_ZIP}"

echo "[2/7] Extracting gtfs_public.zip"
mkdir -p "${OUTER_DIR}"
unzip -oq "${OUTER_ZIP}" -d "${OUTER_DIR}"

echo "[3/7] Extracting nested google_bus/google_rail zips"
if [[ -f "${OUTER_DIR}/google_bus.zip" ]]; then
  mkdir -p "${BUS_ROOT}"
  unzip -oq "${OUTER_DIR}/google_bus.zip" -d "${BUS_ROOT}"
elif [[ -d "${OUTER_DIR}/google_bus" ]]; then
  BUS_ROOT="${OUTER_DIR}/google_bus"
else
  echo "ERROR: google_bus.zip (or extracted google_bus/) not found in gtfs_public.zip"
  exit 1
fi

if [[ -f "${OUTER_DIR}/google_rail.zip" ]]; then
  mkdir -p "${RAIL_ROOT}"
  unzip -oq "${OUTER_DIR}/google_rail.zip" -d "${RAIL_ROOT}"
elif [[ -d "${OUTER_DIR}/google_rail" ]]; then
  RAIL_ROOT="${OUTER_DIR}/google_rail"
else
  echo "ERROR: google_rail.zip (or extracted google_rail/) not found in gtfs_public.zip"
  exit 1
fi

echo "[4/7] Locating bus/rail dataset directories"
BUS_DIR="$(find_dataset_dir "${BUS_ROOT}" || true)"
RAIL_DIR="$(find_dataset_dir "${RAIL_ROOT}" || true)"
if [[ -z "${BUS_DIR}" || -z "${RAIL_DIR}" ]]; then
  echo "ERROR: Could not find nested datasets with required files (stops/routes/route_stops)"
  exit 1
fi
echo "Bus dataset:  ${BUS_DIR}"
echo "Rail dataset: ${RAIL_DIR}"

echo "[5/7] Preparing normalized core files"
mkdir -p "${NORMALIZED_DIR}/bus" "${NORMALIZED_DIR}/rail"
cp "${BUS_DIR}/stops.txt" "${NORMALIZED_DIR}/bus/stops.txt"
cp "${BUS_DIR}/routes.txt" "${NORMALIZED_DIR}/bus/routes.txt"
cp "${BUS_DIR}/route_stops.txt" "${NORMALIZED_DIR}/bus/route_stops.txt"
cp "${RAIL_DIR}/stops.txt" "${NORMALIZED_DIR}/rail/stops.txt"
cp "${RAIL_DIR}/routes.txt" "${NORMALIZED_DIR}/rail/routes.txt"
cp "${RAIL_DIR}/route_stops.txt" "${NORMALIZED_DIR}/rail/route_stops.txt"

echo "[6/7] Running DB import in api container"
docker compose exec -T api sh -lc "rm -rf /tmp/septa_core_import && mkdir -p /tmp/septa_core_import"
docker cp "${NORMALIZED_DIR}/." "${API_CID}:/tmp/septa_core_import/"
docker compose exec -T api bun run src/scripts/septa_import_core_local.ts /tmp/septa_core_import

echo "[7/7] Verifying core table counts"
docker compose exec -T postgres psql \
  -U "${POSTGRES_USER:-postgres}" \
  -d "${POSTGRES_DB:-commutelive}" \
  -c "SELECT 'septa_rail_stops' t, count(*) FROM septa_rail_stops
UNION ALL SELECT 'septa_rail_routes', count(*) FROM septa_rail_routes
UNION ALL SELECT 'septa_rail_route_stops', count(*) FROM septa_rail_route_stops
UNION ALL SELECT 'septa_bus_stops', count(*) FROM septa_bus_stops
UNION ALL SELECT 'septa_bus_routes', count(*) FROM septa_bus_routes
UNION ALL SELECT 'septa_bus_route_stops', count(*) FROM septa_bus_route_stops
UNION ALL SELECT 'septa_trolley_stops', count(*) FROM septa_trolley_stops
UNION ALL SELECT 'septa_trolley_routes', count(*) FROM septa_trolley_routes
UNION ALL SELECT 'septa_trolley_route_stops', count(*) FROM septa_trolley_route_stops;"

echo "SEPTA core import complete."
