#!/bin/bash
set -euo pipefail

ROOT_DIR="$(CDPATH= cd -- "$(dirname "$0")/../.." && pwd)"
DATA_DIR="${ROOT_DIR}/data"
DOWNLOAD_DIR="${DATA_DIR}/downloads"
WORK_DIR="$(mktemp -d "/tmp/all-core-gtfs-download-XXXXXX")"
SCRIPT_STARTED_AT="$(date +%s)"

MTA_SUBWAY_GTFS_URL="${MTA_SUBWAY_GTFS_URL:-https://rrgtfsfeeds.s3.amazonaws.com/gtfs_supplemented.zip}"
MTA_LIRR_GTFS_URL="${MTA_LIRR_GTFS_URL:-https://rrgtfsfeeds.s3.amazonaws.com/gtfslirr.zip}"
MTA_MNR_GTFS_URL="${MTA_MNR_GTFS_URL:-https://rrgtfsfeeds.s3.amazonaws.com/gtfsmnr.zip}"
MTA_BUS_BX_GTFS_URL="${MTA_BUS_BX_GTFS_URL:-https://rrgtfsfeeds.s3.amazonaws.com/gtfs_bx.zip}"
MTA_BUS_B_GTFS_URL="${MTA_BUS_B_GTFS_URL:-https://rrgtfsfeeds.s3.amazonaws.com/gtfs_b.zip}"
MTA_BUS_M_GTFS_URL="${MTA_BUS_M_GTFS_URL:-https://rrgtfsfeeds.s3.amazonaws.com/gtfs_m.zip}"
MTA_BUS_Q_GTFS_URL="${MTA_BUS_Q_GTFS_URL:-https://rrgtfsfeeds.s3.amazonaws.com/gtfs_q.zip}"
MTA_BUS_SI_GTFS_URL="${MTA_BUS_SI_GTFS_URL:-https://rrgtfsfeeds.s3.amazonaws.com/gtfs_si.zip}"
MTA_BUS_BUSCO_GTFS_URL="${MTA_BUS_BUSCO_GTFS_URL:-https://rrgtfsfeeds.s3.amazonaws.com/gtfs_busco.zip}"
SEPTA_GTFS_URL="${SEPTA_GTFS_URL:-https://www3.septa.org/developer/gtfs_public.zip}"
CTA_GTFS_URL="${CTA_GTFS_URL:-https://www.transitchicago.com/downloads/sch_data/google_transit.zip}"
MBTA_GTFS_URL="${MBTA_GTFS_URL:-https://cdn.mbta.com/MBTA_GTFS.zip}"
OPEN511_API_KEY="${OPEN511_API_KEY:-}"
BAYAREA_OPERATOR_ID="${BAYAREA_OPERATOR_ID:-RG}"
BAYAREA_GTFS_URL="${BAYAREA_GTFS_URL:-}"

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

require_command() {
  local cmd="$1"
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "ERROR: required command not found: ${cmd}"
    exit 1
  fi
}

reset_dir() {
  local dir="$1"
  rm -rf "${dir}"
  mkdir -p "${dir}"
}

download_zip() {
  local url="$1"
  local out_zip="$2"
  local label="$3"

  log "Downloading ${label}: ${url}"
  rm -f "${out_zip}"
  curl -fL --retry 3 --connect-timeout 20 --max-time 900 "${url}" -o "${out_zip}"
}

extract_zip() {
  local zip_path="$1"
  local out_dir="$2"
  reset_dir "${out_dir}"
  unzip -oq "${zip_path}" -d "${out_dir}"
}

find_dataset_dir() {
  local root="$1"
  shift
  local required=("$@")

  while IFS= read -r -d '' d; do
    local ok="1"
    local file
    for file in "${required[@]}"; do
      if [[ ! -f "${d}/${file}" ]]; then
        ok="0"
        break
      fi
    done
    if [[ "${ok}" == "1" ]]; then
      printf '%s\n' "${d}"
      return 0
    fi
  done < <(find "${root}" -type d -print0 2>/dev/null)

  return 1
}

copy_dir_contents() {
  local src="$1"
  local dst="$2"
  reset_dir "${dst}"
  cp -a "${src}/." "${dst}/"
}

verify_files() {
  local root="$1"
  shift
  local required=("$@")
  local file
  for file in "${required[@]}"; do
    if [[ ! -f "${root}/${file}" ]]; then
      echo "ERROR: Missing required file ${file} in ${root}"
      exit 1
    fi
  done
}

download_mta() {
  log "[1/5] Downloading MTA GTFS feeds"
  mkdir -p "${DATA_DIR}/mta"

  local keys=("subway" "lirr" "mnr" "bus_bx" "bus_b" "bus_m" "bus_q" "bus_si" "bus_busco")
  local urls=(
    "${MTA_SUBWAY_GTFS_URL}"
    "${MTA_LIRR_GTFS_URL}"
    "${MTA_MNR_GTFS_URL}"
    "${MTA_BUS_BX_GTFS_URL}"
    "${MTA_BUS_B_GTFS_URL}"
    "${MTA_BUS_M_GTFS_URL}"
    "${MTA_BUS_Q_GTFS_URL}"
    "${MTA_BUS_SI_GTFS_URL}"
    "${MTA_BUS_BUSCO_GTFS_URL}"
  )

  local i
  for i in "${!keys[@]}"; do
    local key="${keys[$i]}"
    local url="${urls[$i]}"
    local zip_path="${DOWNLOAD_DIR}/mta_${key}.zip"
    local extract_dir="${WORK_DIR}/mta_${key}_extract"
    local dataset_dir
    local target_dir="${DATA_DIR}/mta/${key}"

    download_zip "${url}" "${zip_path}" "mta_${key}"
    extract_zip "${zip_path}" "${extract_dir}"
    dataset_dir="$(find_dataset_dir "${extract_dir}" stops.txt routes.txt trips.txt stop_times.txt || true)"
    if [[ -z "${dataset_dir}" ]]; then
      echo "ERROR: Could not locate MTA dataset for ${key} (needs stops/routes/trips/stop_times)"
      exit 1
    fi

    copy_dir_contents "${dataset_dir}" "${target_dir}"
    verify_files "${target_dir}" stops.txt routes.txt trips.txt stop_times.txt
    log "MTA ${key}: saved to ${target_dir}"
  done
}

download_septa() {
  log "[2/5] Downloading SEPTA GTFS feed"
  mkdir -p "${DATA_DIR}/septa"

  local zip_path="${DOWNLOAD_DIR}/septa_gtfs_public.zip"
  local outer_dir="${WORK_DIR}/septa_outer"
  local bus_root="${WORK_DIR}/septa_bus_root"
  local rail_root="${WORK_DIR}/septa_rail_root"
  local bus_dataset
  local rail_dataset

  download_zip "${SEPTA_GTFS_URL}" "${zip_path}" "septa_gtfs_public"
  extract_zip "${zip_path}" "${outer_dir}"

  if [[ -f "${outer_dir}/google_bus.zip" ]]; then
    extract_zip "${outer_dir}/google_bus.zip" "${bus_root}"
  elif [[ -d "${outer_dir}/google_bus" ]]; then
    copy_dir_contents "${outer_dir}/google_bus" "${bus_root}"
  else
    echo "ERROR: google_bus.zip (or extracted google_bus/) not found in SEPTA feed"
    exit 1
  fi

  if [[ -f "${outer_dir}/google_rail.zip" ]]; then
    extract_zip "${outer_dir}/google_rail.zip" "${rail_root}"
  elif [[ -d "${outer_dir}/google_rail" ]]; then
    copy_dir_contents "${outer_dir}/google_rail" "${rail_root}"
  else
    echo "ERROR: google_rail.zip (or extracted google_rail/) not found in SEPTA feed"
    exit 1
  fi

  bus_dataset="$(find_dataset_dir "${bus_root}" stops.txt routes.txt route_stops.txt || true)"
  rail_dataset="$(find_dataset_dir "${rail_root}" stops.txt routes.txt route_stops.txt || true)"
  if [[ -z "${bus_dataset}" || -z "${rail_dataset}" ]]; then
    echo "ERROR: Could not locate SEPTA bus/rail datasets with stops/routes/route_stops"
    exit 1
  fi

  copy_dir_contents "${bus_dataset}" "${DATA_DIR}/septa/google_bus"
  copy_dir_contents "${rail_dataset}" "${DATA_DIR}/septa/google_rail"
  verify_files "${DATA_DIR}/septa/google_bus" stops.txt routes.txt route_stops.txt
  verify_files "${DATA_DIR}/septa/google_rail" stops.txt routes.txt route_stops.txt
  log "SEPTA bus:  saved to ${DATA_DIR}/septa/google_bus"
  log "SEPTA rail: saved to ${DATA_DIR}/septa/google_rail"
}

download_cta() {
  log "[3/5] Downloading CTA GTFS feed"
  mkdir -p "${DATA_DIR}/cta"

  local zip_path="${DOWNLOAD_DIR}/cta_gtfs.zip"
  local extract_dir="${WORK_DIR}/cta_extract"
  local dataset_dir

  download_zip "${CTA_GTFS_URL}" "${zip_path}" "cta_gtfs"
  extract_zip "${zip_path}" "${extract_dir}"
  dataset_dir="$(find_dataset_dir "${extract_dir}" stops.txt routes.txt trips.txt stop_times.txt || true)"
  if [[ -z "${dataset_dir}" ]]; then
    echo "ERROR: Could not locate CTA dataset (needs stops/routes/trips/stop_times)"
    exit 1
  fi

  copy_dir_contents "${dataset_dir}" "${DATA_DIR}/cta"
  verify_files "${DATA_DIR}/cta" stops.txt routes.txt trips.txt stop_times.txt
  log "CTA: saved to ${DATA_DIR}/cta"
}

download_mbta() {
  log "[4/5] Downloading MBTA GTFS feed"
  mkdir -p "${DATA_DIR}/mbta"

  local zip_path="${DOWNLOAD_DIR}/mbta_gtfs.zip"
  local extract_dir="${WORK_DIR}/mbta_extract"
  local dataset_dir

  download_zip "${MBTA_GTFS_URL}" "${zip_path}" "mbta_gtfs"
  extract_zip "${zip_path}" "${extract_dir}"
  dataset_dir="$(find_dataset_dir "${extract_dir}" stops.txt routes.txt trips.txt stop_times.txt || true)"
  if [[ -z "${dataset_dir}" ]]; then
    echo "ERROR: Could not locate MBTA dataset (needs stops/routes/trips/stop_times)"
    exit 1
  fi

  copy_dir_contents "${dataset_dir}" "${DATA_DIR}/mbta"
  verify_files "${DATA_DIR}/mbta" stops.txt routes.txt trips.txt stop_times.txt
  log "MBTA: saved to ${DATA_DIR}/mbta"
}

download_bayarea() {
  log "[5/5] Downloading Bay Area regional GTFS feed"
  mkdir -p "${DATA_DIR}/bayarea"

  if [[ -z "${OPEN511_API_KEY}" ]]; then
    echo "ERROR: OPEN511_API_KEY is required for Bay Area download"
    exit 1
  fi

  local zip_path="${DOWNLOAD_DIR}/bayarea_gtfs.zip"
  local extract_dir="${WORK_DIR}/bayarea_extract"
  local dataset_dir

  download_zip "${BAYAREA_GTFS_URL}" "${zip_path}" "bayarea_gtfs"
  extract_zip "${zip_path}" "${extract_dir}"
  dataset_dir="$(find_dataset_dir "${extract_dir}" stops.txt routes.txt trips.txt stop_times.txt || true)"
  if [[ -z "${dataset_dir}" ]]; then
    echo "ERROR: Could not locate Bay Area dataset (needs stops/routes/trips/stop_times)"
    exit 1
  fi

  copy_dir_contents "${dataset_dir}" "${DATA_DIR}/bayarea"
  verify_files "${DATA_DIR}/bayarea" stops.txt routes.txt trips.txt stop_times.txt
  log "Bay Area: saved to ${DATA_DIR}/bayarea"
}

require_command curl
require_command unzip
require_command find

if [[ -f "${ROOT_DIR}/.env" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "${ROOT_DIR}/.env"
  set +a
fi

OPEN511_API_KEY="${OPEN511_API_KEY:-}"
BAYAREA_OPERATOR_ID="${BAYAREA_OPERATOR_ID:-RG}"
if [[ -z "${BAYAREA_GTFS_URL}" ]]; then
  BAYAREA_GTFS_URL="https://api.511.org/transit/datafeeds?api_key=${OPEN511_API_KEY}&operator_id=${BAYAREA_OPERATOR_ID}"
fi

mkdir -p "${DOWNLOAD_DIR}"

download_mta
download_septa
download_cta
download_mbta
download_bayarea

log "All 5 city downloads completed in $(( $(date +%s) - SCRIPT_STARTED_AT ))s"
log "Downloads: ${DOWNLOAD_DIR}"
log "Extracted datasets: ${DATA_DIR}/mta ${DATA_DIR}/septa ${DATA_DIR}/cta ${DATA_DIR}/mbta ${DATA_DIR}/bayarea"
