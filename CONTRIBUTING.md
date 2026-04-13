# Contributing to WFHub

Thanks for your interest. A few things to know before contributing.

## Platform

WFHub is **macOS only**. It depends on Apple Vision Framework for OCR and macOS-native APIs for window capture and mouse automation.
Feel free to fork and adapt for other platforms, but PRs must be macOS-compatible to be accepted.

## Setup

Follow the [initial setup in the README](README.md#initial-setup). The key steps that are easy to miss:

- Copy `data/config.json.example` to `data/config.json` and set your local `EE.log` path
- Run `./update.sh` to populate the `data/` folder — the app won't work without it
- Python scripts must use `/usr/bin/python3`, not any other Python installation

## Before submitting a PR

- The project must compile without errors: `source ~/.cargo/env && cargo build --workspace`
- The app must run: `source ~/.cargo/env && npm run tauri dev`

## Things to be careful about

**`xcap-patch/`** — this is a local fork of the `xcap` crate with macOS-specific patches. Do not update it without testing that screen capture still works. A broken xcap means the reward overlay stops working entirely.

**Python scripts** — always use `/usr/bin/python3`. Do not add a shebang or change the interpreter path.

**Hardcoded paths** — avoid hardcoding any local paths (user names, volume names, disk identifiers). Configuration belongs in `data/config.json`.

**`data/` files** — `inventory.json`, `builds.json`, `hub_state.json`, and `config.json` are user data and must never be committed. The `.gitignore` already covers them.

## Scope

This is a personal project built for a specific setup (macOS + Warframe via Wine/CrossOver).
Bug fixes, UI improvements, and new game data integrations are welcome.
