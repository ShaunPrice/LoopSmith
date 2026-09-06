#!/usr/bin/env bash
# Build an update bundle for the companion Pi from this working tree.
#
#   pi/image/build_release.sh [version]        -> dist/looper-update-<version>.tar.gz
#
# Install it any of three ways:
#   * copy it onto the Pi's USB drive (or the SD card's boot partition) — the Pi finds it,
#     no network and no credentials needed;
#   * serve it over HTTPS and put that address in UPDATE_URL in looper.conf;
#   * or set UPDATE_REPO=owner/name and let the Pi pull the repository itself.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
VER=${1:-$(cat "$REPO/VERSION")}
echo "$VER" > "$REPO/VERSION"
OUT="$REPO/dist"; mkdir -p "$OUT"
WORK=$(mktemp -d); S="$WORK/looper-update"
mkdir -p "$S/app/pi" "$S/app/editor" "$S/units" "$S/udev"
echo "$VER" > "$S/VERSION"
cp "$REPO"/pi/looper_bridge.py "$REPO"/pi/fake_pedal.py "$REPO"/pi/record.sh "$REPO"/pi/play.sh "$S/app/pi/"
cp -r "$REPO"/pi/www "$S/app/pi/"
cp -r "$HERE"/splash "$S/app/"
cp -r "$REPO"/midi "$S/app/midi"
cp "$REPO"/editor/index.html "$S/app/editor/"
for f in looper-net.py provision.sh kiosk.sh usb-mount.sh midi-connect.sh looper-update.sh looper-admin.sh update_transaction.py; do cp "$HERE/$f" "$S/app/pi/"; done
cp "$HERE"/*.service "$HERE"/*.timer "$S/units/" 2>/dev/null || true
sed -e "s/__USER__/looper/" -e "s|--editor /opt/looper/editor|--editor /opt/looper/editor --www /opt/looper/pi/www --storage /media/usb|" \
    "$REPO/pi/looper-bridge.service" > "$S/units/looper-bridge.service"
cp "$HERE"/*.rules "$REPO"/pi/99-teensy-looper.rules "$S/udev/"
cat > "$S/postinstall.sh" <<'PI'
#!/bin/sh
# runs as root inside the update, after the files are in place
systemctl enable looper-update.timer >/dev/null 2>&1
BOOT=/boot/firmware; [ -d "$BOOT" ] || BOOT=/boot
SPLASH=1
[ -f "$BOOT/looper.conf" ] && v=$(grep -E '^SPLASH=' "$BOOT/looper.conf" | tail -1 | cut -d= -f2 | tr -d ' "') && [ -n "$v" ] && SPLASH=$v
if [ "$SPLASH" = "1" ]; then
  # quiet boot: kernel messages to tty3, splash on tty1
  if ! grep -q "plymouth.ignore-serial-consoles" "$BOOT/cmdline.txt"; then
    sed -i -e 's/console=tty1/console=tty3/' \
           -e 's/$/ quiet loglevel=3 logo.nologo vt.global_cursor_default=0 splash plymouth.ignore-serial-consoles/' \
           "$BOOT/cmdline.txt"
  fi
  # plymouth may not be installed yet (it arrives with the kiosk browser): fetch it now
  if ! command -v plymouth-set-default-theme >/dev/null 2>&1; then
    DEBIAN_FRONTEND=noninteractive apt-get install -y -qq plymouth plymouth-themes >/dev/null 2>&1
  fi
  # example MIDI files: copied into the library the first time, never overwriting yours
  for d in /media/usb/midi /home/looper/looper/midi; do
    [ -d "$(dirname "$d")" ] || continue
    mkdir -p "$d" 2>/dev/null
    for f in /opt/looper/midi/*.mid; do
      [ -f "$f" ] || continue
      [ -e "$d/$(basename "$f")" ] || cp "$f" "$d/" 2>/dev/null
    done
    chown -R looper:looper "$d" 2>/dev/null
    break
  done
  if [ -d /opt/looper/splash ]; then
    install -d /usr/share/plymouth/themes/looper
    install -m 644 /opt/looper/splash/* /usr/share/plymouth/themes/looper/
    command -v plymouth-set-default-theme >/dev/null 2>&1 && plymouth-set-default-theme -R looper >/dev/null 2>&1
  fi
fi
exit 0
PI
chmod +x "$S/postinstall.sh"
TAR="$OUT/looper-update-$VER.tar.gz"
tar -czf "$TAR" -C "$WORK" looper-update
rm -rf "$WORK"
(cd "$OUT" && shasum -a 256 "$(basename "$TAR")" > "$(basename "$TAR").sha256")
ls -la "$TAR" | awk '{printf "%s  (%.1f MB)\n", $9, $5/1048576}'
cat "$TAR.sha256"
