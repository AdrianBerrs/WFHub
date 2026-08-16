#!/usr/bin/env python3
"""
Gera versões craftadas das peças de warframe no prime_parts.json.

Para cada sub-blueprint de warframe (ex: "Ash Prime Chassis Blueprint"),
adiciona a versão craftada correspondente (ex: "Ash Prime Chassis").

Rodar sempre que um novo warframe prime for adicionado ao jogo:
    /usr/bin/python3 update_prime_parts.py
"""
import json
import os
import re
import pathlib

data_dir = pathlib.Path(
    os.environ.get(
        "WFHUB_DATA_DIR",
        str(pathlib.Path(__file__).resolve().parent.parent.parent / "data"),
    )
)
parts_file = data_dir / "prime_parts.json"

parts: list[str] = json.loads(parts_file.read_text())

# Sub-blueprint: termina em "<ComponentName> Blueprint"
# Exclui o main blueprint "X Prime Blueprint" (componente é só "Blueprint")
SUB_BP = re.compile(r"\b(Chassis|Neuroptics|Systems|Harness|Wings) Blueprint$")

crafted: list[str] = []
for p in parts:
    if SUB_BP.search(p):
        crafted.append(p.removesuffix(" Blueprint"))

before = len(parts)
all_parts = sorted(set(parts + crafted))
added = len(all_parts) - before

parts_file.write_text(json.dumps(all_parts, indent=2, ensure_ascii=False) + "\n")
print(f"Adicionadas {added} peças craftadas. Total: {len(all_parts)} entradas.")
