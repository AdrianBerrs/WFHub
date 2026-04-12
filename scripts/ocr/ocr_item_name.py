#!/usr/bin/env python3
"""
OCR item name from Warframe ITEM DETAILS screen.
Crops the top-left panel, runs Apple Vision OCR, extracts the item name.

Usage: /usr/bin/python3 ocr_item_name.py <screenshot_path>
Output: /tmp/wfhub_item_search.json  →  {"name": "Voidrig", "found": true, "raw": [...]}
"""

import importlib
import json
import os
import subprocess
import sys
from difflib import SequenceMatcher
from typing import Optional


def _ensure(package, import_name=None):
    import_name = import_name or package
    try:
        importlib.import_module(import_name)
    except ImportError:
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", package, "--break-system-packages"],
            stdout=subprocess.DEVNULL,
        )


_ensure("pyobjc-framework-Vision", "Vision")
_ensure("pyobjc-framework-Quartz", "Quartz")
_ensure("Pillow", "PIL")

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


# UI text to skip when searching for item name
_SKIP_CONTAINS = {"ITEM DETAILS", "OWNED", "BUILD REQUIREMENTS", "EXIT"}
# Known stat labels that prefix a number
_STAT_LABELS = {"health", "shield", "armor", "energy", "sprint speed", "sprint", "speed"}
_TITLE_HINTS = {"prime", "blueprint", "set", "arcane", "wraith", "vandal", "prisma", "umbra"}
_COMMON_UI_PHRASES = {"tradeable", "required", "owned", "exit", "item details", "build requirements"}
_ITEM_NAMES_CACHE: Optional[list[str]] = None
_MOD_NAMES_CACHE: Optional[set[str]] = None


def _is_stat_line(text: str) -> bool:
    """Returns True for lines like 'Health 1.400' or 'Sprint Speed 1'."""
    words = text.split()
    if len(words) < 2:
        return False
    # Last token is a number (possibly formatted with dots/commas)
    last = words[-1].replace(".", "").replace(",", "")
    if not last.isdigit():
        return False
    label = " ".join(words[:-1]).lower()
    return label in _STAT_LABELS


def _normalize(text: str) -> str:
    return "".join(ch for ch in text.lower() if ch.isascii() and (ch.isalnum() or ch.isspace()))


def _load_item_names() -> list[str]:
    global _ITEM_NAMES_CACHE
    if _ITEM_NAMES_CACHE is not None:
        return _ITEM_NAMES_CACHE

    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "items_list.json")
    try:
        with open(path, encoding="utf-8") as handle:
            raw = json.load(handle)
        names = [str(item["name"]).strip() for item in raw if isinstance(item, dict) and item.get("name")]
    except Exception:
        names = []

    _ITEM_NAMES_CACHE = names
    return names


def _load_mod_names() -> set[str]:
    global _MOD_NAMES_CACHE
    if _MOD_NAMES_CACHE is not None:
        return _MOD_NAMES_CACHE

    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "mods_all.json")
    try:
        with open(path, encoding="utf-8") as handle:
            raw = json.load(handle)
        names = {str(item).strip().lower() for item in raw if str(item).strip()}
    except Exception:
        names = set()

    _MOD_NAMES_CACHE = names
    return names


def _score_candidate(text: str) -> float:
    stripped = text.strip()
    normalized = _normalize(stripped)
    if not normalized:
        return float("-inf")

    item_names = _load_item_names()
    mod_names = _load_mod_names()

    best_similarity = 0.0
    for name in item_names:
        candidate = _normalize(name)
        if not candidate:
            continue
        best_similarity = max(best_similarity, SequenceMatcher(None, normalized, candidate).ratio())

    score = best_similarity
    score += min(len(stripped), 40) / 200.0
    score += min(stripped.count(" ") + 1, 4) * 0.03

    if any(hint in normalized for hint in _TITLE_HINTS):
        score += 0.18

    if normalized in mod_names:
        score -= 0.10

    if normalized in {_normalize(name) for name in item_names}:
        score += 0.10

    if any(phrase in normalized for phrase in _COMMON_UI_PHRASES):
        score -= 0.75

    return score


def extract_item_name(texts: list[str]) -> Optional[str]:
    best_text: Optional[str] = None
    best_score = float("-inf")

    for text in texts:
        stripped = text.strip()
        if not stripped or len(stripped) < 3:
            continue
        upper = stripped.upper()
        if any(skip in upper for skip in _SKIP_CONTAINS):
            continue
        # Pure number
        if stripped.replace(".", "").replace(",", "").isdigit():
            continue
        # Stat line (e.g. "Health 1.400")
        if _is_stat_line(stripped):
            continue

        score = _score_candidate(stripped)
        if score > best_score:
            best_score = score
            best_text = stripped

    return best_text


def main():
    if len(sys.argv) < 2:
        sys.exit("Usage: ocr_item_name.py <image_path>")

    path = sys.argv[1]
    if not os.path.exists(path):
        sys.exit(f"Image not found: {path}")

    image = Image.open(path)
    w, h = image.size

    # The item title usually sits around x=70..720 and y=120..180 on 1920x1080.
    # Use a scaled crop around that band first, then fall back to a broader crop.
    title_crop = image.crop(
        (
            int(w * 0.03),
            int(h * 0.10),
            int(w * 0.40),
            int(h * 0.20),
        )
    )
    fallback_crop = image.crop((0, 0, int(w * 0.50), int(h * 0.30)))
    title_texts = vision_ocr(title_crop)
    fallback_texts = vision_ocr(fallback_crop)
    texts = title_texts + fallback_texts

    name = extract_item_name(title_texts) or extract_item_name(fallback_texts)
    result = {"name": name, "found": name is not None, "raw": texts}

    with open("/tmp/wfhub_item_search.json", "w") as f:
        json.dump(result, f)

    print(json.dumps(result))


if __name__ == "__main__":
    main()
