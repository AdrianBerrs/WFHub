#!/usr/bin/env python3
"""
Gera data/enemyLocations.json a partir dos módulos Lua da wiki do Warframe.
Fonte: Module:Enemies/data/[faction] via MediaWiki API

Uso:
    python3 scripts/build_enemy_locations.py
"""

import json
import os
import re
import subprocess
import sys
import time
from typing import Optional

FACTIONS = [
    "grineer", "corpus", "infestation", "orokin", "sentient",
    "stalker", "narmer", "themurmur", "techrot", "scaldra",
    "anarchs", "unaffiliated",
]

WIKI_API = "https://wiki.warframe.com/api.php"
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR   = os.environ.get("WFHUB_DATA_DIR", os.path.join(SCRIPT_DIR, "..", "..", "data"))


# ─── Fetch ────────────────────────────────────────────────────────────────────

def fetch_wiki_module(title: str) -> Optional[str]:
    url = (
        f"{WIKI_API}?action=query"
        f"&titles={title}"
        f"&prop=revisions&rvprop=content&format=json"
    )
    result = subprocess.run(
        ["curl", "-s", "-A", "Mozilla/5.0 WFHub/1.0", url],
        capture_output=True, text=True, timeout=30
    )
    if result.returncode != 0:
        return None
    try:
        data = json.loads(result.stdout)
        pages = data["query"]["pages"]
        page = next(iter(pages.values()))
        if "revisions" not in page:
            return None
        return page["revisions"][0]["*"]
    except Exception:
        return None


def fetch_module(faction: str) -> Optional[str]:
    url = (
        f"{WIKI_API}?action=query"
        f"&titles=Module:Enemies/data/{faction}"
        f"&prop=revisions&rvprop=content&format=json"
    )
    result = subprocess.run(
        ["curl", "-s", "-A", "Mozilla/5.0 WFHub/1.0", url],
        capture_output=True, text=True, timeout=30
    )
    if result.returncode != 0:
        print(f"  [ERRO] curl falhou para {faction}", file=sys.stderr)
        return None
    try:
        data = json.loads(result.stdout)
        pages = data["query"]["pages"]
        page = next(iter(pages.values()))
        if "revisions" not in page:
            print(f"  [AVISO] módulo não encontrado: {faction}")
            return None
        return page["revisions"][0]["*"]
    except Exception as e:
        print(f"  [ERRO] parse JSON para {faction}: {e}", file=sys.stderr)
        return None


# ─── Lua parser ───────────────────────────────────────────────────────────────

def extract_block(text: str, start: int) -> str:
    """Extrai o conteúdo entre { } a partir de `start` (após o `{`)."""
    depth  = 1
    i      = start
    n      = len(text)
    while i < n and depth > 0:
        c = text[i]
        if c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
        i += 1
    return text[start:i - 1]


def parse_string_field(block: str, field: str) -> Optional[str]:
    m = re.search(rf'\b{field}\s*=\s*"([^"]*)"', block)
    return m.group(1) if m else None


def parse_array_field(block: str, field: str) -> list[str]:
    m = re.search(rf'\b{field}\s*=\s*\{{([^}}]*)\}}', block)
    if not m:
        return []
    raw = m.group(1)
    return [s.strip().strip('"') for s in raw.split(",") if s.strip().strip('"')]


def parse_missions(lua: str) -> dict:
    """Retorna dict: normalize(node_name) -> planet_name."""
    mission_planets: dict = {}
    # Cada entrada tem Name e Planet na mesma linha/bloco inline
    for m in re.finditer(r'Name\s*=\s*"([^"]+)"[^}]*?Planet\s*=\s*"([^"]+)"', lua):
        name, planet = m.group(1), m.group(2)
        mission_planets[normalize(name)] = planet
    return mission_planets


def parse_enemies(lua: str) -> list[dict]:
    enemies = []
    # Encontra cada entrada de inimigo: ["Name"] = {
    for m in re.finditer(r'\["([^"]+)"\]\s*=\s*\{', lua):
        entry_name = m.group(1)
        body_start = m.end()
        body = extract_block(lua, body_start)

        # Encontra o bloco General = { dentro do body
        gm = re.search(r'\bGeneral\s*=\s*\{', body)
        if not gm:
            continue
        general = extract_block(body, gm.end())

        name     = parse_string_field(general, "Name") or entry_name
        faction  = parse_string_field(general, "Faction") or ""
        planets  = parse_array_field(general, "Planets")
        tilesets = parse_array_field(general, "TileSets")
        missions = parse_array_field(general, "Missions")

        enemies.append({
            "canonicalName": name,
            "faction":       faction,
            "planets":       planets,
            "tilesets":      tilesets,
            "missions":      missions,
        })
    return enemies


def normalize(name: str) -> str:
    return " ".join(name.strip().casefold().split())


# ─── Main ─────────────────────────────────────────────────────────────────────

def main():
    result: dict[str, dict] = {}
    total_parsed     = 0
    total_with_planets = 0

    # Carrega mapa missão→planeta do módulo de missões
    print("Buscando Module:Missions/data...", end=" ", flush=True)
    missions_lua = fetch_wiki_module("Module:Missions/data")
    mission_planet_map: dict = {}
    if missions_lua:
        mission_planet_map = parse_missions(missions_lua)
        print(f"{len(mission_planet_map)} nós mapeados")
    else:
        print("falhou — join missão→planeta desativado")
    time.sleep(0.3)

    for faction in FACTIONS:
        print(f"Buscando {faction}...", end=" ", flush=True)
        lua = fetch_module(faction)
        if not lua:
            print("pulado")
            continue

        enemies = parse_enemies(lua)
        print(f"{len(enemies)} inimigos")

        for e in enemies:
            e.setdefault("mission_nodes", [])
            # Join missão→planeta para inimigos sem Planets explícitos
            if not e["planets"] and e.get("missions") and mission_planet_map:
                resolved_planets = []
                resolved_nodes = []
                for mission in e["missions"]:
                    planet = mission_planet_map.get(normalize(mission))
                    if planet:
                        if planet not in resolved_planets:
                            resolved_planets.append(planet)
                        resolved_nodes.append({"node": mission, "planet": planet})
                e["planets"] = resolved_planets
                e["mission_nodes"] = resolved_nodes

            key = normalize(e["canonicalName"])
            # Se já existe (outro módulo tem o mesmo inimigo), mescla planetas
            if key in result:
                existing = result[key]
                merged_planets  = list(dict.fromkeys(existing["planets"]  + e["planets"]))
                merged_tilesets = list(dict.fromkeys(existing["tilesets"] + e["tilesets"]))
                existing["planets"]  = merged_planets
                existing["tilesets"] = merged_tilesets
                # Mescla mission_nodes evitando duplicatas por node name
                seen_nodes = {n["node"] for n in existing["mission_nodes"]}
                for mn in e.get("mission_nodes", []):
                    if mn["node"] not in seen_nodes:
                        existing["mission_nodes"].append(mn)
                        seen_nodes.add(mn["node"])
            else:
                result[key] = e

        total_parsed += len(enemies)
        time.sleep(0.3)  # Ser gentil com a wiki

    total_with_planets = sum(1 for v in result.values() if v["planets"])

    # ── Cobertura contra modLocations.json ────────────────────────────────────
    mod_locs_path = os.path.join(DATA_DIR, "modLocations.json")
    covered = 0
    total_mod_enemies = 0
    unresolved: list[str] = []

    if os.path.exists(mod_locs_path):
        with open(mod_locs_path) as f:
            mod_data = json.load(f)
        mod_enemies: set[str] = set()
        for mod in mod_data.get("modLocations", []):
            for e in mod.get("enemies", []):
                mod_enemies.add(normalize(e["enemyName"]))
        total_mod_enemies = len(mod_enemies)
        for enemy_key in mod_enemies:
            if enemy_key in result:
                covered += 1
            else:
                unresolved.append(enemy_key)
        unresolved.sort()

    # ── Grava JSON ────────────────────────────────────────────────────────────
    out_path = os.path.join(DATA_DIR, "enemyLocations.json")
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2, sort_keys=True)

    # ── Relatório ─────────────────────────────────────────────────────────────
    print()
    print("─" * 50)
    print(f"Total de inimigos parseados : {total_parsed}")
    print(f"Com planetas definidos       : {total_with_planets}")
    print(f"Únicos (chaves no JSON)      : {len(result)}")
    if total_mod_enemies:
        pct = covered / total_mod_enemies * 100
        print(f"Cobertura vs modLocations    : {covered}/{total_mod_enemies} ({pct:.1f}%)")
        print(f"Sem match (unresolved)       : {len(unresolved)}")
        if unresolved:
            print("  Exemplos sem match:")
            for u in unresolved[:10]:
                print(f"    - {u}")
            if len(unresolved) > 10:
                print(f"    ... e mais {len(unresolved) - 10}")
    print(f"\nJSON salvo em: {out_path}")


if __name__ == "__main__":
    main()
