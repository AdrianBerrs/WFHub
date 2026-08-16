#!/usr/bin/env python3
"""
Apple Vision OCR for Warframe reward screen.
Reads prefilter.png, splits into 4 parts, OCRs each via Vision Framework,
then fuzzy-matches against prices.json.

Usage:
  python3 ocr_vision.py [path/to/prefilter.png]   # single-shot
  python3 ocr_vision.py --daemon                   # daemon mode: reads paths from stdin, writes JSON to stdout
"""

import datetime as dt
import importlib
import json
import os
import subprocess
import sys
from pathlib import Path
from typing import Optional


def _ensure(package, import_name=None):
    import_name = import_name or package
    try:
        importlib.import_module(import_name)
    except ImportError:
        print(f"Installing {package}...")
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", package, "--break-system-packages"],
            stdout=subprocess.DEVNULL,
        )


_ensure("pyobjc-framework-Vision", "Vision")
_ensure("pyobjc-framework-Quartz", "Quartz")
_ensure("Pillow", "PIL")
_ensure("numpy")

import numpy as np  # noqa: E402
import Quartz  # noqa: E402
import Vision  # noqa: E402
from PIL import Image  # noqa: E402


def _pil_to_cgimage(img: Image.Image):
    img = img.convert("RGB")
    width, height = img.size
    raw = img.tobytes()
    provider = Quartz.CGDataProviderCreateWithData(None, raw, len(raw), None)
    color_space = Quartz.CGColorSpaceCreateDeviceRGB()
    return Quartz.CGImageCreate(
        width,
        height,
        8,
        24,
        width * 3,
        color_space,
        Quartz.kCGBitmapByteOrderDefault | Quartz.kCGImageAlphaNone,
        provider,
        None,
        False,
        Quartz.kCGRenderingIntentDefault,
    )


def vision_ocr(img: Image.Image) -> list[str]:
    cg_image = _pil_to_cgimage(img)
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg_image, {})
    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLevel_(0)
    request.setUsesLanguageCorrection_(True)
    handler.performRequests_error_([request], None)

    texts = []
    for observation in request.results() or []:
        candidates = observation.topCandidates_(1)
        if candidates:
            texts.append(str(candidates[0].string()))
    return texts


def _normalize(text: str) -> str:
    return "".join(char for char in text if char.isascii() and char.isalpha())


def _levenshtein(a: str, b: str) -> int:
    if len(a) < len(b):
        a, b = b, a
    if not b:
        return len(a)

    previous = list(range(len(b) + 1))
    for left in a:
        current = [previous[0] + 1]
        for index, right in enumerate(b):
            current.append(
                min(current[index] + 1, previous[index + 1] + 1, previous[index] + (left != right))
            )
        previous = current
    return previous[-1]


def find_item(needle: str, prices: list) -> Optional[tuple]:
    needle_norm = _normalize(needle)
    if not needle_norm:
        return None

    best = min(
        (price for price in prices if not price["name"].endswith(" Set")),
        key=lambda price: _levenshtein(price["name"].replace(" ", ""), needle_norm),
        default=None,
    )
    if best is None:
        return None

    stripped = best["name"].replace(" ", "")
    distance = _levenshtein(stripped, needle_norm)
    threshold = len(stripped) // 3
    if distance <= threshold:
        return best["name"], float(best.get("custom_avg", 0))
    return None


def _find_file(*candidates: str) -> Optional[str]:
    for path in candidates:
        if os.path.exists(path):
            return path
    return None


def _resolve_prices_path(script_path: Path) -> Optional[str]:
    env_path = os.environ.get("WFHUB_PRICES_PATH")
    candidates: list[Path] = []

    if env_path:
        candidates.append(Path(env_path).expanduser())

    # Current repo layout: WFHub/scripts/ocr/ocr_vision.py -> WFHub/data/prices.json
    candidates.append(script_path.parents[2] / "data" / "prices.json")
    # Additional local fallbacks around scripts/
    candidates.append(script_path.parents[1] / "data" / "prices.json")
    candidates.append(script_path.parent / "data" / "prices.json")
    candidates.append(script_path.parent / "prices.json")
    candidates.append(script_path.parent / "wfinfo-ng" / "prices.json")
    candidates.append(Path.home() / "prices.json")

    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return None


def process_image(image_path: str, prices: list) -> Optional[dict]:
    """
    Process a reward screen image against the prices list.
    Returns a payload dict {"timestamp": ..., "items": [...]} or None if no items found.
    All debug output goes to stderr so stdout stays clean for daemon IPC.
    """
    image = Image.open(image_path)
    width, height = image.size
    print(f"[ocr] {image_path} {width}x{height}", file=sys.stderr)

    array = np.array(image.convert("RGB"))
    gold_mask = (
        (array[:, :, 0] > 150)
        & (array[:, :, 1] > 130)
        & (array[:, :, 0] > array[:, :, 2] + 40)
    )
    col_gold = gold_mask.sum(axis=0).astype(float)

    kernel = np.ones(50) / 50
    smooth = np.convolve(col_gold, kernel, mode="same")

    content_threshold = smooth.max() * 0.05
    content_cols = np.where(smooth > content_threshold)[0]

    if len(content_cols) >= 2:
        start = int(content_cols[0])
        end = int(content_cols[-1])
        region = smooth[start:end]

        # Detecta picos (centros dos cards) e divide nos midpoints entre eles
        peak_threshold = region.max() * 0.30
        above = region > peak_threshold
        raw_peaks = []
        in_peak = False
        peak_start = 0
        for i, val in enumerate(above):
            if val and not in_peak:
                in_peak = True
                peak_start = i
            elif not val and in_peak:
                in_peak = False
                raw_peaks.append(start + (peak_start + i) // 2)
        if in_peak:
            raw_peaks.append(start + (peak_start + len(above)) // 2)

        print(f"[ocr] {len(raw_peaks)} picos brutos: {raw_peaks}", file=sys.stderr)

        # Mescla picos vizinhos muito proximos (< 100px) = ruido dentro do mesmo card.
        merge_gap = 100
        merged: list[int] = []
        for p in raw_peaks:
            if merged and (p - merged[-1]) <= merge_gap:
                merged[-1] = (merged[-1] + p) // 2
            else:
                merged.append(p)

        # Fissuras sao quase sempre 4 players. Heuristicas baseadas em gaps de gold
        # se mostraram fragies (4-card real com razao 0.56-0.58 indistinguivel de
        # 3-card real com razao 0.59) e posicionais tambem falham quando 2 cards
        # adjacentes tem densidades de gold muito diferentes (Bronco Receiver/Barrel
        # sao quase brancos, Forma e Voruna helmet sao fortemente dourados —
        # detecao de fronteira pula para o meio do grid).
        # Forca sempre split em 4 partes iguais. Quando ha menos de 4 cards, a OCR
        # de slots vazios retorna no match e e descartada.
        n_items = 4
        print(
            f"[ocr] n_items=4 (forcado; merged_peaks={len(merged)})",
            file=sys.stderr,
        )

        if not (2 <= n_items <= 4):
            n_items = 4
        # Cards da reward screen sempre vêm em grid uniformemente espaçado.
        # Dividir [start, end] em N partes iguais é mais robusto que midpoint
        # entre centróides — esse último desalinha quando a densidade de ouro
        # varia entre cards (helmets grandes, nomes longos).
        part_w = (end - start) / n_items
        parts_bounds = [
            (int(start + i * part_w), int(start + (i + 1) * part_w) if i < n_items - 1 else end)
            for i in range(n_items)
        ]
    else:
        parts_bounds = [
            (index * (width // 4), (index + 1) * (width // 4) if index < 3 else width)
            for index in range(4)
        ]
        print("[ocr] fallback: 4 splits iguais", file=sys.stderr)

    best_value = -1.0
    best_index = -1
    results = []

    for index, (left, right) in enumerate(parts_bounds):
        part = image.crop((left, 0, right, height))
        texts = vision_ocr(part)
        combined = " ".join(texts).strip()

        if combined and "Forma" in combined:
            match = None
        else:
            match = find_item(combined, prices) if combined else None
            if match and "Forma" in match[0]:
                match = None

        platinum = match[1] if match else 0.0
        results.append((combined, match, platinum))
        if platinum > best_value:
            best_value = platinum
            best_index = index

    output_items = []
    for index, (text, match, platinum) in enumerate(results):
        is_best = index == best_index and best_value > 0
        if match:
            name, value = match
            output_items.append({"name": name, "plat": value, "best": is_best})
            marker = "  <----" if is_best else ""
            print(f'[ocr] Part {index + 1}: "{text}" -> {name}: {value:.1f}p{marker}', file=sys.stderr)
        elif text:
            output_items.append({"name": text, "plat": 0.0, "best": False})
            print(f'[ocr] Part {index + 1}: "{text}" -> no match (0p)', file=sys.stderr)

    if not output_items:
        return None

    return {
        "timestamp": dt.datetime.now().isoformat(),
        "items": [
            {
                "name": item["name"],
                "platinum": float(item["plat"]),
                "is_best": item["best"],
            }
            for item in output_items
        ],
    }


def main():
    script_path = Path(__file__).resolve()
    project = str(script_path.parent)
    legacy_project = os.path.join(project, "wfinfo-ng")
    home = os.path.expanduser("~")

    if len(sys.argv) > 1:
        image_path = sys.argv[1]
        if not os.path.exists(image_path):
            sys.exit(f"Image not found: {image_path}")
    else:
        image_path = _find_file(
            "/tmp/wfinfo_prefilter.png",
            os.path.join(project, "prefilter.png"),
            os.path.join(legacy_project, "prefilter.png"),
            os.path.join(home, "prefilter.png"),
        )
        if image_path is None:
            sys.exit(
                "prefilter.png not found. Run the WFHub reward detection first or pass the path as an argument."
            )

    prices_path = _resolve_prices_path(script_path)
    if prices_path is None:
        sys.exit(
            "prices.json not found. Expected WFHub/data/prices.json (or set WFHUB_PRICES_PATH)."
        )

    print(f"Image : {image_path}")
    print(f"Prices: {prices_path}")

    with open(prices_path) as handle:
        prices = json.load(handle)
    if not isinstance(prices, list):
        print(f"ERROR: prices.json is invalid (got {type(prices).__name__}, expected list). Run ./update_prices.sh to refresh.")
        sys.exit(1)

    payload = process_image(image_path, prices)
    print("=" * 60)

    if payload:
        with open("/tmp/wfhub_reward.json", "w") as handle:
            json.dump(payload, handle)


def daemon_mode():
    script_path = Path(__file__).resolve()
    prices_path = _resolve_prices_path(script_path)
    if prices_path is None:
        print(json.dumps({"items": [], "error": "prices.json not found"}), flush=True)
        sys.exit(1)

    with open(prices_path) as f:
        prices = json.load(f)
    if not isinstance(prices, list):
        print(json.dumps({"items": [], "error": "prices.json invalid"}), flush=True)
        sys.exit(1)

    print("READY", flush=True)

    for line in sys.stdin:
        image_path = line.strip()
        if not image_path:
            continue
        try:
            payload = process_image(image_path, prices)
            result = payload if payload else {"items": []}
            print(json.dumps(result), flush=True)
        except Exception as e:
            print(json.dumps({"items": [], "error": str(e)}), flush=True)


if __name__ == "__main__":
    if "--daemon" in sys.argv:
        daemon_mode()
    else:
        main()
