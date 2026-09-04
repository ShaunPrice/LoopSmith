#!/bin/bash
# LoopSmith companion — first-boot setup, run once by cloud-init (runcmd in the
# boot partition's user-data; cloud-init then reboots). Idempotent and offline: it also
# works when run by hand later (sudo bash /boot/firmware/looper/firstrun.sh).
# The kiosk browser is fetched later by looper-provision once the Pi sees the internet.
set -u
BOOT=/boot/firmware; [ -d "$BOOT" ] || BOOT=/boot
KIT="$BOOT/looper"
exec > >(tee -a "$KIT/firstrun.log") 2>&1
echo "== LoopSmith firstrun $(date) =="

# ---- config (only known keys, no eval) ----
HOSTNAME=looper; COUNTRY=AU; TIMEZONE=Australia/Sydney; KIOSK=1; X300=1; X300_AUDIO=1; X300_INPUT=0
getconf() { grep -E "^$1=" "$BOOT/looper.conf" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'" | xargs; }
for k in HOSTNAME COUNTRY TIMEZONE KIOSK X300 X300_AUDIO X300_INPUT; do v=$(getconf $k); [ -n "$v" ] && eval "$k=\"\$v\""; done

# ---- hostname ----
CUR=$(cat /etc/hostname 2>/dev/null || echo raspberrypi)
echo "$HOSTNAME" > /etc/hostname
if grep -q "^127.0.1.1" /etc/hosts; then sed -i "s/^127.0.1.1.*/127.0.1.1\t$HOSTNAME/" /etc/hosts; else printf '127.0.1.1\t%s\n' "$HOSTNAME" >> /etc/hosts; fi
hostname "$HOSTNAME" 2>/dev/null || true
echo "hostname: $CUR -> $HOSTNAME"

# ---- the login is NOT set here ----
# Nothing ships with a password. The pedal generates a one-time setup code, shows it on the
# screen and writes it to the boot partition; the first person to open the web app chooses the
# user name and password (see /claim in pi/looper_bridge.py).
CODE=$(tr -dc 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' < /dev/urandom | head -c 6)
mkdir -p /run/looper && printf '%s' "$CODE" > /run/looper/setup-code && chmod 644 /run/looper/setup-code
printf 'LoopSmith setup code: %s\n\nOpen http://loopsmith.local/ (or join the Wi-Fi named in looper.conf)\nand enter this code to choose your login.\n' "$CODE" > "$BOOT/setup-code.txt"
rm -f "$BOOT/userconf.txt"
echo "setup code: $CODE"

# the account itself: no password, locked until it is claimed
if ! id looper >/dev/null 2>&1; then
  if id 1000 >/dev/null 2>&1; then usermod -l looper -d /home/looper -m "$(getent passwd 1000 | cut -d: -f1)" 2>/dev/null || useradd -m -s /bin/bash -U looper
  else useradd -m -u 1000 -s /bin/bash -U looper; fi
fi
passwd -l looper >/dev/null 2>&1
for g in sudo dialout audio video render input netdev plugdev gpio i2c spi users bluetooth; do getent group "$g" >/dev/null && usermod -aG "$g" looper; done
echo "looper ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/010_looper-nopasswd && chmod 440 /etc/sudoers.d/010_looper-nopasswd

# ---- ssh, wifi country, timezone ----
systemctl disable ssh >/dev/null 2>&1 || true; rm -f "$BOOT/ssh" "$BOOT/ssh.txt"   # enabled when the pedal is claimed
raspi-config nonint do_wifi_country "$COUNTRY" >/dev/null 2>&1 || true
# belt and braces: the regulatory domain in every place Raspberry Pi OS looks, and no
# persisted soft-block — a radio with no country set never comes up
WPA=/etc/wpa_supplicant/wpa_supplicant.conf; mkdir -p /etc/wpa_supplicant
if [ -f "$WPA" ]; then grep -q "^country=" "$WPA" && sed -i "s/^country=.*/country=$COUNTRY/" "$WPA" || printf 'country=%s\n' "$COUNTRY" >> "$WPA"
else printf 'ctrl_interface=DIR=/var/run/wpa_supplicant GROUP=netdev\nupdate_config=1\ncountry=%s\n' "$COUNTRY" > "$WPA"; fi
grep -q "cfg80211.ieee80211_regdom=" "$BOOT/cmdline.txt" || sed -i "1s|\$| cfg80211.ieee80211_regdom=$COUNTRY|" "$BOOT/cmdline.txt"
iw reg set "$COUNTRY" 2>/dev/null || true
rfkill unblock all 2>/dev/null || true
rm -f /var/lib/systemd/rfkill/* 2>/dev/null || true
if [ -f "/usr/share/zoneinfo/$TIMEZONE" ]; then ln -sf "/usr/share/zoneinfo/$TIMEZONE" /etc/localtime; echo "$TIMEZONE" > /etc/timezone; fi

# ---- the app: /opt/looper ----
rm -rf /opt/looper; mkdir -p /opt/looper
cp -r "$KIT/app/." /opt/looper/
cp "$KIT"/looper-net.py "$KIT"/provision.sh "$KIT"/kiosk.sh "$KIT"/usb-mount.sh /opt/looper/pi/
[ -f "$KIT/midi-connect.sh" ] && cp "$KIT/midi-connect.sh" /opt/looper/pi/
[ -f "$KIT/looper-update.sh" ] && cp "$KIT/looper-update.sh" /opt/looper/pi/
[ -f "$KIT/looper-admin.sh" ] && cp "$KIT/looper-admin.sh" /opt/looper/pi/
cp "$KIT/VERSION" /opt/looper/VERSION 2>/dev/null || echo "0.0.0" > /opt/looper/VERSION
[ -d "$KIT/splash" ] && cp -r "$KIT/splash" /opt/looper/
if [ -d "$KIT/midi" ]; then                       # example MIDI files, ready to play
  cp -r "$KIT/midi" /opt/looper/
  mkdir -p /home/looper/looper/midi && cp "$KIT"/midi/*.mid /home/looper/looper/midi/ 2>/dev/null
  chown -R looper:looper /home/looper/looper 2>/dev/null
fi
chmod +x /opt/looper/pi/*.py /opt/looper/pi/*.sh
chown -R looper:looper /opt/looper
mkdir -p /etc/looper && { cp "$BOOT/looper.conf" /etc/looper/looper.conf 2>/dev/null || cp "$KIT/looper.conf" /etc/looper/looper.conf 2>/dev/null || true; }
mkdir -p /media/usb /home/looper/loops && chown looper:looper /home/looper/loops

# ---- udev (pedal + USB drive), polkit, NetworkManager ----
cp "$KIT/99-teensy-looper.rules" "$KIT/80-looper-usb.rules" /etc/udev/rules.d/
[ -f "$KIT/81-looper-midi.rules" ] && cp "$KIT/81-looper-midi.rules" /etc/udev/rules.d/
mkdir -p /etc/polkit-1/rules.d && cp "$KIT/50-looper.rules" /etc/polkit-1/rules.d/
mkdir -p /etc/NetworkManager/conf.d /etc/NetworkManager/dnsmasq-shared.d
cp "$KIT/NetworkManager-looper.conf" /etc/NetworkManager/conf.d/looper.conf
cp "$KIT/dnsmasq-shared-looper.conf" /etc/NetworkManager/dnsmasq-shared.d/looper.conf

# ---- services ----
cp "$KIT"/looper-bridge.service "$KIT"/looper-net.service "$KIT"/looper-provision.service "$KIT"/looper-kiosk.service /etc/systemd/system/
for u in looper-update.service looper-maintenance.service looper-update.timer looper-admin.service; do [ -f "$KIT/$u" ] && cp "$KIT/$u" /etc/systemd/system/; done
systemctl daemon-reload
systemctl enable looper-net.service looper-bridge.service looper-provision.service >/dev/null 2>&1
AUTOUP=$(getconf UPDATE_AUTO); [ "${AUTOUP:-1}" = "1" ] && systemctl enable looper-update.timer >/dev/null 2>&1
MODEL=$( { tr -d '\0' < /proc/device-tree/model; } 2>/dev/null || echo unknown)
echo "model: $MODEL"
if [ "$X300" = "1" ] && echo "$MODEL" | grep -q "Raspberry Pi 3"; then
  # X300 = USB sound card (CM119A) + DS3231 RTC, a Pi 3B board: make its codec the default ALSA device
  printf 'pcm.!default plughw:Device\nctl.!default plughw:Device\n' > /etc/asound.conf
  apt-get -y remove fake-hwclock >/dev/null 2>&1 || true     # the real clock takes over
  if [ "$X300_AUDIO" = "1" ] && [ -f "$KIT/looper-audio.service" ]; then
    cp "$KIT/looper-audio.service" /etc/systemd/system/ && systemctl enable looper-audio.service >/dev/null 2>&1 && echo "X300 audio out enabled"
  fi
  [ -f "$KIT/looper-backing.service" ] && cp "$KIT/looper-backing.service" /etc/systemd/system/
  if [ "$X300_INPUT" = "1" ]; then systemctl enable looper-backing.service >/dev/null 2>&1 && echo "X300 backing input enabled"; fi
fi
if [ "$KIOSK" = "1" ]; then systemctl disable getty@tty1.service >/dev/null 2>&1 || true; fi
systemctl enable avahi-daemon >/dev/null 2>&1 || true

# ---- done (cloud-init reboots after this) ----
sed -i 's| systemd\.run[^ ]*||g' "$BOOT/cmdline.txt" 2>/dev/null || true
date > "$KIT/firstrun.done"
echo "== firstrun complete =="
exit 0
