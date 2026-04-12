#!/usr/bin/env python3
"""
OCR para analise de builds do Warframe.
Recebe path de imagem, faz OCR completo e retorna JSON com os textos detectados.
"""

import importlib
import json
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


def ocr_full_image(path):
    img = Image.open(path).convert("RGB")
    width, height = img.size
    raw = img.tobytes()
    provider = Quartz.CGDataProviderCreateWithData(None, raw, len(raw), None)
    color_space = Quartz.CGColorSpaceCreateDeviceRGB()
    cg_image = Quartz.CGImageCreate(
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
    handler = Vision.VNImageRequestHandler.alloc().initWithCGImage_options_(cg_image, {})
    request = Vision.VNRecognizeTextRequest.alloc().init()
    request.setRecognitionLevel_(0)
    handler.performRequests_error_([request], None)

    texts = []
    for observation in request.results() or []:
        candidates = observation.topCandidates_(1)
        if candidates:
            texts.append(str(candidates[0].string()))
    return texts


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("Usage: ocr_vision_build.py <image_path>")
    print(json.dumps(ocr_full_image(sys.argv[1])))
