#!/usr/bin/env bash
# Downloads a relocatable CPython (python-build-standalone) and installs the
# OCR dependencies into it. The result lives in <repo>/python/ and is bundled
# into the .app so end users don't need to install Python/pyobjc themselves.
#
# Re-run whenever you bump PY_VERSION/PY_RELEASE or need to refresh the packages.
set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$DIR/python"

PY_VERSION="3.12.14"
PY_RELEASE="20260814"
TARBALL="cpython-${PY_VERSION}+${PY_RELEASE}-aarch64-apple-darwin-install_only.tar.gz"
URL="https://github.com/astral-sh/python-build-standalone/releases/download/${PY_RELEASE}/${TARBALL}"

echo "==> Downloading $TARBALL"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
curl -fL --retry 3 -o "$TMP/$TARBALL" "$URL"

echo "==> Extracting to $DEST"
rm -rf "$DEST"
mkdir -p "$DEST"
tar -xzf "$TMP/$TARBALL" -C "$DEST" --strip-components=1

PY="$DEST/bin/python3"
if [ ! -x "$PY" ]; then
    echo "error: $PY not found after extraction" >&2
    exit 1
fi

echo "==> Installing OCR dependencies (pyobjc Vision/Quartz, numpy, Pillow)"
"$PY" -m pip install --quiet --break-system-packages \
    pyobjc-framework-Vision \
    pyobjc-framework-Quartz \
    numpy \
    Pillow

echo "==> Trimming unused modules (tests, pycache, tkinter, idle...)"
find "$DEST/lib" -name "__pycache__" -type d -prune -exec rm -rf {} + 2>/dev/null || true
rm -rf \
    "$DEST/lib/python3.12/test" \
    "$DEST/lib/python3.12/idlelib" \
    "$DEST/lib/python3.12/tkinter" \
    "$DEST/lib/python3.12/lib2to3" \
    "$DEST/lib/python3.12/turtledemo" \
    "$DEST/lib/python3.12/pydoc_data" \
    "$DEST/lib/python3.12/ensurepip" \
    "$DEST/lib/python3.12/site-packages/numpy/tests" \
    "$DEST/lib/python3.12/site-packages/numpy/_core/tests" \
    2>/dev/null || true

echo "==> Verifying imports"
"$PY" -c "import Vision, Quartz, numpy, PIL; print('Vision/Quartz/numpy/PIL OK')"

echo "==> Done. Bundled Python ready at $DEST"
