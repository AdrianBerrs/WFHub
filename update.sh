#!/usr/bin/env sh
DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="${WFHUB_DATA_DIR:-$DIR/data}"
PYTHON="${WFHUB_PYTHON:-/usr/bin/python3}"
mkdir -p "$DATA_DIR"

# Baixa para arquivo temporario, valida JSON e conteudo, so entao sobrescreve o destino.
# Evita corromper prices.json (etc) quando o upstream retorna 503/HTML/error-JSON.
# Tambem trata como "ausente" arquivos destino que ja foram corrompidos com error-JSON.
# Uso: fetch_json <url> <dest> [jq_filter] [validate_expr]
#   validate_expr: expressao jq que deve retornar true (default: aceita array nao-vazio
#                  ou objeto sem chave "error" no topo)
fetch_json() {
    url="$1"
    dest="$2"
    filter="${3:-.}"
    validate="${4:-(type == \"array\" and length > 0) or (type == \"object\" and has(\"error\") | not)}"

    tmp="$(mktemp)"
    http_code=$(curl -sS -o "$tmp" -w "%{http_code}" \
        -H "User-Agent: Mozilla/5.0" -H "Accept: application/json" \
        "$url" 2>/dev/null)

    ok=0
    if [ "$http_code" = "200" ] && [ -s "$tmp" ]; then
        filtered="$(mktemp)"
        if jq "$filter" "$tmp" > "$filtered" 2>/dev/null \
            && [ -s "$filtered" ] \
            && jq -e "$validate" "$filtered" >/dev/null 2>&1; then
            mv "$filtered" "$dest"
            ok=1
        else
            rm -f "$filtered"
        fi
    fi
    rm -f "$tmp"

    if [ "$ok" = "1" ]; then
        echo "ok   $dest"
        return 0
    fi

    # Se o destino existe mas e um error-JSON, trata como ausente.
    if [ -s "$dest" ] && ! jq -e "$validate" "$dest" >/dev/null 2>&1; then
        echo "ERR  $dest (upstream falhou em HTTP $http_code; versao anterior tambem invalida)"
    elif [ -s "$dest" ]; then
        echo "warn $dest (upstream falhou em HTTP $http_code; mantendo versao anterior)"
    else
        echo "ERR  $dest (upstream falhou em HTTP $http_code e nao ha versao anterior)"
    fi
}

fetch_json "https://api.warframestat.us/wfinfo/prices/"          "$DATA_DIR/prices.json"
fetch_json "https://api.warframestat.us/wfinfo/filtered_items/"  "$DATA_DIR/filtered_items.json"
fetch_json "https://api.warframe.market/v2/items"                "$DATA_DIR/items_list.json" '[.data[] | {slug: .slug, name: .i18n.en.name}]'
fetch_json "https://drops.warframestat.us/data/modLocations.json"      "$DATA_DIR/modLocations.json"
fetch_json "https://drops.warframestat.us/data/missionRewards.json"    "$DATA_DIR/missionRewards.json"
fetch_json "https://drops.warframestat.us/data/cetusBountyRewards.json" "$DATA_DIR/cetusBountyRewards.json"
fetch_json "https://drops.warframestat.us/data/solarisBountyRewards.json" "$DATA_DIR/solarisBountyRewards.json"
fetch_json "https://drops.warframestat.us/data/zarimanRewards.json"    "$DATA_DIR/zarimanRewards.json"
fetch_json "https://drops.warframestat.us/data/enemyModTables.json"   "$DATA_DIR/enemyModTables.json"
fetch_json "https://drops.warframestat.us/data/transientRewards.json" "$DATA_DIR/transientRewards.json"
fetch_json "https://drops.warframestat.us/data/relics.json"           "$DATA_DIR/relics.json"
fetch_json "https://raw.githubusercontent.com/WFCD/warframe-items/master/data/json/Mods.json" "$DATA_DIR/mods_all.json" '[.[].name]'
fetch_json "https://raw.githubusercontent.com/WFCD/warframe-items/master/data/json/Arcanes.json" "$DATA_DIR/arcanes_all.json" '[.[].name]'
fetch_json "https://raw.githubusercontent.com/WFCD/warframe-items/master/data/json/Mods.json" "$DATA_DIR/mod_ranks.json" '[.[] | select(.fusionLimit != null) | {key: .name, value: .fusionLimit}] | from_entries'
fetch_json "https://raw.githubusercontent.com/WFCD/warframe-items/master/data/json/Resources.json" "$DATA_DIR/resources_wfcd.json"
fetch_json "https://raw.githubusercontent.com/WFCD/warframe-items/master/data/json/Misc.json"      "$DATA_DIR/misc_wfcd.json"

# Warframe public export data (used for Baro Ki'Teer item name translation)
# These only change on Warframe game updates (~every 4-8 weeks)
BROWSE_BASE="https://browse.wf/warframe-public-export-plus"
fetch_json "$BROWSE_BASE/dict.en.json"            "$DATA_DIR/dict.en.json"
fetch_json "$BROWSE_BASE/ExportUpgrades.json"     "$DATA_DIR/ExportUpgrades.json"
fetch_json "$BROWSE_BASE/ExportWeapons.json"      "$DATA_DIR/ExportWeapons.json"
fetch_json "$BROWSE_BASE/ExportFlavour.json"      "$DATA_DIR/ExportFlavour.json"
fetch_json "$BROWSE_BASE/ExportResources.json"    "$DATA_DIR/ExportResources.json"
fetch_json "$BROWSE_BASE/ExportCustoms.json"      "$DATA_DIR/ExportCustoms.json"
fetch_json "$BROWSE_BASE/ExportBoosterPacks.json" "$DATA_DIR/ExportBoosterPacks.json"
fetch_json "$BROWSE_BASE/ExportBundles.json"      "$DATA_DIR/ExportBundles.json"
fetch_json "$BROWSE_BASE/ExportRelics.json"       "$DATA_DIR/ExportRelics.json"

$PYTHON "$DIR/scripts/data/update_prime_parts.py"
$PYTHON "$DIR/scripts/data/build_enemy_locations.py"
$PYTHON "$DIR/scripts/data/build_ducat_values.py"

$PYTHON "$DIR/scripts/data/build_items_prices.py"

# Icons do Circuit (auto-crescente: a cada update adiciona os itens da rotacao atual)
$PYTHON "$DIR/scripts/data/build_circuit_images.py"
