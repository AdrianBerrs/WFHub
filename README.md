# WFHub

macOS desktop app with utilities for Warframe. Combines a React frontend with a Tauri/Rust backend to capture the game window, read `EE.log`, run OCR via Apple Vision, and display real-time game data.

## Features

- **World State**: live game cycles (Cetus, Vallis, Cambion, Zariman), sortie of the day, active invasions, arbitrations with next 3 upcoming slots, Void Trader, alerts — auto-refresh
- **Market Prices**: fuzzy search with autocomplete and top orders from `warframe.market`
- **My Orders**: view and manage your warframe.market orders (close, edit, delete); auto-detects trades from EE.log and closes matching orders on warframe.market
- **Farm Advisor**: drop sources grouped by type, with drop chance and run estimates
- **Build Analyzer**: OCR of build screenshots to identify mods (accessed from Builds & Mods)
- **Builds & Mods**: storage and management of saved builds grouped by Warframe / Weapon / Other, with optional linked entity
- **Inventory**: automated scan of mods, arcanes, and prime parts; filter mods by polarity/type, arcanes by class, primes by category and vault status; sell panel integrated with warframe.market
- **Riven**: riven advisor with roll evaluation and Kuva/Tenet progenitor tutorial
- **Arbitration Schedule**: full arbitration rotation list
- **Void Trader Inventory**: Baro Ki'Teer's current inventory
- **Settings**: app configuration and utility actions

## Stack

- Tauri 2 + Rust
- React 18 + TypeScript + Vite
- Tailwind CSS 4
- Python 3 + Apple Vision Framework (pyobjc)
- xcap (local fork in `xcap-patch/`)
- reqwest

## Structure

```text
WFHub/
├── src/                              # React frontend
│   ├── App.tsx                       # collapsible sidebar + routing (MemoryRouter)
│   ├── main.tsx
│   ├── overlay.tsx                   # HUD window entry point
│   ├── index.css
│   ├── components/
│   │   ├── RewardOverlay.tsx         # reward HUD component
│   │   └── TradeSuccessOverlay.tsx   # trade confirmation overlay
│   ├── pages/
│   │   ├── HubPage.tsx
│   │   ├── MarketPage.tsx
│   │   ├── MyOrdersPage.tsx
│   │   ├── FarmAdvisorPage.tsx
│   │   ├── BuildAnalyzerPage.tsx
│   │   ├── BuildTrackerPage.tsx
│   │   ├── InventoryPage.tsx
│   │   ├── RivenAdvisorPage.tsx
│   │   ├── ArbitrationSchedulePage.tsx
│   │   ├── VoidTraderInventoryPage.tsx
│   │   └── SettingsPage.tsx
│   └── lib/
│       ├── search.ts
│       └── modSpecialSources.ts
├── src-tauri/                        # Tauri/Rust backend
│   └── src/
│       ├── lib.rs                    # entry point: tray, hotkey, reward monitor, commands
│       ├── ocr.rs                    # reward screen image preprocessing
│       ├── inventory.rs              # inventory scan
│       └── theme.rs                  # game visual theme detection
├── scripts/
│   ├── ocr/
│   │   ├── ocr_vision.py             # reward screen OCR (daemon mode)
│   │   ├── ocr_vision_build.py       # build screenshot OCR
│   │   ├── ocr_vision_riven.py       # riven OCR
│   │   └── ocr_item_name.py          # item name OCR
│   ├── automation/
│   │   ├── inventory_ocr.py          # batch inventory OCR
│   │   ├── inventory_scroll.py       # automated inventory scrolling
│   │   └── forja_click.py            # automated Foundry clicks
│   └── data/
│       ├── build_enemy_locations.py  # generates enemyLocations.json
│       ├── build_riven_weapon_rules.py # generates rivenWeaponRules.json
│       ├── generate_prime_parts.py   # prime parts generation helper
│       └── update_prime_parts.py     # updates prime_parts.json
├── data/                             # game datasets (gitignored — see below)
│   └── rivenWeaponRulesSource_*.csv  # riven CSV sources (versioned)
├── xcap-patch/                       # local xcap fork with macOS patches
├── update.sh                         # main dataset update script
└── update_prices.sh
```

## Main pipelines

### Reward overlay

```
EE.log → lib.rs (thread polling every 200ms)
  → single trigger: "Created /Lotus/Interface/ProjectionRewardChoice.swf"
  → 10s cooldown; waits 1.5s before capture
  → captures "Warframe" window via xcap
  → ocr.rs: detect_theme() + extract_parts() → /tmp/wfinfo_prefilter.png
  → lib.rs: calls pre-warmed OCR daemon (~1-2s)
  → scripts/ocr/ocr_vision.py (daemon mode):
      → detects gold peaks → clusters by proximity (≤10% width = same card)
      → splits image into N cards at midpoints between clusters
      → Apple Vision OCR per card + fuzzy match against prices.json
  → lib.rs: show_overlay()
  → RewardOverlay.tsx: displays HUD for 15s
```

### Inventory scan

```
InventoryPage → start_inventory_scan
  → inventory.rs: captures frames + auto-scroll
  → scripts/automation/inventory_ocr.py --batch
  → merges into data/inventory.json
```

### Trade detection

```
EE.log → lib.rs (thread polling every 200ms, circular buffer of 200 lines)
  → detects "The trade was successful!"
  → parses previous "Are you sure..." dialog lines for items, buyer, platinum
  → deduces set (multiple prime parts) vs single part
  → TradeSuccessOverlay.tsx: confirmation card at bottom-right
  → user confirms → wfmarket_confirm_trade:
      GET /v2/orders/my → filter sell+visible → resolve itemId via GET /v2/item/{id}
      → fuzzy match by name/slug → PATCH /v2/order/{id}/close
```

### Build Analyzer

```
BuildTrackerPage → "Build Analyze" button → BuildAnalyzerPage
  → screenshot or upload
  → scripts/ocr/ocr_vision_build.py
  → list of identified mods
  → optionally saved to data/builds.json
```

## Hotkeys

| Hotkey | Action |
|---|---|
| `CmdOrCtrl+Shift+W` | Toggle main window |

## Data in `data/`

The `data/` folder is gitignored (except the riven CSVs). After cloning, run `./update.sh` to populate it.

In a **bundled app** (`.dmg`), the datasets ship inside the app bundle and are seeded into the writable app-data directory (`~/Library/Application Support/com.wfhub.app/data`) on first run. The "Update datasets" button writes there too, so updates work without re-installing.

**Game datasets** (generated by `update.sh`):

| File | Source |
|---|---|
| `prices.json` | warframestat.us |
| `items_list.json` | warframe.market API v2 |
| `mods_all.json`, `modLocations.json` | WFCD / drops.warframestat.us |
| `enemyModTables.json`, `transientRewards.json` | drops.warframestat.us |
| `missionRewards.json`, `cetusBountyRewards.json`, `solarisBountyRewards.json`, `zarimanRewards.json`, `relics.json` | drops.warframestat.us |
| `prime_parts.json`, `enemyLocations.json` | generated by scripts |
| `prime_vault.json` | generated manually via WFCD — vault status per prime set |
| `mod_meta.json` | generated via WFCD Mods.json — polarity + type per mod |
| `mod_images.json`, `arcane_images.json` | warframestat.us CDN — thumbnails and metadata |
| `rivenStats.json`, `rivenWeaponRules.json` | generated by scripts |
| `Export*.json`, `dict.en.json` | browse.wf (public export) |

**User data** (never versioned):

- `inventory.json` — inventory scan results (mods, arcanes, prime\_parts)
- `builds.json` + `build_images/` — saved builds
- `hub_state.json` — internal hub state cache
- `wfmarket_auth.json` — warframe.market JWT token

## Requirements

- macOS
- Node.js + npm
- Rust + cargo
- `/usr/bin/python3` with pyobjc:
  ```bash
  /usr/bin/python3 -m pip install pyobjc-framework-Vision pyobjc-framework-Quartz
  ```
- macOS permissions: screen recording and accessibility (for mouse automation)

## Initial setup

```bash
# 1. install Node dependencies
npm install

# 2. install Python dependencies
/usr/bin/python3 -m pip install pyobjc-framework-Vision pyobjc-framework-Quartz

# 3. populate game datasets
./update.sh

# 4. configure the EE.log path
#    Either set it from the app (Settings → Warframe → EE.log path, with an
#    auto-detect button), or edit data/config.json manually:
cp data/config.json.example data/config.json
# edit data/config.json with the correct EE.log path for your machine
```

## Development

```bash
# full app (frontend + backend)
source ~/.cargo/env && npm run tauri dev

# frontend only
npm run dev

# build frontend
npm run build

# build Rust workspace
source ~/.cargo/env && cargo build --workspace

# debug mode with intermediate files written to /tmp/
WFHUB_DEBUG_FILES=1 npm run tauri dev

# monitor OCR daemon logs
tail -f /tmp/wfhub_debug.log
```

## Building a distributable app (.dmg)

```bash
# ensure datasets are present (bundling requires them)
./update.sh

# build and bundle .app + .dmg
source ~/.cargo/env && npm run tauri build
```

Output goes to `target/release/bundle/macos/WFHub.app` and `target/release/bundle/dmg/WFHub_0.1.0_aarch64.dmg`. The bundle includes the datasets (`data/`), all scripts, and `update.sh`, so end users don't need Node/Rust/Python to run it — only `/usr/bin/python3` with pyobjc for OCR and the macOS screen-recording/accessibility permissions.

## Credits

- [warframe.market](https://warframe.market) — market price data
- [WFCD / warframestat.us](https://warframestat.us) — drop tables and item data
- [browse.wf](https://browse.wf) — Warframe public export data
- [Warframe](https://warframe.com) — game data © Digital Extremes

## Notes

- All Python scripts use `/usr/bin/python3` — do not change this
- Do not update the `xcap` crate without validating the fork in `xcap-patch/`
- The app uses a tray icon with `ActivationPolicy::Accessory` (no Dock icon); closing the window hides it, does not quit
- Changes to `scripts/ocr/ocr_vision.py` take effect on app restart (no Rust rebuild needed); changes to `lib.rs` require `npm run tauri build`
