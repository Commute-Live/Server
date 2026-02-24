#!/bin/sh
set -eu

SOURCE_DIR="${1:-$(pwd)/septa}"

if [ ! -d "${SOURCE_DIR}/rail" ] || [ ! -d "${SOURCE_DIR}/bus" ]; then
  echo "ERROR: expected directories:"
  echo "  ${SOURCE_DIR}/rail"
  echo "  ${SOURCE_DIR}/bus"
  exit 1
fi

for mode in rail bus; do
  for file in stops.txt routes.txt route_stops.txt; do
    if [ ! -f "${SOURCE_DIR}/${mode}/${file}" ]; then
      echo "ERROR: missing required file ${SOURCE_DIR}/${mode}/${file}"
      exit 1
    fi
  done
done

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname "$0")" && pwd)"
cd "${SCRIPT_DIR}"

echo "Importing SEPTA core files from: ${SOURCE_DIR}"
bun run src/scripts/septa_import_core_local.ts "${SOURCE_DIR}"
