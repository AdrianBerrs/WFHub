#!/usr/bin/env python3
"""
Fetches ducat values for all prime parts from warframe.market API.
Writes data/ducat_values.json as { "Part Name": ducat_int }.

Usage: /usr/bin/python3 scripts/data/build_ducat_values.py
"""
import json
import os
import pathlib
import urllib.request

ROOT = pathlib.Path(__file__).parent.parent.parent
DATA = pathlib.Path(os.environ.get("WFHUB_DATA_DIR", ROOT / "data"))


def fetch_all_items():
    url = "https://api.warframe.market/v2/items"
    req = urllib.request.Request(url, headers={
        "Accept": "application/json",
        "User-Agent": "Mozilla/5.0",
    })
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8", errors="replace"))


def main():
    print("Fetching items from warframe.market...")
    data = fetch_all_items()
    items = data.get("data", [])

    prime_parts = set(json.loads((DATA / "prime_parts.json").read_text()))

    # Build API name → ducats, also indexing without " Blueprint" suffix
    # (prime_parts.json stores warframe components as "Ash Prime Chassis",
    # but the market API calls them "Ash Prime Chassis Blueprint")
    api_map: dict[str, int] = {}
    for item in items:
        name = item.get("i18n", {}).get("en", {}).get("name", "")
        ducats = item.get("ducats")
        if ducats and name:
            api_map[name] = ducats
            if name.endswith(" Blueprint"):
                api_map[name[: -len(" Blueprint")]] = ducats

    ducat_map = {}
    for part in prime_parts:
        ducat_map[part] = api_map.get(part, 0)

    missing = [p for p in prime_parts if ducat_map[p] == 0]
    if missing:
        print(f"WARNING: {len(missing)} parts have no ducat value, defaulting to 0")

    out = DATA / "ducat_values.json"
    out.write_text(json.dumps(ducat_map, indent=2, ensure_ascii=False, sort_keys=True))
    print(f"Wrote {len(ducat_map)} ducat entries -> {out}")


if __name__ == "__main__":
    main()
