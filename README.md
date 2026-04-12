# WFHub

App desktop macOS para utilitarios do Warframe. Combina frontend React com backend Tauri/Rust para capturar a janela do jogo, ler o `EE.log`, rodar OCR via Apple Vision e automatizar interacoes dentro do jogo.

## Funcionalidades

- **Hub**: painel rápido com ações e atalhos
- **Busca Rapida**: busca unificada por itens, builds e telas
- **Market**: preços e top orders do `warframe.market`
- **Farm Advisor**: fontes de drop agrupadas por tipo, com chance e estimativa de runs
- **Build Analyzer**: OCR de screenshot de build para identificar mods
- **Build Tracker**: armazenamento e gerenciamento de builds salvas
- **Prime Tracker**: checklist de partes prime cruzado com inventário escaneado
- **Inventário**: scan automatizado de mods, arcanes e partes prime
- **Rivens**: advisor de rivens com análise por OCR, avaliação de roll e tutorial de progenitors Kuva/Tenet
- **Forja**: automação de crafting recorrente na Foundry
- **Arbitration Schedule**: agenda de arbitrations
- **Void Trader Inventory**: inventário do Baro Ki'Teer
- **Configurações**: ajustes e ações utilitárias

## Stack

- Tauri 2 + Rust
- React 18 + TypeScript + Vite
- Tailwind CSS 4
- Python 3 + Apple Vision Framework (pyobjc)
- xcap (fork local em `xcap-patch/`)
- reqwest

## Fluxos principais

### Reward overlay

```
EE.log → lib.rs (thread a cada 200ms)
  → detecta trigger de recompensa
  → captura janela "Warframe" via xcap
  → ocr.rs: detect_theme() + extract_parts() → /tmp/wfinfo_prefilter.png
  → scripts/ocr/ocr_vision.py → /tmp/wfhub_reward.json
  → lib.rs: show_overlay()
  → RewardOverlay.tsx: exibe HUD por 15s
```

### Inventario

```
InventoryPage → start_inventory_scan
  → inventory.rs: captura frames + scroll automático
  → scripts/automation/inventory_ocr.py --batch
  → merge em data/inventory.json
```

### Build Analyzer

```
BuildAnalyzerPage → screenshot ou upload
  → scripts/ocr/ocr_vision_build.py
  → lista de mods identificados
  → pode salvar em data/builds.json (Build Tracker)
```

### Forja

```
ForjaPage → start_forja
  → forja.rs: monitora EE.log
  → detecta trigger "DFoundry"
  → scripts/automation/forja_click.py <item_key>
  → cooldown 55s → repete
```

## Hotkeys

| Hotkey | Ação                                                   |
|---|--------------------------------------------------------|
| `CmdOrCtrl+Shift+W` | Toggle janela principal                                |
| `CmdOrCtrl+Shift+3` | OCR do nome do item na tela → navega para Busca Rápida |

## Dados em `data/`

Após clonar, rode `./update.sh` para popular os dados do jogo.

**Datasets do jogo** (gerados por `update.sh`):

| Arquivo | Origem |
|---|---|
| `prices.json` | warframestat.us |
| `items_list.json` | warframe.market API v2 |
| `mods_all.json`, `modLocations.json` | WFCD / drops.warframestat.us |
| `enemyModTables.json`, `transientRewards.json` | drops.warframestat.us |
| `missionRewards.json`, `cetusBountyRewards.json`, `solarisBountyRewards.json`, `zarimanRewards.json`, `relics.json` | drops.warframestat.us |
| `prime_parts.json`, `enemyLocations.json` | gerados por scripts |
| `rivenStats.json`, `rivenWeaponRules.json` | gerados por scripts |
| `Export*.json`, `dict.en.json` | browse.wf (public export) |

**Dados do usuário** (nunca versionados):

- `inventory.json` — resultado dos scans de inventário
- `builds.json` + `build_images/` — builds salvas
- `hub_state.json` — estado interno do hub

## Requisitos

- macOS
- Node.js + npm
- Rust + cargo
- `/usr/bin/python3` com pyobjc:
  ```bash
  /usr/bin/python3 -m pip install pyobjc-framework-Vision pyobjc-framework-Quartz
  ```
- Permissões macOS: captura de tela e acessibilidade (para automacao de mouse)

## Setup inicial

```bash
# 1. dependencias Node
npm install

# 2. dependencias Python
/usr/bin/python3 -m pip install pyobjc-framework-Vision pyobjc-framework-Quartz

# 3. datasets do jogo
./update.sh

# 4. configurar o path do EE.log
cp data/config.json.example data/config.json
# editar data/config.json com o path correto do EE.log na sua maquina
```

## Desenvolvimento

```bash
# app completo (frontend + backend)
source ~/.cargo/env && npm run tauri dev

# so o frontend
npm run dev

# build frontend
npm run build

# build Rust
source ~/.cargo/env && cargo build --workspace

# debug com arquivos intermediarios em /tmp/
WFHUB_DEBUG_FILES=1 npm run tauri dev
```

## Notas

- Todos os scripts Python usam `/usr/bin/python3` — nao altere
- Nao atualize a crate `xcap` sem validar o fork em `xcap-patch/`
- O app usa tray e `ActivationPolicy::Accessory` (sem icone no Dock); fechar a janela esconde, não encerra
- O path do `EE.log` está acoplado ao ambiente local — ajuste em `lib.rs` apos clonar
