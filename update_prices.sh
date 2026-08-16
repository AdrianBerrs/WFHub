#!/usr/bin/env sh
DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="${WFHUB_DATA_DIR:-$DIR/data}"
DEST="$DATA_DIR/prices.json"

echo "Baixando prices.json..."
TMP="$(mktemp)"
HTTP=$(curl -sS -o "$TMP" -w "%{http_code}" \
    -H "User-Agent: Mozilla/5.0" -H "Accept: application/json" \
    "https://api.warframestat.us/wfinfo/prices/" 2>/dev/null)

if [ "$HTTP" != "200" ] || [ ! -s "$TMP" ]; then
    rm -f "$TMP"
    echo "Erro: upstream retornou HTTP $HTTP (arquivo destino preservado)." >&2
    exit 1
fi

# Valida que e um array nao-vazio (nao um error-JSON 503).
FILTERED="$(mktemp)"
if jq . "$TMP" > "$FILTERED" 2>/dev/null \
    && jq -e 'type == "array" and length > 0' "$FILTERED" >/dev/null 2>&1; then
    mv "$FILTERED" "$DEST"
    rm -f "$TMP"
    echo "prices.json atualizado em $DEST"
else
    rm -f "$TMP" "$FILTERED"
    echo "Erro: resposta nao parece um prices.json valido (arquivo destino preservado)." >&2
    exit 1
fi
