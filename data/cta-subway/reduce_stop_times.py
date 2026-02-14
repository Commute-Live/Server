#!/usr/bin/env python3
import argparse
import csv
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Reduce GTFS stop_times.csv to only the columns needed for line/stop mapping."
    )
    parser.add_argument("input", help="Path to input stop_times.txt")
    parser.add_argument("output", help="Path to output reduced CSV")
    parser.add_argument(
        "--dedupe",
        action="store_true",
        help="Keep only unique (trip_id, stop_id) rows",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    input_path = Path(args.input)
    output_path = Path(args.output)

    if not input_path.exists():
        raise FileNotFoundError(f"Input file not found: {input_path}")
    if input_path.resolve() == output_path.resolve():
        raise ValueError("Input and output must be different files")

    output_path.parent.mkdir(parents=True, exist_ok=True)

    with input_path.open("r", newline="", encoding="utf-8") as fin, output_path.open(
        "w", newline="", encoding="utf-8"
    ) as fout:
        reader = csv.DictReader(fin)
        fieldnames = ["trip_id", "stop_id"]
        writer = csv.DictWriter(fout, fieldnames=fieldnames)
        writer.writeheader()

        if reader.fieldnames is None:
            raise ValueError("Missing CSV header")
        if "trip_id" not in reader.fieldnames or "stop_id" not in reader.fieldnames:
            raise ValueError("CSV must include trip_id and stop_id columns")

        seen: set[tuple[str, str]] = set()
        rows_in = 0
        rows_out = 0

        for row in reader:
            rows_in += 1
            trip_id = (row.get("trip_id") or "").strip()
            stop_id = (row.get("stop_id") or "").strip()
            if not trip_id or not stop_id:
                continue

            if args.dedupe:
                key = (trip_id, stop_id)
                if key in seen:
                    continue
                seen.add(key)

            writer.writerow({"trip_id": trip_id, "stop_id": stop_id})
            rows_out += 1

    print(f"Input rows: {rows_in}")
    print(f"Output rows: {rows_out}")
    print(f"Wrote: {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
