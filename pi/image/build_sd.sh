#!/usr/bin/env bash
# Build the LoopSmith companion SD card on a Mac.
#
#   pi/image/build_sd.sh <raspios-lite-armhf.img.xz> /dev/diskN [looper.conf]
#
# 1. writes the stock Raspberry Pi OS Lite image to the card (asks for your Mac password
#    through the system dialog — writing a raw disk needs it),
# 2. drops the LoopSmith kit onto the card's boot partition (FAT, so no Linux needed),
# 3. seeds cloud-init (user, hostname, the installer) via stage_kit.sh. The Pi finishes the install by itself on first boot.
#
# Want an image file instead of writing a card? pi/image/build_image.sh
set -euo pipefail
IMG=${1:-}; DISK=${2:-}; CONF=${3:-}
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
{ [ -f "$IMG" ] || [ "$IMG" = "-" ]; } && [ -n "$DISK" ] || { sed -n 2,9p "$0"; exit 1; }
[ -n "$CONF" ] || CONF="$HERE/looper.conf"

# ---- safety: an external, physical, removable-sized disk only ----
INFO=$(diskutil info "$DISK")
echo "$INFO" | grep -q "Device Location:.*External" || { echo "$DISK is not an external disk — refusing"; exit 1; }
echo "$INFO" | grep -q "Virtual:.*No" || { echo "$DISK is virtual — refusing"; exit 1; }
BYTES=$(echo "$INFO" | grep "Disk Size:" | sed -E 's/.*\(([0-9]+) Bytes\).*/\1/')
[ "$BYTES" -lt 130000000000 ] || { echo "$DISK is $((BYTES/1000000000)) GB — larger than any SD card I expect; refusing"; exit 1; }
echo "Target: $DISK ($((BYTES/1000000000)) GB)"; echo "$INFO" | grep -E "Device / Media Name|Volume Name" || true

PASS=${LOOPER_PASSWORD:-looper}

# ---- 1. write the image (pass "-" as the image to only refresh the kit on an already-written card) ----
if [ "$IMG" != "-" ]; then
  RAW=${DISK/\/dev\/disk/\/dev\/rdisk}
  diskutil unmountDisk "$DISK" >/dev/null
  XZ=$(command -v xz); [ -n "$XZ" ] || { echo "xz not found (brew install xz)"; exit 1; }
  LOG="${TMPDIR:-/tmp}/looper-sd-write.log"; : > "$LOG"
  echo "Writing $(basename "$IMG") -> $RAW (macOS will ask for your password; ~3-5 minutes)…"
  # /usr/libexec/authopen is Apple's helper for exactly this (Etcher and Raspberry Pi Imager use
  # it): it asks for an administrator's password and writes stdin to the raw device. A plain
  # root `dd` is refused by macOS's removable-volume protection.
  if ! "$XZ" -dc "$IMG" | /usr/libexec/authopen -w "$RAW" 2>"$LOG"; then
    echo "write failed:"; cat "$LOG"
    echo "Alternative: open Raspberry Pi Imager, write the image, then run:  $0 - $DISK"
    exit 1
  fi
  sync
  # the card must now carry the image's partition table (FAT boot + Linux root)
  sleep 3
  diskutil list "$DISK" | grep -q "Linux" || { echo "the card does not show the Linux root partition after writing — write did not take"; exit 1; }
  echo "Image written."
fi

# ---- 2. the boot partition ----
sleep 2; diskutil mountDisk "$DISK" >/dev/null
BOOTVOL=""
for i in $(seq 1 20); do BOOTVOL=$(mount | grep "${DISK}s1 " | sed -E 's/.* on (.*) \(.*/\1/'); [ -n "$BOOTVOL" ] && break; sleep 1; done
[ -n "$BOOTVOL" ] && [ -f "$BOOTVOL/config.txt" ] || { echo "boot partition did not mount"; exit 1; }
echo "Boot partition at $BOOTVOL"

"$HERE/stage_kit.sh" "$BOOTVOL" ${3:+"$3"}
rm -f "$BOOTVOL"/._* 2>/dev/null; dot_clean "$BOOTVOL" 2>/dev/null || true
sync; diskutil eject "$DISK" >/dev/null
echo
echo "Done. Put the card in the Pi and power it on."
echo "  first boot: resizes, creates the user, installs itself and reboots (~3 minutes)"
echo "  hotspot:    $(grep -E '^HOTSPOT_SSID=' "$CONF" | cut -d= -f2)  password $(grep -E '^HOTSPOT_PASS=' "$CONF" | cut -d= -f2)  ->  http://10.42.0.1/   (setup: /setup)"
echo "  home Wi-Fi: http://loopsmith.local/  (or the address shown on /setup);  ssh looper@loopsmith.local  password: $PASS"
