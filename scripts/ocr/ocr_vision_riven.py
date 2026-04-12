#!/usr/bin/env python3
"""
OCR + parser para screenshots de Riven Mods do Warframe.
Detecta automaticamente 1 ou 2 cards na imagem usando bounding boxes.

Saída JSON:
  { mode: "single", riven: ParsedRiven }
  { mode: "compare", riven1: ParsedRiven, riven2: ParsedRiven }
  { error: "..." }
"""

import importlib
import json
import re
import subprocess
import sys


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

# Maps OCR display text (lowercase) → rivenStats.json key
STAT_ALIASES = {
    "critical chance": "critical_chance",
    "critical damage": "critical_damage",
    "multishot": "multishot",
    "multi shot": "multishot",
    "damage": "damage",
    "fire rate": "fire_rate",
    "fire rate (x2 for bows)": "fire_rate",
    "attack speed": "fire_rate",
    "status chance": "status_chance",
    "status duration": "status_duration",
    "toxin": "toxin",
    "heat": "heat",
    "cold": "cold",
    "electricity": "electricity",
    "slash": "slash",
    "impact": "impact",
    "puncture": "puncture",
    "reload speed": "reload_speed",
    "punch through": "punch_through",
    "magazine capacity": "magazine",
    "magazine": "magazine",
    "max ammo": "max_ammo",
    "ammo maximum": "max_ammo",
    "zoom": "zoom",
    "recoil": "recoil",
    "projectile speed": "projectile_speed",
    "flight speed": "projectile_speed",
    "heavy attack efficiency": "heavy_attack_efficiency",
    "initial combo": "initial_combo",
    "range": "range",
    "finisher damage": "finisher_damage",
    "slide attack": "slide_attack",
    # Faction stats — intentionally mapped to None (will be skipped)
    "damage to infested": None,
    "damage to grineer": None,
    "damage to corpus": None,
    "damage to corrupted": None,
    "damage to the infested": None,
    "damage to the grineer": None,
    "damage to the corpus": None,
}

TITLE_STOPWORDS = {
    "critical", "chance", "damage", "reload", "speed", "zoom", "status", "duration",
    "multishot", "heat", "cold", "electricity", "toxin", "slash", "impact", "puncture",
    "magazine", "ammo", "recoil", "projectile", "fire", "rate", "through",
}


def ocr_with_boxes(image_path):
    """
    Run Apple Vision OCR and return (list of (text, x_center), (width, height)).
    x_center is normalized 0..1 (left edge = 0, right edge = 1).
    Vision boundingBox origin is bottom-left, y increases upward — we only use x.
    """
    img = Image.open(image_path).convert("RGB")
    width, height = img.size
    raw = img.tobytes()
    provider = Quartz.CGDataProviderCreateWithData(None, raw, len(raw), None)
    color_space = Quartz.CGColorSpaceCreateDeviceRGB()
    cg_image = Quartz.CGImageCreate(
        width, height, 8, 24, width * 3,
        color_space,
        Quartz.kCGBitmapByteOrderDefault | Quartz.kCGImageAlphaNone,
        provider, None, False, Quartz.kCGRenderingIntentDefault,
    )

    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg_image, {})
    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLevel_(0)
    handler.performRequests_error_([request], None)

    results = []
    for obs in request.results() or []:
        candidates = obs.topCandidates_(1)
        if not candidates:
            continue
        text = str(candidates[0].string()).strip()
        if not text:
            continue
        bbox = obs.boundingBox()
        x_min = Quartz.CGRectGetMinX(bbox)
        x_width = Quartz.CGRectGetWidth(bbox)
        x_center = x_min + x_width / 2.0
        results.append((text, x_center))

    return results, (width, height)


def _find_largest_gap(observations):
    xs = sorted(obs[1] for obs in observations)
    split_x = 0.5
    max_gap = 0.0
    for i in range(len(xs) - 1):
        gap = xs[i + 1] - xs[i]
        if gap > max_gap:
            max_gap = gap
            split_x = (xs[i] + xs[i + 1]) / 2.0
    return max_gap, split_x


def detect_split(observations, img_width=1, img_height=1):
    """
    Detect if there are 2 spatially distinct card clusters (two rivens side by side).

    A single card in portrait orientation (height >= width) can never be two cards.
    For landscape images, look for a large gap (>threshold) between consecutive
    x_centers — a gap that big only appears between two separate card clusters.
    """
    # Portrait / near-square → definitely a single card
    if img_height >= img_width * 0.9:
        return False
    if len(observations) < 4:
        return False

    # Two separate mod-name lines are a strong signal for comparison mode.
    mod_like = [
        obs for obs in observations
        if re.search(r'\b[A-Z][a-z]+-[A-Za-z]+\b', obs[0])
    ]
    if len(mod_like) >= 2:
        mod_xs = sorted(obs[1] for obs in mod_like)
        if mod_xs[-1] - mod_xs[0] >= 0.20:
            return True

    max_gap, split_x = _find_largest_gap(observations)
    left_count = sum(1 for _, x in observations if x < split_x)
    right_count = len(observations) - left_count
    aspect_ratio = img_width / max(img_height, 1)

    # The previous fixed 0.35 threshold was too strict for many side-by-side
    # screenshots. Use a lower threshold on clearly wide images, but still
    # require text on both sides of the inferred split.
    threshold = 0.16 if aspect_ratio >= 1.4 else 0.20
    return max_gap > threshold and left_count >= 2 and right_count >= 2


def split_observations(observations):
    """Divide observations into left/right at the largest x_center gap."""
    _, split_x = _find_largest_gap(observations)

    left = [o for o in observations if o[1] < split_x]
    right = [o for o in observations if o[1] >= split_x]
    return left, right


def parse_stat_line(text):
    """
    Try to parse a stat line from OCR text.
    Handles:
      +60,2% Fire Rate (x2 for Bows)  →  fire_rate, 60.2, positive
      -42,9% Magazine Capacity        →  magazine, 42.9, negative
      x1,46 Damage to Infested        →  None (faction stat, skip)
    Returns (stat_key, display_name, value, is_negative) or None if not a stat line.
    stat_key may be None for explicitly-ignored faction stats.
    """
    t = text.strip()

    # Standard:
    #   +173,5% Critical Chance
    #   -65,5% Zoom
    #   +3,7 Punch Through
    m = re.match(r'^([+-]?\d+[,.]?\d*)\s*(%)?\s+(.+)$', t)
    if m:
        raw_val = m.group(1).replace(',', '.')
        has_percent = m.group(2) == '%'
        display = m.group(3).strip()

        # Unsigned numeric lines without % are usually metadata/noise, not stats.
        if not has_percent and not raw_val.startswith(('+', '-')):
            return None

        raw_val = m.group(1).replace(',', '.')
        try:
            value = float(raw_val)
        except ValueError:
            return None
        # Strip parenthetical suffix e normalize leading OCR symbols such as
        # "›Impact" or "• Zoom".
        display_clean = re.sub(r'\s*\(.*?\)\s*$', '', display).strip()
        display_clean = _clean_stat_name(display_clean)
        is_neg = value < 0
        value = abs(value)

        key_lookup = display_clean.lower()
        if key_lookup in STAT_ALIASES:
            stat_key = STAT_ALIASES[key_lookup]
        else:
            # Fallback: normalize to underscore key
            stat_key = key_lookup.replace(' ', '_')

        return stat_key, display_clean, value, is_neg

    # Faction multiplier: x1,46 Damage to Infested
    m = re.match(r'^x(\d+[,.]?\d*)\s+(.+)$', t, re.IGNORECASE)
    if m:
        display = m.group(2).strip()
        stat_key = STAT_ALIASES.get(display.lower())  # None for faction stats
        try:
            value = float(m.group(1).replace(',', '.'))
        except ValueError:
            value = 0.0
        return stat_key, display, value, False

    return None


def split_combined_stat_lines(text):
    """
    Split OCR lines that accidentally merge multiple stats, e.g.
      "+3.7 Punch Through +173.5% Critical Chance"
    into separate candidate lines.
    """
    t = re.sub(r'\s+', ' ', text.strip())
    if not t:
        return []

    starts = [m.start() for m in re.finditer(r'(?=[+-]\d+[,.]?\d*\s*%?\s+[A-Za-z])', t)]
    if len(starts) <= 1:
        return [t]

    parts = []
    for i, start in enumerate(starts):
        end = starts[i + 1] if i + 1 < len(starts) else len(t)
        part = t[start:end].strip(" ,;/")
        if part:
            parts.append(part)
    return parts or [t]


def extract_weapon_from_mod_name(mod_name):
    """
    Extract weapon name from the riven mod name.
    "Tiberon Pura-cronitis"  →  "Tiberon"
    "Kuva Bramma Visi-acripha"  →  "Kuva Bramma"
    Strips the final generated "Prefix-Suffix" token.
    """
    if not mod_name:
        return None
    m = re.match(r'^(.+?)\s+[A-Z][a-z]+-[A-Za-z]+\s*$', mod_name)
    if m:
        return m.group(1).strip()
    # Fallback: first word
    return mod_name.split()[0] if mod_name else None


def is_probable_mod_name(text):
    """
    Detect title lines like:
      Torid Critatis
      Torid Visi-fevacron
    while avoiding stats, notes and metadata lines.
    """
    t = text.strip()
    if not t:
        return False
    if re.search(r'[%\d]', t):
        return False
    if t.startswith("(") or t.lower().startswith("note:"):
        return False
    if re.match(r'^(MR|Rifle|Shotgun|Pistol|Melee|Archgun)\b', t, re.IGNORECASE):
        return False
    if parse_stat_line(t) is not None:
        return False

    words = re.findall(r"[A-Za-z][A-Za-z'-]*", t)
    if not 1 <= len(words) <= 3:
        return False
    if " ".join(words) != t.replace("’", "'"):
        return False

    lower_words = [w.lower() for w in words]
    if all(word in TITLE_STOPWORDS for word in lower_words):
        return False

    return all(word[0].isupper() for word in words)


def _clean_stat_name(raw):
    """Strip leading bullet/emoji/punctuation from OCR'd stat names like '• Heat' or '🔥Heat'."""
    # Remove leading non-letter characters (bullets, emojis, dashes, etc.)
    cleaned = re.sub(r'^[^\w]+', '', raw).strip()
    return cleaned if cleaned else raw


def _resolve_stat_key(display_name):
    key_lookup = display_name.lower()
    if key_lookup in STAT_ALIASES:
        return STAT_ALIASES[key_lookup]
    return key_lookup.replace(' ', '_') if key_lookup else None


def _is_stat_name_continuation(text):
    t = text.strip()
    if not t:
        return False
    if parse_stat_line(t) is not None:
        return False
    if re.search(r'[%\d]', t):
        return False
    if re.match(r'^(MR|Rifle|Shotgun|Pistol|Melee|Archgun)\b', t, re.IGNORECASE):
        return False
    if t.startswith("(") or t.lower().startswith("note:"):
        return False
    words = re.findall(r"[A-Za-z][A-Za-z'-]*", t)
    return 1 <= len(words) <= 2 and " ".join(words) == t.replace("’", "'")


def parse_riven(observations):
    """Parse a list of (text, x_center) into a riven dict."""
    positives = []
    negative = None
    rerolls = 0
    mastery = 0
    mod_name = None
    raw_texts = [t for t, _ in observations]

    # pending_value: set when OCR splits "+8,3%" and "• Heat" onto separate lines
    pending_value = None  # (float_value, is_negative)

    expanded_observations = []
    for text, x_center in observations:
        for part in split_combined_stat_lines(text):
            expanded_observations.append((part, x_center))

    raw_texts = [t for t, _ in expanded_observations]

    i = 0
    while i < len(expanded_observations):
        text, _ = expanded_observations[i]
        t = text.strip()
        if not t:
            i += 1
            continue

        # Try full stat line first ("+8,3% Fire Rate")
        parsed = parse_stat_line(t)
        if parsed is not None:
            pending_value = None
            stat_key, display, value, is_neg = parsed
            if i + 1 < len(expanded_observations):
                next_text = expanded_observations[i + 1][0].strip()
                if _is_stat_name_continuation(next_text):
                    combined_display = f"{display} {_clean_stat_name(next_text)}".strip()
                    combined_key = _resolve_stat_key(combined_display)
                    # Warframe sometimes wraps long stat names in the card art:
                    # "-50.7% Heavy Attack" + "Efficiency" should be one stat.
                    if combined_key in STAT_ALIASES.values():
                        display = combined_display
                        stat_key = combined_key
                        i += 1
            if stat_key is None:
                i += 1
                continue  # faction stat or intentionally skipped
            entry = {"stat": stat_key, "displayName": display, "value": value}
            if is_neg:
                negative = entry
            else:
                positives.append(entry)
            i += 1
            continue

        # Value-only line: "+8,3%" with no stat name (OCR split by emoji/icon)
        m = re.match(r'^([+-]?\d+[,.]?\d*)\s*%\s*$', t)
        if m:
            try:
                fval = float(m.group(1).replace(',', '.'))
                pending_value = (abs(fval), fval < 0)
            except ValueError:
                pending_value = None
            i += 1
            continue

        # If previous line was a value-only, treat this line as the stat name
        if pending_value is not None:
            name_clean = _clean_stat_name(t)
            stat_key = _resolve_stat_key(name_clean)
            if not stat_key:
                pending_value = None
                i += 1
                continue
            value, is_neg = pending_value
            pending_value = None
            if stat_key is None:
                i += 1
                continue  # faction stat
            entry = {"stat": stat_key, "displayName": name_clean, "value": value}
            if is_neg:
                negative = entry
            else:
                positives.append(entry)
            i += 1
            continue

        # Mod name detection: accept both the regular generated suffix and OCR'd
        # two-word titles like "Torid Critatis".
        if mod_name is None and is_probable_mod_name(t):
            mod_name = t
            i += 1
            continue

        # Rerolls: ↺1 or ⟳1 or "1 Reroll(s)"
        m = re.search(r'[↺⟳☯]\s*(\d+)', t)
        if m:
            rerolls = int(m.group(1))
            i += 1
            continue
        m = re.search(r'(\d+)\s+[Rr]eroll', t)
        if m:
            rerolls = int(m.group(1))
            i += 1
            continue

        # MR: "MR 12"
        m = re.match(r'^MR\s+(\d+)$', t, re.IGNORECASE)
        if m:
            mastery = int(m.group(1))
            i += 1
            continue

        i += 1

    weapon_guess = extract_weapon_from_mod_name(mod_name)

    return {
        "modName": mod_name,
        "weaponGuess": weapon_guess,
        "positives": positives,
        "negative": negative,
        "rerolls": rerolls,
        "mastery": mastery,
        "rawTexts": raw_texts,
    }


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"error": "Usage: ocr_vision_riven.py <image_path>"}))
        sys.exit(1)

    image_path = sys.argv[1]

    try:
        observations, (img_w, img_h) = ocr_with_boxes(image_path)
    except Exception as e:
        print(json.dumps({"error": f"OCR failed: {e}"}))
        sys.exit(1)

    if not observations:
        print(json.dumps({"error": "No text detected in image"}))
        sys.exit(1)

    if detect_split(observations, img_w, img_h):
        left, right = split_observations(observations)
        result = {
            "mode": "compare",
            "riven1": parse_riven(left),
            "riven2": parse_riven(right),
        }
    else:
        result = {
            "mode": "single",
            "riven": parse_riven(observations),
        }

    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
