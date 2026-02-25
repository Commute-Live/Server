#!/bin/bash
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
WORK_DIR="$(mktemp -d "/tmp/mta-core-import-XXXXXX")"
SCRIPT_STARTED_AT="$(date +%s)"
MTA_IMPORT_ENGINE="${MTA_IMPORT_ENGINE:-python}"
MTA_PARTRIDGE_VENV="${MTA_PARTRIDGE_VENV:-${ROOT_DIR}/.venv-partridge}"
MTA_PARTRIDGE_DEPS="${MTA_PARTRIDGE_DEPS:-numpy==1.24.4 pandas==1.5.3 partridge==1.1.2 psycopg2-binary==2.9.9}"

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

timestamp() {
  date -u +"%Y-%m-%dT%H:%M:%SZ"
}

log() {
  echo "[$(timestamp)] $*"
}

on_error() {
  local exit_code=$?
  log "ERROR: MTA core import failed with exit code ${exit_code}. Showing last api logs."
  docker compose logs --tail=120 api || true
  exit "${exit_code}"
}
trap on_error ERR

require_command() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "ERROR: required command not found: ${cmd}"
    exit 1
  fi
}

ensure_python_venv() {
  require_command python3
  if ! python3 -m venv -h >/dev/null 2>&1; then
    echo "ERROR: python3 venv support is missing. Install python3-venv on the server."
    exit 1
  fi

  if [[ ! -f "${MTA_PARTRIDGE_VENV}/bin/activate" ]]; then
    log "Creating Python venv at ${MTA_PARTRIDGE_VENV}"
    python3 -m venv "${MTA_PARTRIDGE_VENV}"
  fi

  # shellcheck source=/dev/null
  source "${MTA_PARTRIDGE_VENV}/bin/activate"

  local stamp_file="${MTA_PARTRIDGE_VENV}/.mta_partridge_deps"
  local current_deps=""
  if [[ -f "${stamp_file}" ]]; then
    current_deps="$(cat "${stamp_file}")"
  fi

  if [[ "${current_deps}" != "${MTA_PARTRIDGE_DEPS}" ]]; then
    log "Installing Python dependencies for Partridge importer"
    python -m pip install --no-cache-dir --upgrade pip
    # shellcheck disable=SC2086
    python -m pip install --no-cache-dir ${MTA_PARTRIDGE_DEPS}
    printf '%s' "${MTA_PARTRIDGE_DEPS}" > "${stamp_file}"
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

  log "Downloading ${name}: ${url}" >&2
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

if [[ -f "${ROOT_DIR}/.env" ]]; then
  set -a
  source "${ROOT_DIR}/.env"
  set +a
fi

log "[1/7] Downloading + extracting MTA GTFS feeds"
SUBWAY_DIR="$(extract_feed subway "${MTA_SUBWAY_GTFS_URL}")"
LIRR_DIR="$(extract_feed lirr "${MTA_LIRR_GTFS_URL}")"
MNR_DIR="$(extract_feed mnr "${MTA_MNR_GTFS_URL}")"
BUS_BX_DIR="$(extract_feed bus_bx "${MTA_BUS_BX_GTFS_URL}")"
BUS_B_DIR="$(extract_feed bus_b "${MTA_BUS_B_GTFS_URL}")"
BUS_M_DIR="$(extract_feed bus_m "${MTA_BUS_M_GTFS_URL}")"
BUS_Q_DIR="$(extract_feed bus_q "${MTA_BUS_Q_GTFS_URL}")"
BUS_SI_DIR="$(extract_feed bus_si "${MTA_BUS_SI_GTFS_URL}")"
BUS_BUSCO_DIR="$(extract_feed bus_busco "${MTA_BUS_BUSCO_GTFS_URL}")"

log "[2/7] Feed directories"
log "Subway: ${SUBWAY_DIR}"
log "LIRR:   ${LIRR_DIR}"
log "MNR:    ${MNR_DIR}"
log "Bus BX: ${BUS_BX_DIR}"
log "Bus B:  ${BUS_B_DIR}"
log "Bus M:  ${BUS_M_DIR}"
log "Bus Q:  ${BUS_Q_DIR}"
log "Bus SI: ${BUS_SI_DIR}"
log "BusCO:  ${BUS_BUSCO_DIR}"

NORMALIZED_DIR="${WORK_DIR}/mta"

log "[3/7] Preparing normalized dataset folders"
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

case "${MTA_IMPORT_ENGINE}" in
  python)
    log "[4/7] Bootstrapping Partridge environment"
    ensure_python_venv
    IMPORT_STARTED_AT="$(date +%s)"
    log "[5/7] Running DB import on host via Partridge"
    python "${ROOT_DIR}/src/scripts/mta_import_core_partridge.py" "${NORMALIZED_DIR}"
    IMPORT_FINISHED_AT="$(date +%s)"
    log "[5/7] DB import completed in $((IMPORT_FINISHED_AT - IMPORT_STARTED_AT))s"
    ;;
  bun)
    API_CID="$(docker compose ps -q api || true)"
    if [[ -z "${API_CID}" ]]; then
      echo "ERROR: api container is not running. Start it before importing."
      exit 1
    fi
    log "[4/7] Copying normalized datasets into api container"
    docker compose exec -T api sh -lc "rm -rf /tmp/mta_core_import && mkdir -p /tmp/mta_core_import"
    docker cp "${NORMALIZED_DIR}/." "${API_CID}:/tmp/mta_core_import/"

    IMPORT_STARTED_AT="$(date +%s)"
    log "[5/7] Running DB import in api container"
    docker compose exec -T api bun run src/scripts/mta_import_core_local.ts /tmp/mta_core_import
    IMPORT_FINISHED_AT="$(date +%s)"
    log "[5/7] DB import completed in $((IMPORT_FINISHED_AT - IMPORT_STARTED_AT))s"
    ;;
  *)
    echo "ERROR: invalid MTA_IMPORT_ENGINE=${MTA_IMPORT_ENGINE}. Use 'python' or 'bun'."
    exit 1
    ;;
esac

log "[6/7] Verifying core table counts"
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

log "[7/7] MTA core import complete in $(( $(date +%s) - SCRIPT_STARTED_AT ))s."
