#!/usr/bin/env bash
# Put the LoopSmith kit onto a mounted Raspberry Pi OS boot partition (bootfs).
# Shared by build_sd.sh (a card in the Mac) and build_image.sh (an .img file).
#
#   stage_kit.sh <bootfs mount point> [looper.conf]
#
# Env: LOOPER_PASSWORD (default looper). If no conf is given and the volume already
# has a looper.conf (a card being refreshed), that one is kept.
set -euo pipefail
BOOTVOL=${1:-}; CONF=${2:-}
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"; REPO="$(cd "$HERE/../.." && pwd)"
[ -n "$BOOTVOL" ] && [ -f "$BOOTVOL/config.txt" ] || { echo "usage: stage_kit.sh <bootfs mount point> [looper.conf]  (no config.txt at '$BOOTVOL')"; exit 1; }
EXPLICIT_CONF=$CONF
[ -n "$CONF" ] || CONF="$HERE/looper.conf"

# ---- password hash (SHA-512 crypt). macOS's LibreSSL/python can't make one: OpenSSL 3 or Docker ----
PASS=${LOOPER_PASSWORD:-looper}; HASH=""
for o in /opt/homebrew/opt/openssl@3/bin/openssl /opt/homebrew/bin/openssl /usr/local/opt/openssl@3/bin/openssl /usr/local/bin/openssl openssl; do
  h=$("$o" passwd -6 "$PASS" 2>/dev/null || true); case "$h" in '$6$'*) HASH=$h; break;; esac
done
if [ -z "$HASH" ] && command -v docker >/dev/null; then
  HASH=$(docker run --rm alpine:3 sh -c "apk add -q openssl && openssl passwd -6 '$PASS'" 2>/dev/null | tail -1)
fi
case "$HASH" in '$6$'*) ;; *) echo "need an OpenSSL 3 (brew install openssl@3) or Docker to hash the password"; exit 1;; esac

# ---- the kit ----
KIT="$BOOTVOL/looper"; rm -rf "$KIT"; mkdir -p "$KIT/app/pi" "$KIT/app/editor"
cp "$REPO"/pi/looper_bridge.py "$REPO"/pi/fake_pedal.py "$REPO"/pi/record.sh "$REPO"/pi/play.sh "$KIT/app/pi/"
cp -r "$REPO"/pi/www "$KIT/app/pi/"
cp "$REPO"/editor/index.html "$KIT/app/editor/"
cp "$REPO"/pi/99-teensy-looper.rules "$REPO"/VERSION "$KIT/"
cp -r "$HERE"/splash "$KIT/"
cp -r "$REPO"/midi "$KIT/midi"
cp "$HERE"/firstrun.sh "$HERE"/looper-net.py "$HERE"/provision.sh "$HERE"/kiosk.sh "$HERE"/usb-mount.sh "$HERE"/midi-connect.sh \
   "$HERE"/80-looper-usb.rules "$HERE"/81-looper-midi.rules "$HERE"/50-looper.rules "$HERE"/NetworkManager-looper.conf "$HERE"/dnsmasq-shared-looper.conf \
   "$HERE"/looper-net.service "$HERE"/looper-provision.service "$HERE"/looper-kiosk.service "$HERE"/looper-audio.service "$HERE"/looper-backing.service "$HERE"/looper-update.sh "$HERE"/looper-update.service "$HERE"/looper-update.timer \
   "$HERE"/looper-maintenance.service "$HERE"/looper-admin.sh "$HERE"/looper-admin.service "$KIT/"
sed -e "s/__USER__/looper/" -e "s|--editor /opt/looper/editor|--editor /opt/looper/editor --www /opt/looper/pi/www --storage /media/usb|" \
    "$REPO"/pi/looper-bridge.service > "$KIT/looper-bridge.service"
# looper.conf: keep a card's customised copy unless a config was passed explicitly
if [ -n "$EXPLICIT_CONF" ] || [ ! -f "$BOOTVOL/looper.conf" ]; then cp "$CONF" "$BOOTVOL/looper.conf"; else CONF="$BOOTVOL/looper.conf"; echo "keeping the existing looper.conf"; fi
echo "$HASH" > "$KIT/userhash.txt"
# the web login shares the same password (PBKDF2, verified by the bridge)
python3 - "$PASS" > "$KIT/web-auth" <<'PY'
import hashlib, os, sys
pw = sys.argv[1]; salt = os.urandom(16); rounds = 100000
print(f"looper:pbkdf2_sha256${rounds}${salt.hex()}${hashlib.pbkdf2_hmac('sha256', pw.encode(), salt, rounds).hex()}")
PY
echo "looper:$HASH" > "$BOOTVOL/userconf.txt"      # userconf-pi renames the image's placeholder user (uid 1000) to looper
: > "$BOOTVOL/ssh"
grep -q "LoopSmith companion" "$BOOTVOL/config.txt" || cat "$HERE/config-append.txt" >> "$BOOTVOL/config.txt"

# ---- first boot: cloud-init (NoCloud seed = these files) runs the installer ----
TZ=$(grep -E '^TIMEZONE=' "$CONF" | cut -d= -f2 | tr -d ' "'); [ -n "$TZ" ] || TZ=Australia/Sydney
HN=$(grep -E '^HOSTNAME=' "$CONF" | cut -d= -f2 | tr -d ' "'); [ -n "$HN" ] || HN=looper
cat > "$BOOTVOL/user-data" <<UD
#cloud-config
# LoopSmith companion — written by pi/image/stage_kit.sh. cloud-init reads this once,
# on the first boot (see docs/PI_IMAGE.md). The rest of the install is looper/firstrun.sh.
hostname: $HN
manage_etc_hosts: true
timezone: $TZ
ssh_pwauth: true
# the user is made by Raspberry Pi OS's own userconf mechanism (userconf.txt), which keeps
# uid 1000 - cloud-init must not create one
users: []
runcmd:
  - [ /bin/bash, /boot/firmware/looper/firstrun.sh ]
power_state:
  mode: reboot
  message: LoopSmith companion installed - rebooting
  condition: true
UD
# keep the stock meta-data (instance id) and network-config (all comments) as they are
CMD="$BOOTVOL/cmdline.txt"
COUNTRY=$(grep -E '^COUNTRY=' "$CONF" | cut -d= -f2 | tr -d ' "'); [ -n "$COUNTRY" ] || COUNTRY=AU
grep -q "cfg80211.ieee80211_regdom=" "$CMD" || sed -i '' -e "1s|\$| cfg80211.ieee80211_regdom=$COUNTRY|" "$CMD"
# quiet boot: kernel chatter to tty3, the splash on tty1 (see pi/image/splash)
SPLASH=$(grep -E '^SPLASH=' "$CONF" | cut -d= -f2 | tr -d ' "'); [ -n "$SPLASH" ] || SPLASH=1
if [ "$SPLASH" = "1" ] && ! grep -q "plymouth.ignore-serial-consoles" "$CMD"; then
  sed -i '' -e 's/console=tty1/console=tty3/' \
            -e '1s|$| quiet loglevel=3 logo.nologo vt.global_cursor_default=0 splash plymouth.ignore-serial-consoles|' "$CMD"
fi
rm -f "$BOOTVOL"/._* 2>/dev/null; dot_clean "$BOOTVOL" 2>/dev/null || true
sync
echo "kit staged on $BOOTVOL  (cmdline: $(cat "$CMD"))"
echo "  hotspot: $(grep -E '^HOTSPOT_SSID=' "$CONF" | cut -d= -f2) / $(grep -E '^HOTSPOT_PASS=' "$CONF" | cut -d= -f2) -> http://10.42.0.1/   login: looper / $PASS"
