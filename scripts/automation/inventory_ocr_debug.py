#!/usr/bin/env python3
"""
Debug tool: OCR inventory screenshot with per-card isolation.

Strategy:
  1. One full OCR pass to locate mod-name anchors (fuzzy match).
  2. Estimate grid cell size from anchor positions.
  3. Crop each card individually and run a second OCR pass on the crop.
  4. Parse quantity / rank from the isolated card text.

Returns:
  raw_lines  – all text from the initial pass (reading order)
  matched    – globally matched item names
  cards      – per-card results: {matched, quantity, rank, texts}
  rivens     – same, for detected riven cards
"""

import importlib
import json
import os
import re
import subprocess
import sys
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


# ---------------------------------------------------------------------------
# OCR primitive
# ---------------------------------------------------------------------------

def _pil_to_cgimage(img: Image.Image):
    img = img.convert("RGB")
    w, h = img.size
    raw = img.tobytes()
    provider = Quartz.CGDataProviderCreateWithData(None, raw, len(raw), None)
    cs = Quartz.CGColorSpaceCreateDeviceRGB()
    return Quartz.CGImageCreate(
        w, h, 8, 24, w * 3, cs,
        Quartz.kCGBitmapByteOrderDefault | Quartz.kCGImageAlphaNone,
        provider, None, False, Quartz.kCGRenderingIntentDefault,
    )


def _ocr_once(img: Image.Image, level: int, lang_correction: bool) -> list[dict]:
    cg = _pil_to_cgimage(img)
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg, {})
    req = Vision.VNRecognizeTextRequest.alloc().init()
    req.setRecognitionLevel_(level)
    req.setUsesLanguageCorrection_(lang_correction)
    handler.performRequests_error_([req], None)

    results = []
    for obs in (req.results() or []):
        cands = obs.topCandidates_(1)
        if not cands:
            continue
        text = str(cands[0].string())
        bb = obs.boundingBox()
        x = bb.origin.x
        y = 1.0 - bb.origin.y - bb.size.height  # flip to top-left
        results.append({
            "text": text,
            "x": round(x, 4),
            "y": round(y, 4),
            "w": round(bb.size.width, 4),
            "h": round(bb.size.height, 4),
        })
    return results


def vision_ocr_with_boxes(img: Image.Image) -> list[dict]:
    """Single-pass OCR (fast mode, language-corrected). Used for anchors."""
    return _ocr_once(img, level=0, lang_correction=True)


def vision_ocr_accurate(img: Image.Image) -> list[dict]:
    """Accurate-mode OCR. Catches small badge digits and rare names that the
    fast pass misses (e.g. 'Pilfering Swarm'). Slower and prone to merging
    adjacent cards into one long blob, so reserved for badge-only lookups."""
    return _ocr_once(img, level=1, lang_correction=False)


# ---------------------------------------------------------------------------
# Fuzzy matching
# ---------------------------------------------------------------------------

def _normalize(text: str) -> str:
    return "".join(ch for ch in text if ch.isascii() and ch.isalpha())


def _levenshtein(a: str, b: str) -> int:
    if len(a) < len(b):
        a, b = b, a
    if not b:
        return len(a)
    prev = list(range(len(b) + 1))
    for left in a:
        cur = [prev[0] + 1]
        for i, right in enumerate(b):
            cur.append(min(cur[i] + 1, prev[i + 1] + 1, prev[i] + (left != right)))
        prev = cur
    return prev[-1]


def fuzzy_match(needle: str, reference: list[str]) -> Optional[str]:
    norm = _normalize(needle)
    if not norm or len(norm) < 3:
        return None
    best, best_d = None, float("inf")
    for name in reference:
        d = _levenshtein(_normalize(name), norm)
        if d < best_d:
            best_d = d
            best = name
    if best is None:
        return None
    return best if best_d <= len(_normalize(best)) // 3 else None


# ---------------------------------------------------------------------------
# Reference data
# ---------------------------------------------------------------------------

def load_reference(scan_type: str, project_root: str) -> list[str]:
    data = os.path.join(project_root, "data")
    if scan_type == "mods":
        with open(os.path.join(data, "mods_all.json"), encoding="utf-8") as f:
            raw = json.load(f)
        if isinstance(raw, list) and raw and isinstance(raw[0], str):
            return raw
        return [x["name"] for x in raw if isinstance(x, dict) and "name" in x]
    else:
        PREFIXES = ("arcane", "molt", "residual", "virtuos", "magus", "exodia",
                    "theorem", "eternal", "cascadia")
        with open(os.path.join(data, "items_list.json"), encoding="utf-8") as f:
            raw = json.load(f)
        out = []
        for item in raw:
            slug = item.get("slug", "") if isinstance(item, dict) else item.lower()
            name = item.get("name", "") if isinstance(item, dict) else item
            if any(slug.lower().startswith(p) or name.lower().startswith(p) for p in PREFIXES):
                out.append(name)
        return out


def load_weapon_names(project_root: str) -> list[str]:
    """Riven-eligible weapon names from rivenWeaponRules.json (lowercase keys)."""
    data = os.path.join(project_root, "data")
    with open(os.path.join(data, "rivenWeaponRules.json"), encoding="utf-8") as f:
        rules = json.load(f)
    names = []
    for category in rules.values():
        names.extend(category.keys())
    return names


def _matches_weapon(text: str, weapon_names: list[str]) -> bool:
    words = text.strip().split()
    for n in range(1, min(4, len(words) + 1)):
        if fuzzy_match(" ".join(words[:n]), weapon_names) is not None:
            return True
    return False


# ---------------------------------------------------------------------------
# Grid size estimation
# ---------------------------------------------------------------------------

def _cluster_values(values: list[float], gap: float) -> list[float]:
    """Cluster sorted floats into groups, return group centres."""
    if not values:
        return []
    groups = [[values[0]]]
    for v in values[1:]:
        if v - groups[-1][-1] > gap:
            groups.append([v])
        else:
            groups[-1].append(v)
    return [sum(g) / len(g) for g in groups]


def estimate_card_size(anchors: list[dict]) -> tuple[float, float]:
    """
    Return (card_w, card_h) in coords normalised to the cropped image.
    card_w  = image_width  / num_columns  (anchors define column centres)
    card_h  = median vertical gap between consecutive row centres
              (mod names sit at the card bottom, so row-centre gap ≈ card height)
    """
    if not anchors:
        return 0.11, 0.30

    xs = sorted(a["x"] + a["w"] / 2 for a in anchors)
    ys = sorted(a["y"] + a["h"] / 2 for a in anchors)

    col_centres = _cluster_values(xs, gap=0.04)
    row_centres = _cluster_values(ys, gap=0.04)

    card_w = 1.0 / len(col_centres) if col_centres else 0.11

    if len(row_centres) >= 2:
        gaps = [row_centres[i + 1] - row_centres[i]
                for i in range(len(row_centres) - 1)]
        card_h = sum(gaps) / len(gaps)
    else:
        card_h = 0.30

    return card_w, card_h


# ---------------------------------------------------------------------------
# Per-card crop & OCR
# ---------------------------------------------------------------------------

def find_badge_observations(
    anchor: dict,
    badge_pool: list[dict],
    col_w: float,
    row_h: float,
) -> list[dict]:
    """
    Find the quantity badge observation(s) for this card.

    Rules:
    - Same column  : obs x-centre within ± 0.52 * col_w of anchor centre
    - Above name   : obs y-centre < anchor["y"]   (badge is above the mod name)
    - Within card  : obs y-centre > anchor["y"] - row_h  (don't go into the row above)

    row_h clamp: for the first visible row the card may be partially cropped,
    so we use max(0, anchor_y - row_h) as the upper boundary — this naturally
    expands the window to the image top rather than going negative.
    """
    cx = anchor["x"] + anchor["w"] / 2
    ay = anchor["y"]  # top edge of mod-name text ≈ bottom portion of the card

    left   = cx - col_w * 0.52
    right  = cx + col_w * 0.52
    top    = max(0.0, ay - row_h)   # never go above the image
    bottom = ay                      # everything strictly above the mod name

    return [
        o for o in badge_pool
        if left  <= o["x"] + o["w"] / 2 <= right
        and top  <= o["y"] + o["h"] / 2 <  bottom
    ]


def _parse_badge(text: str) -> Optional[int]:
    """Extract the first integer from badge text like 'F24', '• 299', '1203', '10-'."""
    m = re.search(r'(\d+)', text)
    return int(m.group(1)) if m else None


def parse_card_ocr(card_obs: list[dict], anchor_name: str,
                   reference: list[str], scan_type: str) -> dict:
    """
    Extract quantity from a single isolated card OCR.

    Rules (rank not needed):
    - Prefixed obs  ("• 320", "Г 138", "F299") → number after icon = qty  ✓
    - Multi-number  ("4 64", "5 62")           → max of nums = qty  ✓
      (Vision merges icon-digit + space + qty into one obs)
    - Bare ≥ 100    ("524", "1278", "4108")    → strip first digit = qty  ✓
      (icon was misread as a single leading digit)
    - Bare < 100    ("68", "4")                → take as-is  ✓
    """
    matched_name = fuzzy_match(anchor_name, reference)
    texts = [o["text"] for o in card_obs]
    qty_candidates: list[int] = []

    for o in card_obs:
        s = o["text"].strip()
        has_prefix = bool(re.match(r'^[^\d\s]', s))
        nums = [int(m) for m in re.findall(r'\d+', s)]
        if not nums:
            continue

        if has_prefix:
            for n in nums:
                qty_candidates.append(n)
                # 4+ digits in a prefixed obs almost always means the icon
                # was glued to the qty (e.g. '. 1203' → real qty is 203)
                if n >= 1000:
                    stripped = int(str(n)[1:])
                    if stripped > 0:
                        qty_candidates.append(stripped)
        elif len(nums) >= 2:
            qty_candidates.append(max(nums))
        else:
            n = nums[0]
            if n >= 100:
                stripped = int(str(n)[1:])
                qty_candidates.append(stripped if stripped > 0 else n)
            else:
                qty_candidates.append(n)

    # When multiple observations agree on a value, prefer that one over
    # outliers (e.g. raw 1203 from a glued icon-digit vs. stripped 203).
    if qty_candidates:
        from collections import Counter
        counts = Counter(qty_candidates)
        max_freq = max(counts.values())
        if max_freq >= 2:
            qty_candidates = [v for v, c in counts.items() if c == max_freq]

    return {
        "matched":   matched_name,
        "quantity":  max(qty_candidates) if qty_candidates else None,
        "texts":     texts,
        "qty_debug": qty_candidates,
    }


# ---------------------------------------------------------------------------
# Crop config
# ---------------------------------------------------------------------------

CROP = {
    "mods":    {"top": 0.48, "bottom": 0.88},
    "arcanes": {"top": 0.20, "bottom": 0.90},
}


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    if len(sys.argv) < 3:
        sys.exit("Usage: inventory_ocr_debug.py <screenshot_path> <scan_type>")

    path, scan_type = sys.argv[1], sys.argv[2]
    if not os.path.exists(path):
        sys.exit(f"File not found: {path}")

    project_root = os.path.dirname(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    )
    reference    = load_reference(scan_type, project_root)
    weapon_names = load_weapon_names(project_root)

    image = Image.open(path)
    crop  = CROP.get(scan_type, {"top": 0.30, "bottom": 0.90})
    iw, ih = image.size
    top_px = int(ih * crop["top"])
    bot_px = int(ih * crop["bottom"])
    image  = image.crop((0, top_px, iw, bot_px))
    print(f"[debug] crop: y={top_px}..{bot_px}px  (original {iw}x{ih})", file=sys.stderr)

    # ── Pass 1: full-image OCR to locate anchors ────────────────────────────
    observations = vision_ocr_with_boxes(image)
    raw_lines    = [o["text"] for o in observations]

    # Global match list (unchanged from original)
    matched_global: list[str] = []
    seen: set[str] = set()
    for idx, line in enumerate(raw_lines):
        candidates = [line]
        if idx + 1 < len(raw_lines):
            candidates.append(f"{line.strip()} {raw_lines[idx + 1].strip()}")
        for c in candidates:
            name = fuzzy_match(c, reference)
            if name and name not in seen:
                seen.add(name)
                matched_global.append(name)
                break

    # Filter tooltip / long description lines
    def _is_card_text(o: dict) -> bool:
        text  = o["text"].strip()
        words = text.split()
        if len(words) > 3:
            return False
        if any(c in text for c in [".", ","]) and any(w and w[0].islower() for w in words):
            return False
        return True

    filtered = [o for o in observations if _is_card_text(o)]

    # Classify anchors
    mod_anchors   = [o for o in filtered if fuzzy_match(o["text"], reference) is not None]
    riven_anchors = [o for o in filtered
                     if fuzzy_match(o["text"], reference) is None
                     and _matches_weapon(o["text"], weapon_names)]

    all_anchors = mod_anchors + riven_anchors

    # Use known fixed card size: 224×90 px in a 1920-wide image.
    # Crop region height = (bottom - top) * 1080. For mods: (0.88-0.48)*1080 = 432 px.
    crop_h_px = (crop["bottom"] - crop["top"]) * 1080
    card_w = 224 / 1920            # ≈ 0.117
    card_h = 90  / crop_h_px      # ≈ 0.208 for mods (varies by scan_type crop)

    # Fallback to estimation only when the known crop is non-standard
    if scan_type not in ("mods", "arcanes"):
        card_w, card_h = estimate_card_size(all_anchors)

    print(f"[debug] anchors: {len(mod_anchors)} mods, {len(riven_anchors)} rivens  "
          f"card≈{card_w:.3f}w × {card_h:.3f}h  badge_pool={len([o for o in filtered if id(o) not in {id(a) for a in all_anchors}])}",
          file=sys.stderr)

    # ── Pass 2: spatial badge lookup ────────────────────────────────────────
    # Augment with an accurate-mode OCR pass — it catches small badge digits
    # that the fast pass misses (e.g. '77', '62', '46'). We add these obs to
    # the badge pool but do NOT use them for anchor classification (accurate
    # mode merges adjacent cards into long blobs).
    accurate_obs = vision_ocr_accurate(image)
    accurate_filtered = [o for o in accurate_obs if _is_card_text(o)]

    # Dedup against existing observations by (text, ~position).
    def _pos_key(o: dict) -> tuple:
        cx = o["x"] + o["w"] / 2
        cy = o["y"] + o["h"] / 2
        return (o["text"].strip(), round(cx, 2), round(cy, 2))
    existing_keys = {_pos_key(o) for o in filtered}

    # Anchor centres — used to drop any accurate-pass obs that lies right on
    # top of an existing anchor (these are usually corrupted name variants).
    anchor_centres = [(a["x"] + a["w"] / 2, a["y"] + a["h"] / 2)
                      for a in mod_anchors + riven_anchors]

    def _near_anchor(o: dict) -> bool:
        cx = o["x"] + o["w"] / 2
        cy = o["y"] + o["h"] / 2
        return any(abs(cx - ax) < 0.03 and abs(cy - ay) < 0.02
                   for ax, ay in anchor_centres)

    extra = [o for o in accurate_filtered
             if _pos_key(o) not in existing_keys and not _near_anchor(o)]

    # Promote accurate-pass obs to anchors if they match the reference list
    # but the fast pass missed them (e.g. 'Pilfering Swarm').
    promoted_anchors = []
    for o in list(extra):
        if fuzzy_match(o["text"], reference) is not None:
            promoted_anchors.append(o)
            extra.remove(o)
    if promoted_anchors:
        mod_anchors = mod_anchors + promoted_anchors
        print(f"[debug] promoted {len(promoted_anchors)} accurate-pass anchors: "
              f"{[a['text'] for a in promoted_anchors]}", file=sys.stderr)

    # Exclude all anchor observations from badge search so that mod names in
    # the row above never leak into the badge region of the card below.
    anchor_ids = {id(o) for o in mod_anchors + riven_anchors}
    badge_pool = [o for o in filtered if id(o) not in anchor_ids] + extra

    def _lookup_anchor(anchor: dict, ref: list[str]) -> dict:
        badge_obs = find_badge_observations(anchor, badge_pool, card_w, card_h)
        cx  = anchor["x"] + anchor["w"] / 2
        ay  = anchor["y"]
        top = max(0.0, ay - card_h)
        print(f"[debug]  anchor '{anchor['text'][:20]}' cx={cx:.3f} ay={ay:.3f} "
              f"window=[{top:.3f},{ay:.3f}) badges={len(badge_obs)} "
              f"texts={[o['text'] for o in badge_obs]}", file=sys.stderr)
        return parse_card_ocr(badge_obs, anchor["text"], ref, scan_type)

    def _sort_key(a: dict) -> tuple:
        return (round((a["y"] + a["h"] / 2) / 0.15), a["x"] + a["w"] / 2)

    cards  = [_lookup_anchor(a, reference)    for a in sorted(mod_anchors,   key=_sort_key)]
    rivens = [_lookup_anchor(a, weapon_names) for a in sorted(riven_anchors, key=_sort_key)]

    # Report observations that were never claimed by any card's window.
    claimed_ids: set[int] = set()
    for a in mod_anchors + riven_anchors:
        for o in find_badge_observations(a, badge_pool, card_w, card_h):
            claimed_ids.add(id(o))
    orphans = [o for o in badge_pool if id(o) not in claimed_ids]
    # Also include filtered-out (long/tooltip) obs so we can see if a badge
    # was dropped by _is_card_text.
    filtered_out = [o for o in observations
                    if id(o) not in {id(x) for x in filtered}]
    print(f"[debug] orphan badge_pool obs ({len(orphans)}):", file=sys.stderr)
    for o in orphans:
        cx = o["x"] + o["w"] / 2
        cy = o["y"] + o["h"] / 2
        print(f"[debug]    text={o['text']!r:30s} cx={cx:.3f} cy={cy:.3f} "
              f"box=(x={o['x']:.3f} y={o['y']:.3f} w={o['w']:.3f} h={o['h']:.3f})",
              file=sys.stderr)
    print(f"[debug] dropped by _is_card_text ({len(filtered_out)}):", file=sys.stderr)
    for o in filtered_out:
        cx = o["x"] + o["w"] / 2
        cy = o["y"] + o["h"] / 2
        print(f"[debug]    text={o['text']!r:40s} cx={cx:.3f} cy={cy:.3f}",
              file=sys.stderr)

    print(json.dumps({
        "scan_type":  scan_type,
        "raw_lines":  raw_lines,
        "matched":    sorted(matched_global),
        "cards":      cards,
        "rivens":     rivens,
        "observations": observations,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
