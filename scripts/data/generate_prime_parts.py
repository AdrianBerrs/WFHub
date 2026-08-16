#!/usr/bin/env python3
"""
Generates data/prime_parts.json from relics.json.

Extracts every unique prime part name that appears as a relic reward (Intact state).
For every name ending in " Blueprint", also adds the crafted form (without " Blueprint"),
so the OCR fuzzy matcher can identify both blueprints and already-crafted components.

Usage: /usr/bin/python3 scripts/generate_prime_parts.py
"""
import json
import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
DATA = ROOT / "data"

with open(DATA / "relics.json", encoding="utf-8") as f:
    data = json.load(f)

seen: set[str] = set()
parts: list[str] = []

for relic in data["relics"]:
    if relic.get("state") != "Intact":
        continue
    for reward in relic.get("rewards", []):
        name = reward.get("itemName", "").strip()
        if not name or "Prime" not in name:
            continue
        if name not in seen:
            seen.add(name)
            parts.append(name)

parts.sort()
output = DATA / "prime_parts.json"
with open(output, "w", encoding="utf-8") as f:
    json.dump(parts, f, indent=2, ensure_ascii=False)

blueprints = sum(1 for p in parts if p.endswith(" Blueprint"))
direct     = len(parts) - blueprints
print(f"Generated {len(parts)} entries ({blueprints} blueprints + {direct} direct components) → {output}")
