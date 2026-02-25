#!/usr/bin/env python3
import argparse
import json
import sys
import unicodedata
from pathlib import Path


def normalize_name(name: str) -> str:
    """
    Normalize names so duplicates like:
      " José  Pérez " == "jose perez"
      "Ángel" == "Angel"
    collapse together.
    """
    if name is None:
        return ""
    name = str(name).strip()
    name = " ".join(name.split())  # collapse whitespace
    name = unicodedata.normalize("NFKD", name)
    name = "".join(ch for ch in name if not unicodedata.combining(ch))  # remove accents
    return name.lower()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", default="data/athletes.json", help="Path to athletes.json")
    ap.add_argument("--output", default="data/athletes.json", help="Where to write the deduped file")
    ap.add_argument(
        "--report",
        default="data/athletes_dedupe_report.json",
        help="Write details of removed duplicates here",
    )
    args = ap.parse_args()

    in_path = Path(args.input)
    out_path = Path(args.output)
    report_path = Path(args.report)

    if not in_path.exists():
        print(f"[dedupe] Input file not found: {in_path}", file=sys.stderr)
        return 2

    try:
        data = json.loads(in_path.read_text(encoding="utf-8"))
    except Exception as e:
        print(f"[dedupe] Failed to parse JSON: {e}", file=sys.stderr)
        return 3

    if not isinstance(data, list):
        print("[dedupe] Expected athletes.json to be a JSON list.", file=sys.stderr)
        return 4

    seen = {}  # normalized_name -> kept_index
    kept = []
    removed = []

    for idx, athlete in enumerate(data):
        name = athlete.get("name", "") if isinstance(athlete, dict) else ""
        norm = normalize_name(name)

        # If no name, keep it (can't safely dedupe)
        if not norm:
            kept.append(athlete)
            continue

        # Keep the oldest = first seen occurrence
        if norm not in seen:
            seen[norm] = idx
            kept.append(athlete)
        else:
            removed.append(
                {
                    "normalized": norm,
                    "kept_original_index": seen[norm],
                    "removed_original_index": idx,
                    "kept_name": (data[seen[norm]].get("name") if isinstance(data[seen[norm]], dict) else ""),
                    "removed_name": name,
                }
            )

    # Write outputs
    out_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.parent.mkdir(parents=True, exist_ok=True)

    out_path.write_text(json.dumps(kept, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    report = {
        "input": str(in_path),
        "output": str(out_path),
        "total_before": len(data),
        "total_after": len(kept),
        "removed_count": len(removed),
        "removed": removed,
    }
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    if removed:
        print(f"[dedupe] ✅ Deduped by name. Removed {len(removed)} duplicate(s). Kept oldest entries.")
        print(f"[dedupe] Report: {report_path}")
    else:
        print("[dedupe] ✅ No duplicates found. No changes made (content may be rewritten identically).")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
