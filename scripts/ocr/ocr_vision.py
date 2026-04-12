#!/usr/bin/env python3
"""
Apple Vision OCR for Warframe reward screen.
Reads prefilter.png, splits into 4 parts, OCRs each via Vision Framework,
then fuzzy-matches against prices.json.

Usage: python3 ocr_vision.py [path/to/prefilter.png]
"""

import datetime as dt
import importlib
import json
import os
import subprocess
import sys
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


def main():
    project = os.path.dirname(os.path.abspath(__file__))
    legacy_project = os.path.join(project, "wfinfo-ng")
    data_project = os.path.join(project, "data")
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

    prices_path = _find_file(
        os.path.join(data_project, "prices.json"),
        os.path.join(project, "prices.json"),
        os.path.join(legacy_project, "prices.json"),
        os.path.join(home, "prices.json"),
    )
    if prices_path is None:
        sys.exit(
            "prices.json not found. Generate it in data/prices.json or keep the existing wfinfo-ng/prices.json."
        )

    print(f"Image : {image_path}")
    print(f"Prices: {prices_path}")

    image = Image.open(image_path)
    width, height = image.size
    print(f"Size  : {width}x{height}\n")

    with open(prices_path) as handle:
        prices = json.load(handle)

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
        region_min = region.min()
        region_max = region.max()
        valley_threshold = region_min + (region_max - region_min) * 0.3

        in_valley = region < valley_threshold
        splits = []
        in_split = False
        valley_start = 0
        for index, value in enumerate(in_valley):
            if value and not in_split:
                in_split = True
                valley_start = index
            elif not value and in_split:
                in_split = False
                splits.append(start + (valley_start + index) // 2)

        min_part = width * 0.10
        bounds = [start] + splits + [end]
        filtered = [start]
        for index in range(1, len(bounds) - 1):
            if (bounds[index] - filtered[-1]) >= min_part:
                filtered.append(bounds[index])
        filtered.append(end)

        parts_bounds = [(filtered[index], filtered[index + 1]) for index in range(len(filtered) - 1)]
        if not (2 <= len(parts_bounds) <= 4):
            part_width = width // 4
            parts_bounds = [
                (index * part_width, (index + 1) * part_width if index < 3 else width)
                for index in range(4)
            ]
    else:
        part_width = width // 4
        parts_bounds = [
            (index * part_width, (index + 1) * part_width if index < 3 else width)
            for index in range(4)
        ]

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
            print(f'\nPart {index + 1}: "{text}"')
            print(f"  -> {name}: {value:.1f} plat{marker}")
        else:
            print(f'\nPart {index + 1}: "{text}"')
            print("  -> no match")
    print("=" * 60)

    if output_items:
        payload = {
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
        with open("/tmp/wfhub_reward.json", "w") as handle:
            json.dump(payload, handle)


if __name__ == "__main__":
    main()
