#!/usr/bin/env python3
"""Build data/items_prices.json from multiple sources.

1. Prime parts: merge prices.json (avg) + ducat_values.json (ducats)
2. Mods: fetch warframe.market API for buy/sell
3. Arcanes: same as mods

Respects rate limit (2 req/s). Merges with existing items_prices.json
to avoid losing data on partial failures.
"""

import json
import os
import sys
import time
from datetime import datetime, timezone

import requests

API_BASE = "https://api.warframe.market/v2"
RATE_LIMIT_S = 0.55  # ~1.8 req/s (safe margin)

DATA_DIR = os.environ.get(
    "WFHUB_DATA_DIR",
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "data")),
)
TMP_DIR = "/tmp"

session = requests.Session()
session.headers.update({"Accept": "application/json", "User-Agent": "WFHub/1.0"})
session.timeout = 15


def log(msg: str) -> None:
    print(msg, flush=True)


def load_json(path: str):
    with open(path) as f:
        return json.load(f)


def fetch_market_top(slug: str, retries: int = 3) -> tuple:
    """Returns (buy_price, sell_price) or (None, None)."""
    url = f"{API_BASE}/orders/item/{slug}/top"
    for attempt in range(retries):
        try:
            resp = session.get(url)
            if resp.status_code == 200:
                data = resp.json().get("data", {})
                buy = data.get("buy", [{}])[0].get("platinum") if data.get("buy") else None
                sell = data.get("sell", [{}])[0].get("platinum") if data.get("sell") else None
                return (buy, sell)
            err = resp.text[:200] if resp.text else "unknown"
            log(f"  ⚠ HTTP {resp.status_code}: {err}")
        except Exception as e:
            if attempt < retries - 1:
                log(f"  ⚠ retry {attempt + 1}/{retries}: {e}")
                time.sleep(1)
    return (None, None)


def build_name_slug_map(items_list: list) -> dict:
    return {entry["name"].lower(): entry["slug"] for entry in items_list}


def main():
    # ── Load source files ──
    log("Loading source files...")
    items_list = load_json(os.path.join(DATA_DIR, "items_list.json"))
    mods = load_json(os.path.join(DATA_DIR, "mods_all.json"))
    arcane_images = load_json(os.path.join(DATA_DIR, "arcane_images.json"))
    arcanes = [
        entry.get("name")
        for entry in arcane_images.values()
        if entry.get("name")
    ]
    prices = load_json(os.path.join(DATA_DIR, "prices.json"))
    ducats = load_json(os.path.join(DATA_DIR, "ducat_values.json"))
    name_to_slug = build_name_slug_map(items_list)

    # ── Load existing items_prices.json for merge ──
    items_prices = {}
    existing_path = os.path.join(DATA_DIR, "items_prices.json")
    if os.path.exists(existing_path):
        try:
            items_prices = load_json(existing_path)
            log(f"Loaded existing items_prices.json ({len(items_prices)} entries)")
        except Exception as e:
            log(f"⚠ Could not read existing items_prices.json: {e}")

    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # ── 1. Prime parts ──
    log(f"\n[1/3] Merging prime parts ({len(prices)} prices, {len(ducats)} ducats)...")
    for entry in prices:
        name = entry["name"]
        avg_raw = entry.get("custom_avg")
        avg = float(avg_raw) if avg_raw else None

        existing = items_prices.get(name, {})
        items_prices[name] = {
            "avg": avg,
            "buy": existing.get("buy"),
            "sell": existing.get("sell"),
            "ducats": ducats.get(name),
            "updated_at": existing.get("updated_at"),
        }

    # ── 2. Mods ──
    mod_slugs = []
    for mod_name in mods:
        slug = name_to_slug.get(mod_name.lower())
        if slug:
            mod_slugs.append((mod_name, slug))
    log(f"\n[2/3] Fetching mod prices ({len(mod_slugs)} items at ~1.8 req/s)...")

    for i, (name, slug) in enumerate(mod_slugs, 1):
        log(f"  [{i}/{len(mod_slugs)}] {name}")
        buy, sell = fetch_market_top(slug)

        existing = items_prices.get(name, {"avg": None, "buy": None, "sell": None, "ducats": None})
        items_prices[name] = {
            "avg": existing.get("avg"),
            "buy": buy if buy is not None else existing.get("buy"),
            "sell": sell if sell is not None else existing.get("sell"),
            "ducats": existing.get("ducats"),
            "updated_at": now,
        }
        time.sleep(RATE_LIMIT_S)

    # ── 3. Arcanes ──
    arcane_slugs = []
    for arc_name in arcanes:
        slug = name_to_slug.get(arc_name.lower())
        if slug:
            arcane_slugs.append((arc_name, slug))
    log(f"\n[3/3] Fetching arcane prices ({len(arcane_slugs)} items)...")

    for i, (name, slug) in enumerate(arcane_slugs, 1):
        log(f"  [{i}/{len(arcane_slugs)}] {name}")
        buy, sell = fetch_market_top(slug)

        existing = items_prices.get(name, {"avg": None, "buy": None, "sell": None, "ducats": None})
        items_prices[name] = {
            "avg": existing.get("avg"),
            "buy": buy if buy is not None else existing.get("buy"),
            "sell": sell if sell is not None else existing.get("sell"),
            "ducats": existing.get("ducats"),
            "updated_at": now,
        }
        time.sleep(RATE_LIMIT_S)

    # ── Write atomically ──
    log(f"\nWriting {len(items_prices)} entries to items_prices.json...")
    tmp_path = os.path.join(TMP_DIR, ".items_prices.json.tmp")
    with open(tmp_path, "w") as f:
        json.dump(items_prices, f, indent=2, ensure_ascii=False)
    os.replace(tmp_path, existing_path)
    log("Done.")


if __name__ == "__main__":
    main()
