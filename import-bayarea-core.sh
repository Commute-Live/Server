#!/bin/bash
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
WORK_DIR="$(mktemp -d "/tmp/bayarea-core-import-XXXXXX")"

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

if [[ -f "${ROOT_DIR}/.env" ]]; then
  set -a
  source "${ROOT_DIR}/.env"
  set +a
fi

OPEN511_API_KEY="${OPEN511_API_KEY:-}"
if [[ -z "${OPEN511_API_KEY}" ]]; then
  echo "ERROR: OPEN511_API_KEY is required"
  exit 1
fi

GTFS_URL="${GTFS_URL:-https://api.511.org/transit/datafeeds?api_key=${OPEN511_API_KEY}&operator_id=RG}"

API_CID="$(docker compose ps -q api || true)"
if [[ -z "${API_CID}" ]]; then
  echo "ERROR: api container is not running. Start it before importing."
  exit 1
fi

ZIP_PATH="${WORK_DIR}/bayarea_gtfs.zip"
EXTRACT_DIR="${WORK_DIR}/extract"
NORMALIZED_DIR="${WORK_DIR}/bayarea"

echo "[1/6] Downloading Bay Area regional GTFS from 511"
curl -fL "${GTFS_URL}" -o "${ZIP_PATH}"

echo "[2/6] Extracting GTFS"
mkdir -p "${EXTRACT_DIR}"
unzip -oq "${ZIP_PATH}" -d "${EXTRACT_DIR}"

echo "[3/6] Locating dataset directory"
DATASET_DIR="$(find_dataset_dir "${EXTRACT_DIR}" || true)"
if [[ -z "${DATASET_DIR}" ]]; then
  echo "ERROR: Could not locate Bay Area dataset (needs stops/routes/trips/stop_times)"
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
docker compose exec -T api sh -lc "rm -rf /tmp/bayarea_core_import && mkdir -p /tmp/bayarea_core_import"
docker cp "${NORMALIZED_DIR}/." "${API_CID}:/tmp/bayarea_core_import/"
docker compose exec -T api bun run src/scripts/bayarea_import_core_local.ts /tmp/bayarea_core_import

echo "[6/6] Verifying core table counts"
docker compose exec -T postgres psql \
  -U "${POSTGRES_USER:-postgres}" \
  -d "${POSTGRES_DB:-commutelive}" \
  -c "SELECT 'bayarea_bus_stations' t, count(*) FROM bayarea_bus_stations
UNION ALL SELECT 'bayarea_bus_routes', count(*) FROM bayarea_bus_routes
UNION ALL SELECT 'bayarea_bus_route_stops', count(*) FROM bayarea_bus_route_stops
UNION ALL SELECT 'bayarea_tram_stations', count(*) FROM bayarea_tram_stations
UNION ALL SELECT 'bayarea_tram_routes', count(*) FROM bayarea_tram_routes
UNION ALL SELECT 'bayarea_tram_route_stops', count(*) FROM bayarea_tram_route_stops
UNION ALL SELECT 'bayarea_cableway_stations', count(*) FROM bayarea_cableway_stations
UNION ALL SELECT 'bayarea_cableway_routes', count(*) FROM bayarea_cableway_routes
UNION ALL SELECT 'bayarea_cableway_route_stops', count(*) FROM bayarea_cableway_route_stops;"

echo "Bay Area core import complete."
