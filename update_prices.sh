#!/usr/bin/env sh
DIR="$(cd "$(dirname "$0")" && pwd)"
DATA_DIR="$DIR/data"
echo "Baixando prices.json..."
curl -sf https://api.warframestat.us/wfinfo/prices/ | jq . > "$DATA_DIR/prices.json"
if [ $? -eq 0 ]; then
    echo "prices.json atualizado em $DATA_DIR/prices.json"
else
    echo "Erro ao baixar prices.json" >&2
    exit 1
fi
