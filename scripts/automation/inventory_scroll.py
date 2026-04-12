#!/usr/bin/env python3
"""
Scroll the Warframe inventory grid.

Assumes Wine/Warframe is already focused (focus is set once at scan start).
No osascript here — avoids multi-process focus conflicts when called rapidly.

Usage: /usr/bin/python3 inventory_scroll.py <mods|arcanes>
"""

import subprocess
import sys

import Quartz
from Quartz import (
    CGEventCreateScrollWheelEvent,
    CGEventCreateMouseEvent,
    CGEventSetLocation,
    CGEventPost,
    kCGHIDEventTap,
    kCGEventMouseMoved,
    kCGMouseButtonLeft,
    kCGWindowListOptionOnScreenOnly,
    kCGNullWindowID,
)
from Quartz.CoreGraphics import CGPointMake

kCGSessionEventTap = 1
DELTA_MODS = -14
DELTA_FINE = -5   # arcanes


def wine_pid():
    result = subprocess.run(["pgrep", "-x", "wine"], capture_output=True, text=True)
    pids = result.stdout.strip().split()
    return int(pids[0]) if pids else None


def warframe_window_bounds():
    wins = Quartz.CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID)
    for w in wins:
        if w.get("kCGWindowName") == "Warframe":
            return w.get("kCGWindowBounds", {})
    return {}


def scroll(scan_type: str) -> None:
    b = warframe_window_bounds()
    mode = Quartz.CGDisplayCopyDisplayMode(Quartz.CGMainDisplayID())
    win_w = b.get("Width",  Quartz.CGDisplayModeGetWidth(mode))
    win_h = b.get("Height", Quartz.CGDisplayModeGetHeight(mode))
    ox    = b.get("X", 0)
    oy    = b.get("Y", 0)

    # Physical cursor: right edge (x=97%) — safe zone, no item cards there
    cursor_x = ox + win_w * (1870 / 1920)
    cursor_y = oy + win_h * (520  / 1080)
    cursor_pt = CGPointMake(cursor_x, cursor_y)

    delta = DELTA_MODS if scan_type == "mods" else DELTA_FINE

    # Move physical cursor to safe zone (Wine needs cursor inside its window)
    move = CGEventCreateMouseEvent(None, kCGEventMouseMoved, cursor_pt, kCGMouseButtonLeft)
    CGEventPost(kCGHIDEventTap, move)

    # Post scroll event
    event = CGEventCreateScrollWheelEvent(None, 1, 1, delta)
    CGEventSetLocation(event, cursor_pt)
    CGEventPost(kCGSessionEventTap, event)

    pid = wine_pid()
    if pid:
        try:
            Quartz.CGEventPostToPid(pid, event)
        except Exception:
            pass


if __name__ == "__main__":
    scan_type = sys.argv[1] if len(sys.argv) > 1 else "arcanes"
    scroll(scan_type)
