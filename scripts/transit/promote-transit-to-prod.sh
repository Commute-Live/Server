#!/bin/bash
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
TIMESTAMP_UTC="$(date -u +"%Y%m%dT%H%M%SZ")"
DATE_UTC="$(date -u +"%Y-%m-%d")"
PROD_ENV_FILE="${PROD_ENV_FILE:-prod.env}"
DEFAULT_TRANSIT_BACKUP_DIR="${HOME:-${ROOT_DIR}}/transit-backups/commute-live"
TRANSIT_BACKUP_DIR="${TRANSIT_BACKUP_DIR:-${DEFAULT_TRANSIT_BACKUP_DIR}}"
DRY_RUN="${DRY_RUN:-0}"
PSQL_BIN="${PSQL_BIN:-psql}"
PG_DUMP_BIN="${PG_DUMP_BIN:-pg_dump}"

TRANSIT_TABLE_PATTERNS=(
  'septa\_%'
  'mta\_%'
  'cta\_%'
  'mbta\_%'
  'bayarea\_%'
)

usage() {
  cat <<'EOF'
Usage: ./scripts/transit/promote-transit-to-prod.sh [--dry-run]

Required env vars:
  Staging source: STAGING_DATABASE_URL or DATABASE_URL in .env
  Prod target: PROD_DATABASE_URL or DATABASE_URL in prod.env

Optional env vars:
  PROD_ENV_FILE
  TRANSIT_BACKUP_DIR
  DRY_RUN=1

This script:
  1. Dumps current prod transit tables to a temporary rollback file.
  2. Dumps staging transit tables plus expected row counts.
  3. Replaces prod transit tables inside a single transaction.
  4. Deletes the temporary rollback file after a successful commit.
  5. Rolls back automatically if restore or validation fails.
EOF
}

require_command() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "ERROR: required command not found: ${cmd}" >&2
    exit 1
  fi
}

require_command_string() {
  local cmd_string="$1"
  local cmd_name="${cmd_string%% *}"
  require_command "${cmd_name}"
}

log() {
  echo "[$(date -u +"%Y-%m-%dT%H:%M:%SZ")] $*"
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

run_cmd() {
  if [[ "${DRY_RUN}" == "1" ]]; then
    printf '[dry-run] ' >&2
    printf '%q ' "$@" >&2
    printf '\n' >&2
    return 0
  fi

  "$@"
}

run_cmd_string() {
  local cmd_string="$1"
  shift

  if [[ "${DRY_RUN}" == "1" ]]; then
    printf '[dry-run] %s ' "${cmd_string}" >&2
    printf '%q ' "$@" >&2
    printf '\n' >&2
    return 0
  fi

  local quoted_args=()
  local arg
  for arg in "$@"; do
    quoted_args+=("$(printf '%q' "${arg}")")
  done

  # Allow wrapper commands like `docker run ... psql` while preserving exact argv quoting.
  eval "${cmd_string} ${quoted_args[*]}"
}

for arg in "$@"; do
  case "$arg" in
    --dry-run)
      DRY_RUN=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $arg" >&2
      usage
      exit 1
      ;;
  esac
done

require_command_string "${PG_DUMP_BIN}"
require_command_string "${PSQL_BIN}"
require_command mktemp
require_command find

cd "${ROOT_DIR}"

if [[ -f "${ROOT_DIR}/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${ROOT_DIR}/.env"
  set +a
fi

STAGING_DATABASE_URL="${STAGING_DATABASE_URL:-${DATABASE_URL:-}}"

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

: "${STAGING_DATABASE_URL:?STAGING_DATABASE_URL is required (or set DATABASE_URL in .env)}"
: "${PROD_DATABASE_URL:?PROD_DATABASE_URL is required (or set DATABASE_URL in ${PROD_ENV_FILE})}"

umask 077

BACKUP_DAY_DIR="${TRANSIT_BACKUP_DIR%/}/${DATE_UTC}"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/transit-promotion-XXXXXX")"
PROD_BACKUP_SQL="${BACKUP_DAY_DIR}/prod-transit-before-${TIMESTAMP_UTC}.sql"
STAGING_EXPORT_SQL="${WORK_DIR}/staging-transit-${TIMESTAMP_UTC}.sql"
EXPECTED_COUNTS_TSV="${WORK_DIR}/expected-counts-${TIMESTAMP_UTC}.tsv"
PROMOTION_SQL="${WORK_DIR}/promote-${TIMESTAMP_UTC}.sql"
STAGING_TABLES_TXT="${WORK_DIR}/staging-tables-${TIMESTAMP_UTC}.txt"
PROD_TABLES_TXT="${WORK_DIR}/prod-tables-${TIMESTAMP_UTC}.txt"

cleanup() {
  rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

TABLE_QUERY="$(build_table_query)"

if [[ "${DRY_RUN}" == "1" ]]; then
  printf '[dry-run] %s --dbname=%q -At -c %q > %q\n' \
    "${PSQL_BIN}" \
    "${STAGING_DATABASE_URL}" "${TABLE_QUERY}" "${STAGING_TABLES_TXT}" >&2
  printf '[dry-run] %s --dbname=%q -At -c %q > %q\n' \
    "${PSQL_BIN}" \
    "${PROD_DATABASE_URL}" "${TABLE_QUERY}" "${PROD_TABLES_TXT}" >&2
else
  run_cmd_string "${PSQL_BIN}" --dbname="${STAGING_DATABASE_URL}" -At -c "${TABLE_QUERY}" > "${STAGING_TABLES_TXT}"
  run_cmd_string "${PSQL_BIN}" --dbname="${PROD_DATABASE_URL}" -At -c "${TABLE_QUERY}" > "${PROD_TABLES_TXT}"
fi

if [[ "${DRY_RUN}" == "1" ]]; then
  log "Dry run stops before dynamic table diff/restore generation."
  exit 0
fi

mapfile -t STAGING_TABLES < "${STAGING_TABLES_TXT}"
mapfile -t PROD_TABLES < "${PROD_TABLES_TXT}"

if [[ "${#STAGING_TABLES[@]}" -eq 0 ]]; then
  echo "ERROR: no transit tables found in staging for configured prefixes" >&2
  exit 1
fi

if [[ "${#PROD_TABLES[@]}" -eq 0 ]]; then
  echo "ERROR: no transit tables found in prod for configured prefixes" >&2
  exit 1
fi

missing_tables=()
for table in "${STAGING_TABLES[@]}"; do
  if ! printf '%s\n' "${PROD_TABLES[@]}" | grep -Fxq "${table}"; then
    missing_tables+=("${table}")
  fi
done

if [[ "${#missing_tables[@]}" -gt 0 ]]; then
  echo "ERROR: prod is missing transit tables that exist in staging:" >&2
  printf '  %s\n' "${missing_tables[@]}" >&2
  exit 1
fi

TABLE_ARGS=()
LOCK_TABLES_SQL=()
TRUNCATE_TABLES_SQL=()
COUNT_QUERY_PARTS=()

for table in "${STAGING_TABLES[@]}"; do
  TABLE_ARGS+=(--table "public.${table}")
  LOCK_TABLES_SQL+=("public.${table}")
  TRUNCATE_TABLES_SQL+=("public.${table}")
  COUNT_QUERY_PARTS+=("SELECT '$(quote_sql_literal "${table}")' AS table_name, count(*)::bigint AS expected_count FROM public.${table}")
done

COUNT_QUERY="$(printf '%s UNION ALL ' "${COUNT_QUERY_PARTS[@]}")"
COUNT_QUERY="${COUNT_QUERY% UNION ALL }"
LOCK_SQL="$(IFS=', '; echo "${LOCK_TABLES_SQL[*]}")"
TRUNCATE_SQL="$(IFS=', '; echo "${TRUNCATE_TABLES_SQL[*]}")"

mkdir -p "${BACKUP_DAY_DIR}"

log "Backing up current prod transit tables to ${PROD_BACKUP_SQL}"
run_cmd_string "${PG_DUMP_BIN}" \
  --dbname="${PROD_DATABASE_URL}" \
  --data-only \
  --file="${PROD_BACKUP_SQL}" \
  "${TABLE_ARGS[@]}"

log "Exporting staging transit tables to ${STAGING_EXPORT_SQL}"
run_cmd_string "${PG_DUMP_BIN}" \
  --dbname="${STAGING_DATABASE_URL}" \
  --data-only \
  --file="${STAGING_EXPORT_SQL}" \
  "${TABLE_ARGS[@]}"

log "Capturing expected staging row counts"
if [[ "${DRY_RUN}" == "1" ]]; then
  printf '[dry-run] %s --dbname=%q -At -F "\\t" -c %q > %q\n' \
    "${PSQL_BIN}" \
    "${STAGING_DATABASE_URL}" "${COUNT_QUERY}" "${EXPECTED_COUNTS_TSV}" >&2
else
  run_cmd_string "${PSQL_BIN}" \
    --dbname="${STAGING_DATABASE_URL}" \
    -At \
    -F $'\t' \
    -c "${COUNT_QUERY}" > "${EXPECTED_COUNTS_TSV}"
fi

COUNTS_PATH_SQL="$(quote_sql_literal "${EXPECTED_COUNTS_TSV}")"

cat > "${PROMOTION_SQL}" <<EOF
\set ON_ERROR_STOP on
BEGIN;
LOCK TABLE ${LOCK_SQL} IN ACCESS EXCLUSIVE MODE;
CREATE TEMP TABLE expected_counts (
  table_name text PRIMARY KEY,
  expected_count bigint NOT NULL
);
\copy expected_counts (table_name, expected_count) FROM '${COUNTS_PATH_SQL}' WITH (FORMAT csv, DELIMITER E'\t')
TRUNCATE TABLE ${TRUNCATE_SQL};
\i ${STAGING_EXPORT_SQL}
DO \$\$
DECLARE
  rec record;
  actual_count bigint;
BEGIN
  FOR rec IN SELECT table_name, expected_count FROM expected_counts LOOP
    EXECUTE format('SELECT count(*) FROM public.%I', rec.table_name) INTO actual_count;
    IF actual_count <> rec.expected_count THEN
      RAISE EXCEPTION 'count mismatch for %, expected %, got %', rec.table_name, rec.expected_count, actual_count;
    END IF;
    IF rec.expected_count > 0 AND actual_count = 0 THEN
      RAISE EXCEPTION 'table % unexpectedly empty after restore', rec.table_name;
    END IF;
  END LOOP;
END
\$\$;
COMMIT;
EOF

log "Applying staging transit data to prod inside a single transaction"
run_cmd_string "${PSQL_BIN}" --dbname="${PROD_DATABASE_URL}" --file="${PROMOTION_SQL}"

if [[ "${DRY_RUN}" != "1" ]]; then
  log "Promotion committed. Removing temporary rollback snapshot ${PROD_BACKUP_SQL}"
  rm -f "${PROD_BACKUP_SQL}"
  find "${TRANSIT_BACKUP_DIR}" -type d -empty -delete
fi

log "Transit promotion complete."
