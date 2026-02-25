#!/bin/sh
set -eu

SOURCE_DIR="${1:-$(pwd)/mta}"

require_mode_files() {
  mode="$1"
  for file in stops.txt routes.txt trips.txt stop_times.txt; do
    if [ ! -f "${SOURCE_DIR}/${mode}/${file}" ]; then
      echo "ERROR: missing required file ${SOURCE_DIR}/${mode}/${file}"
      exit 1
    fi
  done
}

require_mode_files subway
require_mode_files lirr
require_mode_files mnr

BUS_ROOT="${SOURCE_DIR}/bus"
if [ ! -d "${BUS_ROOT}" ]; then
  echo "ERROR: expected directory ${BUS_ROOT}"
  exit 1
fi

bus_ok=0
if [ -f "${BUS_ROOT}/stops.txt" ] && [ -f "${BUS_ROOT}/routes.txt" ] && [ -f "${BUS_ROOT}/trips.txt" ] && [ -f "${BUS_ROOT}/stop_times.txt" ]; then
  bus_ok=1
else
  for d in "${BUS_ROOT}"/*; do
    [ -d "${d}" ] || continue
    if [ -f "${d}/stops.txt" ] && [ -f "${d}/routes.txt" ] && [ -f "${d}/trips.txt" ] && [ -f "${d}/stop_times.txt" ]; then
      bus_ok=1
      break
    fi
  done
fi

if [ "${bus_ok}" -ne 1 ]; then
  echo "ERROR: expected bus feed files under ${BUS_ROOT}"
  echo "Either provide ${BUS_ROOT}/stops.txt routes.txt trips.txt stop_times.txt"
  echo "Or provide one or more subdirs each containing those files."
  exit 1
fi

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
cd "${SCRIPT_DIR}"

echo "Importing MTA core files from: ${SOURCE_DIR}"
bun run src/scripts/mta_import_core_local.ts "${SOURCE_DIR}"
