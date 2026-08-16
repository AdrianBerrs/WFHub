#!/usr/bin/env python3
"""
Convert data/rivenWeaponRulesSource_{class}.csv → data/rivenWeaponRules.json

CSV format (from morrowshore spreadsheet, one file per weapon class):
  col 0: weapon name (lowercase)
  col 1: positive stats string
  col N: negative stats string  ← detected from header ("NEGATIVE STATS:")

Output structure:
  {
    "primary":   { "weapon": { "prefer": [...], "freeNegatives": [...] }, ... },
    "secondary": { ... },
    "melee":     { ... },
    "archgun":   { ... },
    "robotic":   { ... }
  }
"""

import csv
import json
import os
import re

CLASSES = ["primary", "secondary", "melee", "archgun", "robotic"]

ABBREV = {
    # ranged — universal
    "CD":     "critical_damage",
    "MS":     "multishot",
    "CC":     "critical_chance",
    "DMG":    "damage",
    "FR":     "fire_rate",
    "TOX":    "toxin",
    "HEAT":   "heat",
    "COLD":   "cold",
    "ELEC":   "electricity",
    "SC":     "status_chance",
    "SD":     "status_duration",
    "PT":     "punch_through",
    "RLS":    "reload_speed",
    "MAG":    "magazine",
    "AMMO":   "max_ammo",
    "PFS":    "projectile_speed",
    "SLASH":  "slash",
    "REC":    "recoil",
    "RECOIL": "recoil",
    "ZOOM":   "zoom",
    "IMP":    "impact",
    "PUNC":   "puncture",
    # melee / robotic
    "AS":     "attack_speed",
    "RANGE":  "range",
    "EFF":    "heavy_attack_efficiency",
    "IC":     "initial_combo",
    "SLIDE":  "slide_attack",
    "FIN":    "finisher_damage",
    # generic / faction — ignored
    "ELEMENT": None,
    "DTI":    None,
    "DTG":    None,
    "DTC":    None,
}


def parse_stat_string(raw: str) -> list[str]:
    """Parse slash/space separated stat tokens into a deduped flat list."""
    if not raw or not raw.strip():
        return []
    seen: list[str] = []
    seen_set: set[str] = set()
    tokens = re.split(r'\bor\b|[/\s]+', raw, flags=re.IGNORECASE)
    for tok in tokens:
        tok = tok.strip().upper()
        if not tok:
            continue
        key = ABBREV.get(tok)
        if key is None:
            continue
        if key not in seen_set:
            seen.append(key)
            seen_set.add(key)
    return seen


def parse_positive_patterns(raw: str) -> tuple[list[dict], list[str]]:
    """
    Parse strings like:
      'CD MS/TOX/DMG/FR/CC/PT'
      'CC MS FR/CD/DMG/HEAT'
      'CD AS RANGE or CD/RANGE AS ELEC'

    into pattern objects that preserve:
      - must-have stats (space-separated single tokens)
      - alternative groups (slash-separated tokens inside one segment)

    Returns (patterns, flattened_prefer_list).
    """
    if not raw or not raw.strip():
        return [], []

    patterns: list[dict] = []
    prefer_flat: list[str] = []
    prefer_seen: set[str] = set()

    for roll_raw in re.split(r'\bor\b', raw, flags=re.IGNORECASE):
        roll = roll_raw.strip()
        if not roll:
            continue

        must: list[str] = []
        groups: list[list[str]] = []

        for segment in re.split(r'\s+', roll):
            segment = segment.strip()
            if not segment:
                continue
            options: list[str] = []
            option_seen: set[str] = set()
            for tok in segment.split('/'):
                tok = tok.strip().upper()
                if not tok:
                    continue
                key = ABBREV.get(tok)
                if key is None or key in option_seen:
                    continue
                options.append(key)
                option_seen.add(key)
                if key not in prefer_seen:
                    prefer_flat.append(key)
                    prefer_seen.add(key)

            if not options:
                continue
            if len(options) == 1:
                must.append(options[0])
            else:
                groups.append(options)

        if must or groups:
            patterns.append({
                "must": must,
                "groups": groups,
            })

    return patterns, prefer_flat


def find_neg_col(header: list[str]) -> int:
    """Return the column index of 'NEGATIVE STATS:' in the header row."""
    for i, cell in enumerate(header):
        if "NEGATIVE" in cell.upper():
            return i
    return 5  # fallback


def load_class_csv(path: str) -> dict:
    weapons: dict = {}
    with open(path, newline="", encoding="utf-8") as f:
        reader = csv.reader(f)
        header = next(reader)
        neg_col = find_neg_col(header)
        for row in reader:
            if not row or not row[0].strip():
                continue
            weapon = row[0].strip().lower()
            positive_raw = row[1].strip() if len(row) > 1 else ""
            negative_raw = row[neg_col].strip() if len(row) > neg_col else ""
            positive_patterns, prefer = parse_positive_patterns(positive_raw)
            free_negs = parse_stat_string(negative_raw)
            if weapon:
                weapons[weapon] = {
                    "prefer": prefer,
                    "positivePatterns": positive_patterns,
                    "freeNegatives": free_negs,
                }
    return weapons


def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    data_dir = os.path.join(script_dir, "..", "..", "data")
    dst = os.path.join(data_dir, "rivenWeaponRules.json")

    result: dict = {}
    for cls in CLASSES:
        src = os.path.join(data_dir, f"rivenWeaponRulesSource_{cls}.csv")
        if os.path.exists(src):
            weapons = load_class_csv(src)
            result[cls] = weapons
            print(f"  {cls}: {len(weapons)} weapons")
        else:
            result[cls] = {}
            print(f"  {cls}: (no CSV found, empty)")

    with open(dst, "w", encoding="utf-8") as f:
        json.dump(result, f, indent=2, ensure_ascii=False)

    total = sum(len(v) for v in result.values())
    print(f"\nGenerated {dst} — {total} weapons total.")


if __name__ == "__main__":
    main()
