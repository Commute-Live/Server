#!/bin/bash
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
PROD_ENV_FILE="${PROD_ENV_FILE:-prod.env}"

TRANSIT_TABLE_PATTERNS=(
  'septa\_%'
  'mta\_%'
  'cta\_%'
  'mbta\_%'
  'bayarea\_%'
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

build_table_query() {
  local parts=()
  local pattern
  for pattern in "${TRANSIT_TABLE_PATTERNS[@]}"; do
    parts+=("table_name LIKE '${pattern}' ESCAPE '\\'")
  done

  local where_clause
  where_clause="$(printf '%s OR ' "${parts[@]}")"
  where_clause="${where_clause% OR }"

  cat <<EOF
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND (${where_clause})
ORDER BY table_name
EOF
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
PROD_TABLES_TXT="${WORK_DIR}/prod-tables.txt"

cleanup() {
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

TABLE_QUERY="$(build_table_query)"
psql --dbname="${PROD_DATABASE_URL}" -At -c "${TABLE_QUERY}" > "${PROD_TABLES_TXT}"
mapfile -t PROD_TABLES < "${PROD_TABLES_TXT}"

if [[ "${#PROD_TABLES[@]}" -eq 0 ]]; then
  echo "ERROR: no transit tables found in prod for configured prefixes" >&2
  exit 1
fi

LOCK_TABLES_SQL=()
TRUNCATE_TABLES_SQL=()
for table in "${PROD_TABLES[@]}"; do
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
