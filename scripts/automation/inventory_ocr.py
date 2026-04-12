#!/usr/bin/env python3
"""
Apple Vision OCR for Warframe inventory (mods or arcanes).

Usage: /usr/bin/python3 inventory_ocr.py <screenshot_path> <scan_type>
  scan_type: "mods" | "arcanes"

Output (stdout): {"items": ["Serration", "Vitality", ...]}
"""

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
        print(f"Installing {package}...", file=sys.stderr)
        subprocess.check_call(
            [sys.executable, "-m", "pip", "install", package, "--break-system-packages"],
            stdout=subprocess.DEVNULL,
        )


_ensure("pyobjc-framework-Vision", "Vision")
_ensure("pyobjc-framework-Quartz", "Quartz")
_ensure("Pillow", "PIL")
_ensure("numpy")

import numpy as np  # noqa: E402
import Quartz      # noqa: E402
import Vision      # noqa: E402
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
    request.setRecognitionLevel_(0)  # accurate
    request.setUsesLanguageCorrection_(True)
    handler.performRequests_error_([request], None)

    texts = []
    for observation in request.results() or []:
        candidates = observation.topCandidates_(1)
        if candidates:
            texts.append(str(candidates[0].string()))
    return texts


def _normalize(text: str) -> str:
    return "".join(ch for ch in text if ch.isascii() and ch.isalpha())


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


def fuzzy_match(needle: str, reference: list[str]) -> Optional[str]:
    needle_norm = _normalize(needle)
    if not needle_norm or len(needle_norm) < 3:
        return None

    best_name = None
    best_dist = float("inf")
    for name in reference:
        name_norm = _normalize(name)
        dist = _levenshtein(name_norm, needle_norm)
        if dist < best_dist:
            best_dist = dist
            best_name = name

    if best_name is None:
        return None

    threshold = len(_normalize(best_name)) // 3
    return best_name if best_dist <= threshold else None


def load_reference(scan_type: str, project_root: str) -> list[str]:
    data_root = os.path.join(project_root, "data")
    if scan_type == "mods":
        path = os.path.join(data_root, "mods_all.json")
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, list):
            return [str(x) for x in data if x]
        return [x["name"] for x in data if isinstance(x, dict) and "name" in x]
    else:
        # arcanes
        ARCANE_PREFIXES = (
            "arcane", "molt", "residual", "virtuos",
            "magus", "exodia", "theorem", "eternal", "cascadia",
        )
        path = os.path.join(data_root, "items_list.json")
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        results = []
        for item in data:
            if isinstance(item, dict):
                slug = item.get("slug", "")
                name = item.get("name", "")
            elif isinstance(item, str):
                slug = item.lower()
                name = item
            else:
                continue
            slug_l = slug.lower()
            name_l = name.lower()
            if any(slug_l.startswith(p) or name_l.startswith(p) for p in ARCANE_PREFIXES):
                results.append(name)
        return results


def main():
    # Modes:
    #   single:  inventory_ocr.py <screenshot_path> <scan_type>
    #   batch:   inventory_ocr.py --batch <frame_count> <scan_type>
    #            processes /tmp/wfhub_inv_0.png … /tmp/wfhub_inv_{N-1}.png

    if len(sys.argv) < 3:
        sys.exit("Usage: inventory_ocr.py <path> <scan_type>  |  --batch <count> <scan_type>")

    project_root = os.path.dirname(os.path.abspath(__file__))

    if sys.argv[1] == "--batch":
        frame_count = int(sys.argv[2])
        scan_type   = sys.argv[3]
        paths = [f"/tmp/wfhub_inv_{i}.png" for i in range(frame_count)]
    else:
        paths     = [sys.argv[1]]
        scan_type = sys.argv[2]

    reference = load_reference(scan_type, project_root)
    if not reference:
        sys.exit(f"Reference list is empty for scan_type={scan_type}")

    matched: set[str] = set()
    for path in paths:
        if not os.path.exists(path):
            continue
        image = Image.open(path)
        ocr_lines = vision_ocr(image)
        print(f"[ocr] {os.path.basename(path)}: {len(ocr_lines)} linhas lidas", file=sys.stderr)

        # Build candidates: single lines + consecutive pairs
        candidates = list(ocr_lines)
        for a, b in zip(ocr_lines, ocr_lines[1:]):
            candidates.append(f"{a.strip()} {b.strip()}")

        for line in candidates:
            name = fuzzy_match(line, reference)
            if name:
                matched.add(name)

    print(f"[ocr] total matched: {sorted(matched)}", file=sys.stderr)
    print(json.dumps({"items": sorted(matched)}))


if __name__ == "__main__":
    main()
