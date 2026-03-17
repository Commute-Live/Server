#!/bin/bash
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
PROD_ENV_FILE="${PROD_ENV_FILE:-prod.env}"

TRANSIT_TABLES=(
  septa_routes
  septa_stops
  septa_route_stops
  septa_scheduled_stop_times
  septa_service_dates
  septa_rail_stops
  septa_rail_routes
  septa_rail_route_stops
  septa_bus_stops
  septa_bus_routes
  septa_bus_route_stops
  septa_trolley_stops
  septa_trolley_routes
  septa_trolley_route_stops
  mta_subway_stations
  mta_subway_routes
  mta_subway_route_stops
  mta_bus_stations
  mta_bus_routes
  mta_bus_route_stops
  mta_lirr_stations
  mta_lirr_routes
  mta_lirr_route_stops
  mta_mnr_stations
  mta_mnr_routes
  mta_mnr_route_stops
  cta_subway_stations
  cta_subway_routes
  cta_subway_route_stops
  cta_bus_stations
  cta_bus_routes
  cta_bus_route_stops
  mbta_subway_stations
  mbta_subway_routes
  mbta_subway_route_stops
  mbta_bus_stations
  mbta_bus_routes
  mbta_bus_route_stops
  mbta_rail_stations
  mbta_rail_routes
  mbta_rail_route_stops
  mbta_ferry_stations
  mbta_ferry_routes
  mbta_ferry_route_stops
  bayarea_bus_stations
  bayarea_bus_routes
  bayarea_bus_route_stops
  bayarea_tram_stations
  bayarea_tram_routes
  bayarea_tram_route_stops
  bayarea_cableway_stations
  bayarea_cableway_routes
  bayarea_cableway_route_stops
)

usage() {
  cat <<'EOF'
Usage: ./scripts/transit/restore-transit-backup.sh /path/to/prod-transit-before-YYYYMMDDTHHMMSSZ.sql

Required env vars:
  PROD_DATABASE_URL or DATABASE_URL in prod.env

This restores a backup created by scripts/transit/promote-transit-to-prod.sh into prod
inside a single transaction.
EOF
}

quote_sql_literal() {
  printf "%s" "$1" | sed "s/'/''/g"
}

log() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $*"
}

require_command() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "ERROR: required command not found: ${cmd}" >&2
    exit 1
  fi
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "$#" -ne 1 ]]; then
  echo "ERROR: backup file path is required" >&2
  usage
  exit 1
fi

BACKUP_SQL="$1"

require_command psql
require_command mktemp

cd "${ROOT_DIR}"

if [[ -f "${ROOT_DIR}/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${ROOT_DIR}/.env"
  set +a
fi

if [[ -f "${ROOT_DIR}/${PROD_ENV_FILE}" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${ROOT_DIR}/${PROD_ENV_FILE}"
  set +a
fi

PROD_DATABASE_URL="${PROD_DATABASE_URL:-${DATABASE_URL:-}}"
if [[ -z "${PROD_DATABASE_URL}" && -n "${POSTGRES_DB:-}" && -n "${POSTGRES_USER:-}" && -n "${POSTGRES_PASSWORD:-}" ]]; then
  PROD_DATABASE_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${POSTGRES_PORT_BIND:-5432}/${POSTGRES_DB}"
fi

: "${PROD_DATABASE_URL:?PROD_DATABASE_URL is required (or set DATABASE_URL in ${PROD_ENV_FILE})}"

if [[ ! -f "${BACKUP_SQL}" ]]; then
  echo "ERROR: backup file not found: ${BACKUP_SQL}" >&2
  exit 1
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/transit-restore-XXXXXX")"
ROLLBACK_SQL="${WORK_DIR}/rollback.sql"

cleanup() {
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

LOCK_TABLES_SQL=()
TRUNCATE_TABLES_SQL=()
for table in "${TRANSIT_TABLES[@]}"; do
  LOCK_TABLES_SQL+=("public.${table}")
  TRUNCATE_TABLES_SQL+=("public.${table}")
done

LOCK_SQL="$(IFS=', '; echo "${LOCK_TABLES_SQL[*]}")"
TRUNCATE_SQL="$(IFS=', '; echo "${TRUNCATE_TABLES_SQL[*]}")"
cat > "${ROLLBACK_SQL}" <<EOF
\set ON_ERROR_STOP on
BEGIN;
LOCK TABLE ${LOCK_SQL} IN ACCESS EXCLUSIVE MODE;
TRUNCATE TABLE ${TRUNCATE_SQL};
\i ${BACKUP_SQL}
COMMIT;
EOF

log "Restoring transit backup from ${BACKUP_SQL}"
psql --dbname="${PROD_DATABASE_URL}" --file="${ROLLBACK_SQL}"
log "Transit backup restore complete."
