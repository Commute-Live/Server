#!/bin/sh
set -eu

GTFS_URL="${GTFS_URL:-https://www3.septa.org/developer/gtfs_public.zip}"
API_URL="${API_URL:-http://localhost:8080}"
SYNC_TOKEN="${SYNC_TOKEN:-${TOKEN:-}}"

# Auto-load token from local .env if not already provided
if [ -z "${SYNC_TOKEN}" ] && [ -f .env ]; then
  SYNC_TOKEN="$(grep '^SEPTA_SYNC_TOKEN=' .env | head -n1 | cut -d= -f2- || true)"
fi

if [ -z "${SYNC_TOKEN}" ]; then
  echo "ERROR: set SYNC_TOKEN/TOKEN or add SEPTA_SYNC_TOKEN to .env"
  exit 1
fi

RUN_DIR="$(pwd)"
STAMP="$(date +%Y%m%d_%H%M%S)"
OUT_DIR="${RUN_DIR}/septa_gtfs_${STAMP}"
ZIP_PATH="${OUT_DIR}/gtfs_public.zip"

mkdir -p "${OUT_DIR}"

echo "[1/6] Downloading GTFS zip..."
curl -fL "${GTFS_URL}" -o "${ZIP_PATH}"

echo "[2/6] Unzipping into ${OUT_DIR}..."
unzip -oq "${ZIP_PATH}" -d "${OUT_DIR}"

echo "[3/6] Locating/expanding google_bus/google_rail..."

# SEPTA currently provides nested zips in some versions.
if [ -f "${OUT_DIR}/google_bus.zip" ] && [ ! -d "${OUT_DIR}/google_bus" ]; then
  mkdir -p "${OUT_DIR}/google_bus"
  unzip -oq "${OUT_DIR}/google_bus.zip" -d "${OUT_DIR}/google_bus"
fi
if [ -f "${OUT_DIR}/google_rail.zip" ] && [ ! -d "${OUT_DIR}/google_rail" ]; then
  mkdir -p "${OUT_DIR}/google_rail"
  unzip -oq "${OUT_DIR}/google_rail.zip" -d "${OUT_DIR}/google_rail"
fi

find_dataset_dir() {
  # Return a directory containing core GTFS files.
  ROOT="$1"
  for d in $(find "${ROOT}" -type d 2>/dev/null); do
    if [ -f "${d}/routes.txt" ] && [ -f "${d}/stops.txt" ] && [ -f "${d}/trips.txt" ] && [ -f "${d}/stop_times.txt" ]; then
      echo "${d}"
      return 0
    fi
  done
  return 1
}

BUS_DIR="$(find_dataset_dir "${OUT_DIR}/google_bus" || true)"
RAIL_DIR="$(find_dataset_dir "${OUT_DIR}/google_rail" || true)"

if [ -z "${BUS_DIR}" ] || [ -z "${RAIL_DIR}" ]; then
  echo "ERROR: Could not find valid bus/rail GTFS datasets in ${OUT_DIR}"
  find "${OUT_DIR}" -maxdepth 4 -type d | sed -n '1,160p'
  exit 1
fi

echo "Found bus dir:  ${BUS_DIR}"
echo "Found rail dir: ${RAIL_DIR}"

echo "[4/6] Quick required file check..."
for f in routes.txt stops.txt trips.txt stop_times.txt; do
  [ -f "${BUS_DIR}/${f}" ] || { echo "ERROR: missing ${BUS_DIR}/${f}"; exit 1; }
  [ -f "${RAIL_DIR}/${f}" ] || { echo "ERROR: missing ${RAIL_DIR}/${f}"; exit 1; }
done

echo "[5/6] Triggering DB import..."
curl -sS -X POST "${API_URL}/admin/septa/import" \
  -H "x-septa-sync-token: ${SYNC_TOKEN}" \
  -H "content-type: application/json" \
  -d '{}'
echo

echo "[6/6] Verifying DB table counts..."
if command -v docker >/dev/null 2>&1 && [ -f "${RUN_DIR}/docker-compose.yml" ]; then
  docker compose exec -T postgres psql -U commute -d commutelive -c \
  "SELECT 'septa_routes' t, count(*) FROM septa_routes
   UNION ALL SELECT 'septa_stops', count(*) FROM septa_stops
   UNION ALL SELECT 'septa_route_stops', count(*) FROM septa_route_stops
   UNION ALL SELECT 'septa_scheduled_stop_times', count(*) FROM septa_scheduled_stop_times
   UNION ALL SELECT 'septa_service_dates', count(*) FROM septa_service_dates;"
else
  echo "Skipping DB count check (docker compose not available from this directory)."
fi

echo "Done. Unzipped GTFS kept at: ${OUT_DIR}"
