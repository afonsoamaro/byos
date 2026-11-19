#!/usr/bin/env bash
# Renders the brand pages in docs/brand/ to PNG.
# Each page is screenshotted by headless Chrome at 2x and downscaled with ImageMagick,
# which gives cleaner antialiasing than a 1x render. docs/logo.svg is the single source:
# edit it, rerun this script, commit the PNGs.
#
# Usage: scripts/render-brand.sh [all|directions|header|social]
# Requires Google Chrome and ImageMagick 7 (magick). Override the Chrome path with CHROME=...
set -euo pipefail

cd "$(dirname "$0")/.."

CHROME="${CHROME:-/Applications/Google Chrome.app/Contents/MacOS/Google Chrome}"

if [ ! -x "$CHROME" ]; then
  echo "render-brand: Chrome not found at '$CHROME' (set CHROME=/path/to/chrome)" >&2
  exit 1
fi
if ! command -v magick >/dev/null 2>&1; then
  echo "render-brand: ImageMagick 7 'magick' not found in PATH" >&2
  exit 1
fi

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

# render <html> <png> <width> <height>
render() {
  local html="$1" png="$2" width="$3" height="$4"
  if [ ! -f "$html" ]; then
    echo "render-brand: skipping $png, $html does not exist yet"
    return 0
  fi
  local shot="$TMP_DIR/shot@2x.png"
  rm -f "$shot"
  # A throwaway profile keeps headless Chrome off the profile of a Chrome window already open.
  if ! "$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --user-data-dir="$TMP_DIR/profile" --window-size="$width,$height" --screenshot="$shot" \
    "file://$PWD/$html" 2>"$TMP_DIR/chrome.log" || [ ! -s "$shot" ]; then
    echo "render-brand: Chrome produced no screenshot for $html; its last log lines:" >&2
    tail -5 "$TMP_DIR/chrome.log" >&2
    exit 1
  fi
  magick "$shot" -resize "${width}x${height}!" -strip -define png:compression-level=9 "$png"
  magick identify -format '%f %wx%h\n' "$png"
}

target="${1:-all}"
case "$target" in
  directions) render docs/brand/directions.html docs/brand/directions.png 1600 900 ;;
  header) render docs/brand/header.html docs/header.png 1200 630 ;;
  social) render docs/brand/social-preview.html docs/social-preview.png 1280 640 ;;
  all)
    render docs/brand/directions.html docs/brand/directions.png 1600 900
    render docs/brand/header.html docs/header.png 1200 630
    render docs/brand/social-preview.html docs/social-preview.png 1280 640
    ;;
  *)
    echo "render-brand: unknown target '$target' (use all, directions, header or social)" >&2
    exit 2
    ;;
esac
