#!/usr/bin/env python3
"""
Executa a sequência de cliques na Forja do Warframe.

Usage: /usr/bin/python3 forja_click.py <item_key>
  item_key: "decodificador_1x"
"""

import subprocess
import sys
import time

import Quartz
from Quartz import (
    CGEventCreateMouseEvent,
    CGEventPost,
    kCGEventLeftMouseDown,
    kCGEventLeftMouseUp,
    kCGEventMouseMoved,
    kCGHIDEventTap,
    kCGMouseButtonLeft,
)
from Quartz.CoreGraphics import CGPointMake

# Per-item config — add new items here as needed.
# Coordinates are calibrated for 1920×1080.
ITEMS = {
    "decodificador_1x": {
        "btn_card": (650, 350),  # collect / CONSTRUIR card
        "btn_ok":   (866, 575),  # OK confirmation dialog
        "delay_collect": 3.5,    # seconds to wait for CONSTRUIR to appear
        "delay_build":   1.5,    # seconds to wait for confirm dialog
    },
}


def focus_wine():
    script = (
        'tell application "System Events"\n'
        '    repeat with proc in every process\n'
        '        if name of proc is "wine" then\n'
        '            set frontmost of proc to true\n'
        '        end if\n'
        '    end repeat\n'
        'end tell'
    )
    subprocess.run(["osascript", "-e", script], capture_output=True)
    time.sleep(1.5)


def quartz_click(x, y):
    point = CGPointMake(x, y)
    move = CGEventCreateMouseEvent(None, kCGEventMouseMoved, point, kCGMouseButtonLeft)
    CGEventPost(kCGHIDEventTap, move)
    time.sleep(0.3)
    down = CGEventCreateMouseEvent(None, kCGEventLeftMouseDown, point, kCGMouseButtonLeft)
    up   = CGEventCreateMouseEvent(None, kCGEventLeftMouseUp,   point, kCGMouseButtonLeft)
    CGEventPost(kCGHIDEventTap, down)
    time.sleep(0.05)
    CGEventPost(kCGHIDEventTap, up)


if __name__ == "__main__":
    item_key = sys.argv[1] if len(sys.argv) > 1 else "decodificador_1x"
    cfg = ITEMS.get(item_key, ITEMS["decodificador_1x"])

    focus_wine()
    quartz_click(*cfg["btn_card"])    # collect finished item
    time.sleep(cfg["delay_collect"])
    quartz_click(*cfg["btn_card"])    # click CONSTRUIR
    time.sleep(cfg["delay_build"])
    quartz_click(*cfg["btn_ok"])      # confirm OK
