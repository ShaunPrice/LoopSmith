#!/usr/bin/env bash
# Produce a ready-to-flash LoopSmith companion image from a stock Raspberry Pi OS Lite
# image, on a Mac: the stock image + the kit on its boot partition, recompressed.
#
#   pi/image/build_image.sh <raspios-lite-<arch>.img[.xz]> <label> [looper.conf]
#   e.g.  pi/image/build_image.sh raspios-lite-arm64.img.xz arm64
#         -> dist/LoopSmith-companion-arm64.img.xz (+ .sha256)
#
# Flash the result with Raspberry Pi Imager ("Use custom") or Etcher — no further steps.
# The root filesystem is untouched; everything else happens on the Pi's first boot.
set -euo pipefail
SRC=${1:-}; LABEL=${2:-}; CONF=${3:-}
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
[ -f "$SRC" ] && [ -n "$LABEL" ] || { sed -n 2,10p "$0"; exit 1; }
DIST="$REPO/dist"; mkdir -p "$DIST"
WORK="${TMPDIR:-/tmp}/gls-image-$LABEL"; rm -rf "$WORK"; mkdir -p "$WORK"
IMG="$WORK/LoopSmith-companion-$LABEL.img"

echo "==> unpacking $(basename "$SRC")"
case "$SRC" in *.xz) xz -dc "$SRC" > "$IMG";; *) cp "$SRC" "$IMG";; esac

echo "==> attaching the image"
DEV=$(hdiutil attach -imagekey diskimage-class=CRawDiskImage -nomount "$IMG" | head -1 | awk '{print $1}')
[ -n "$DEV" ] || { echo "hdiutil attach failed"; exit 1; }
MNT="$WORK/bootfs"; mkdir -p "$MNT"
cleanup() { diskutil unmount "$MNT" >/dev/null 2>&1 || true; hdiutil detach "$DEV" >/dev/null 2>&1 || true; }
trap cleanup EXIT
diskutil mount -mountPoint "$MNT" "${DEV}s1" >/dev/null
[ -f "$MNT/config.txt" ] || { echo "boot partition did not mount from $DEV"; exit 1; }

echo "==> staging the kit"
"$HERE/stage_kit.sh" "$MNT" ${CONF:+"$CONF"}
diskutil unmount "$MNT" >/dev/null; hdiutil detach "$DEV" >/dev/null; trap - EXIT

echo "==> compressing (a few minutes)"
OUT="$DIST/LoopSmith-companion-$LABEL.img.xz"
xz -T0 -6 -c "$IMG" > "$OUT"; rm -f "$IMG"
(cd "$DIST" && shasum -a 256 "$(basename "$OUT")" > "$(basename "$OUT").sha256")
ls -la "$OUT" | awk '{printf "==> %s  (%.0f MB)\n", $9, $5/1e6}'
cat "$OUT.sha256"
