#!/usr/bin/env python3
"""
Gera data/circuit_images.json — mapa nome-interno-do-Circuit → URL de imagem (wiki.warframe.com).

O duviriCycle.choices da API entrega nomes internos (ex: "AckAndBrunt", "NamiSolo")
para armas e nomes de exibicao para warframes. Este script:
  1. Le o mapa existente (se houver) para nunca perder entradas antigas.
  2. Busca as escolhas ATUAIS do Circuit em api.warframestat.us.
  3. Resolve cada item para uma URL de imagem valida (warframestat search + wiki),
     com excecoes manuais para nomes de arquivo especiais.
  4. Mescla e salva o mapa.
"""

import json
import os
import sys
import urllib.request
import urllib.parse

DATA_DIR = os.environ.get(
    "WFHUB_DATA_DIR",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "data"),
)
OUT_FILE = os.path.join(DATA_DIR, "circuit_images.json")
API_BASE = "https://api.warframestat.us"
WIKI_IMG = "https://wiki.warframe.com/images"

# Nome de exibicao para armas cujo nome interno nao e igual ao nome de busca.
DISPLAY_EXCEPTIONS = {
    "AckAndBrunt": "Ack & Brunt",
    "NamiSolo": "Nami Solo",
    "NamiSkyla": "Nami Skyla",
    "TwinBasolk": "Twin Basolk",
    "DualKamas": "Dual Kamas",
    "DarkSword": "Dark Sword",
    "PangolinSword": "Pangolin Sword",
    "Sibear": "Sibear",
    "Krohkur": "Krohkur",
}

# Excecoes de NOME DE ARQUIVO (quando o arquivo na wiki difere do nome interno).
FILENAME_EXCEPTIONS = {
    "AckAndBrunt": "Ack&Brunt",
}


def http_get_json(url, timeout=20):
    req = urllib.request.Request(url, headers={"User-Agent": "WFHub-update/1.0", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def http_head_ok(url, timeout=15):
    req = urllib.request.Request(url, method="HEAD", headers={"User-Agent": "WFHub-update/1.0"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status == 200
    except Exception:
        return False


def resolve_image(internal_name):
    """Retorna a primeira URL valida para um nome interno do Circuit, ou None."""
    candidates = []
    display = DISPLAY_EXCEPTIONS.get(internal_name, internal_name)

    # 1) warframestat search por nome de exibicao → wikiaThumbnail ou imageName
    try:
        results = http_get_json(f"{API_BASE}/items/search/{urllib.parse.quote(display)}")
        if isinstance(results, list):
            for item in results:
                name = item.get("name", "")
                if name.lower() == display.lower():
                    if item.get("wikiaThumbnail"):
                        candidates.append(item["wikiaThumbnail"])
                    image_name = item.get("imageName")
                    if image_name:
                        candidates.append(f"{WIKI_IMG}/{image_name}")
                    break
    except Exception:
        pass

    # 2) nome de arquivo com excecao, ou o proprio nome interno
    filename = FILENAME_EXCEPTIONS.get(internal_name, internal_name)
    candidates.append(f"{WIKI_IMG}/{filename}.png")
    candidates.append(f"{WIKI_IMG}/{internal_name}.png")

    for url in candidates:
        if http_head_ok(url):
            return url
    return None


def main():
    # Mapa existente (auto-crescimento: nunca perde itens de semanas anteriores)
    merged = {}
    if os.path.exists(OUT_FILE):
        try:
            with open(OUT_FILE, encoding="utf-8") as f:
                existing = json.load(f)
            if isinstance(existing, dict):
                merged = existing
        except Exception:
            merged = {}

    # Escolhas atuais do Circuit
    try:
        ws = http_get_json(f"{API_BASE}/pc/")
        choices = ws.get("duviriCycle", {}).get("choices", [])
    except Exception as e:
        print(f"ERR  nao consegui buscar duviriCycle: {e}")
        choices = []

    pool = []
    for group in choices:
        pool.extend(group.get("choices", []) if isinstance(group, dict) else [])

    if not pool:
        print("warn sem escolhas do Circuit na API; mantendo mapa existente.")
        sys.exit(0)

    added = 0
    for name in dict.fromkeys(pool):  # dedup, preservando ordem
        if name in merged and merged[name]:
            continue
        url = resolve_image(name)
        if url:
            merged[name] = url
            added += 1
            print(f"ok   {name} -> {url}")
        else:
            print(f"warn {name} -> sem imagem")

    if merged:
        with open(OUT_FILE, "w", encoding="utf-8") as f:
            json.dump(merged, f, indent=2, ensure_ascii=False)
            f.write("\n")
        print(f"done {OUT_FILE} ({len(merged)} itens, {added} novos)")
    else:
        print("warn nada para salvar")


if __name__ == "__main__":
    main()
