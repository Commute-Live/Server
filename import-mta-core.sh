#!/bin/bash
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
WORK_DIR="$(mktemp -d "/tmp/mta-core-import-XXXXXX")"

MTA_SUBWAY_GTFS_URL="${MTA_SUBWAY_GTFS_URL:-https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip}"
MTA_LIRR_GTFS_URL="${MTA_LIRR_GTFS_URL:-https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip}"
MTA_MNR_GTFS_URL="${MTA_MNR_GTFS_URL:-https://rrgtfsfeeds.s3.amazonaws.com/gtfsmnr.zip}"
MTA_BUS_BX_GTFS_URL="${MTA_BUS_BX_GTFS_URL:-https://rrgtfsfeeds.s3.amazonaws.com/gtfs_bx.zip}"
MTA_BUS_B_GTFS_URL="${MTA_BUS_B_GTFS_URL:-https://rrgtfsfeeds.s3.amazonaws.com/gtfs_b.zip}"
MTA_BUS_M_GTFS_URL="${MTA_BUS_M_GTFS_URL:-https://rrgtfsfeeds.s3.amazonaws.com/gtfs_m.zip}"
MTA_BUS_Q_GTFS_URL="${MTA_BUS_Q_GTFS_URL:-https://rrgtfsfeeds.s3.amazonaws.com/gtfs_q.zip}"
MTA_BUS_SI_GTFS_URL="${MTA_BUS_SI_GTFS_URL:-https://rrgtfsfeeds.s3.amazonaws.com/gtfs_si.zip}"
MTA_BUS_BUSCO_GTFS_URL="${MTA_BUS_BUSCO_GTFS_URL:-https://rrgtfsfeeds.s3.amazonaws.com/gtfs_busco.zip}"

cleanup() {
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

require_command() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "ERROR: required command not found: ${cmd}"
    exit 1
  fi
}

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

extract_feed() {
  local name="$1"
  local url="$2"
  local zip_path="${WORK_DIR}/${name}.zip"
  local extract_dir="${WORK_DIR}/${name}"

  echo "Downloading ${name}: ${url}" >&2
  curl -fL "${url}" -o "${zip_path}"

  mkdir -p "${extract_dir}"
  unzip -oq "${zip_path}" -d "${extract_dir}"

  local dataset_dir
  dataset_dir="$(find_dataset_dir "${extract_dir}" || true)"
  if [[ -z "${dataset_dir}" ]]; then
    echo "ERROR: Could not locate dataset for ${name} (needs stops/routes/trips/stop_times)"
    exit 1
  fi

  printf '%s\n' "${dataset_dir}"
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

echo "[1/7] Downloading + extracting MTA GTFS feeds"
SUBWAY_DIR="$(extract_feed subway "${MTA_SUBWAY_GTFS_URL}")"
LIRR_DIR="$(extract_feed lirr "${MTA_LIRR_GTFS_URL}")"
MNR_DIR="$(extract_feed mnr "${MTA_MNR_GTFS_URL}")"
BUS_BX_DIR="$(extract_feed bus_bx "${MTA_BUS_BX_GTFS_URL}")"
BUS_B_DIR="$(extract_feed bus_b "${MTA_BUS_B_GTFS_URL}")"
BUS_M_DIR="$(extract_feed bus_m "${MTA_BUS_M_GTFS_URL}")"
BUS_Q_DIR="$(extract_feed bus_q "${MTA_BUS_Q_GTFS_URL}")"
BUS_SI_DIR="$(extract_feed bus_si "${MTA_BUS_SI_GTFS_URL}")"
BUS_BUSCO_DIR="$(extract_feed bus_busco "${MTA_BUS_BUSCO_GTFS_URL}")"

echo "[2/7] Feed directories"
echo "Subway: ${SUBWAY_DIR}"
echo "LIRR:   ${LIRR_DIR}"
echo "MNR:    ${MNR_DIR}"
echo "Bus BX: ${BUS_BX_DIR}"
echo "Bus B:  ${BUS_B_DIR}"
echo "Bus M:  ${BUS_M_DIR}"
echo "Bus Q:  ${BUS_Q_DIR}"
echo "Bus SI: ${BUS_SI_DIR}"
echo "BusCO:  ${BUS_BUSCO_DIR}"

NORMALIZED_DIR="${WORK_DIR}/mta"

echo "[3/7] Preparing normalized dataset folders"
mkdir -p "${NORMALIZED_DIR}/subway" "${NORMALIZED_DIR}/lirr" "${NORMALIZED_DIR}/mnr"
mkdir -p "${NORMALIZED_DIR}/bus/bx" "${NORMALIZED_DIR}/bus/b" "${NORMALIZED_DIR}/bus/m" "${NORMALIZED_DIR}/bus/q" "${NORMALIZED_DIR}/bus/si" "${NORMALIZED_DIR}/bus/busco"

for f in stops.txt routes.txt trips.txt stop_times.txt; do
  cp "${SUBWAY_DIR}/${f}" "${NORMALIZED_DIR}/subway/${f}"
  cp "${LIRR_DIR}/${f}" "${NORMALIZED_DIR}/lirr/${f}"
  cp "${MNR_DIR}/${f}" "${NORMALIZED_DIR}/mnr/${f}"
  cp "${BUS_BX_DIR}/${f}" "${NORMALIZED_DIR}/bus/bx/${f}"
  cp "${BUS_B_DIR}/${f}" "${NORMALIZED_DIR}/bus/b/${f}"
  cp "${BUS_M_DIR}/${f}" "${NORMALIZED_DIR}/bus/m/${f}"
  cp "${BUS_Q_DIR}/${f}" "${NORMALIZED_DIR}/bus/q/${f}"
  cp "${BUS_SI_DIR}/${f}" "${NORMALIZED_DIR}/bus/si/${f}"
  cp "${BUS_BUSCO_DIR}/${f}" "${NORMALIZED_DIR}/bus/busco/${f}"
done

echo "[4/7] Copying normalized datasets into api container"
docker compose exec -T api sh -lc "rm -rf /tmp/mta_core_import && mkdir -p /tmp/mta_core_import"
docker cp "${NORMALIZED_DIR}/." "${API_CID}:/tmp/mta_core_import/"

echo "[5/7] Running DB import in api container"
docker compose exec -T api bun run src/scripts/mta_import_core_local.ts /tmp/mta_core_import

echo "[6/7] Verifying core table counts"
docker compose exec -T postgres psql \
  -U "${POSTGRES_USER:-postgres}" \
  -d "${POSTGRES_DB:-commutelive}" \
  -c "SELECT 'mta_subway_stations' t, count(*) FROM mta_subway_stations
UNION ALL SELECT 'mta_subway_routes', count(*) FROM mta_subway_routes
UNION ALL SELECT 'mta_subway_route_stops', count(*) FROM mta_subway_route_stops
UNION ALL SELECT 'mta_bus_stations', count(*) FROM mta_bus_stations
UNION ALL SELECT 'mta_bus_routes', count(*) FROM mta_bus_routes
UNION ALL SELECT 'mta_bus_route_stops', count(*) FROM mta_bus_route_stops
UNION ALL SELECT 'mta_lirr_stations', count(*) FROM mta_lirr_stations
UNION ALL SELECT 'mta_lirr_routes', count(*) FROM mta_lirr_routes
UNION ALL SELECT 'mta_lirr_route_stops', count(*) FROM mta_lirr_route_stops
UNION ALL SELECT 'mta_mnr_stations', count(*) FROM mta_mnr_stations
UNION ALL SELECT 'mta_mnr_routes', count(*) FROM mta_mnr_routes
UNION ALL SELECT 'mta_mnr_route_stops', count(*) FROM mta_mnr_route_stops;"

echo "[7/7] MTA core import complete."
