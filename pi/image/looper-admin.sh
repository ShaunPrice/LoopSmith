#!/bin/bash
# LoopSmith companion — privileged setup actions, run as root by systemd.
#
# The bridge never gains privileges of its own: it writes a request to
# /run/looper/admin-request.json and starts looper-admin.service (polkit lets it start
# that one unit). This script does the work and writes /run/looper/admin-result.json.
#
# Actions: claim-account · reset-login · set-password · set-username · set-hotspot
#          · hotspot-enable · ssh-enable · console · stage-bundle
#          · bt-scan · bt-pair · bt-connect · bt-disconnect · bt-remove · bt-power
set -u
RUN=/run/looper
REQ=$RUN/admin-request.json
RES=$RUN/admin-result.json
BOOT=/boot/firmware; [ -d "$BOOT" ] || BOOT=/boot
LOG=/var/lib/looper/admin.log
mkdir -p "$RUN" /var/lib/looper 2>/dev/null

log() { printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG" 2>/dev/null || true; }
# result <ok> <message> [json data]
result() {
  python3 - "$1" "$2" "${3:-null}" <<'PY' > "$RES" 2>/dev/null
import json, sys
ok, msg, data = sys.argv[1] == "1", sys.argv[2], sys.argv[3]
try: data = json.loads(data)
except ValueError: data = None
print(json.dumps({"ok": ok, "message": msg, "data": data}))
PY
  chmod 644 "$RES" 2>/dev/null
  log "$2"
}
field() { python3 -c "import json,sys;print(json.load(open('$REQ')).get('$1','') or '')" 2>/dev/null; }

[ -f "$REQ" ] || { result 0 "no request"; exit 1; }
ACTION=$(field action)
trap 'rm -f "$REQ"' EXIT          # the request may hold a password: never leave it behind
USER_NAME=$(getent passwd 1000 | cut -d: -f1)      # whoever the app user currently is
USER_NAME=${USER_NAME:-looper}

case "$ACTION" in

  # ---------------------------------------------------------------- first run
  claim-account)
    NEW=$(field username); PW=$(python3 -c "import json;print(json.load(open('$REQ')).get('password',''))" 2>/dev/null)
    [ -f /etc/looper/web-auth ] && { result 0 "this pedal has already been set up"; exit 1; }
    case "$NEW" in
      ''|*[!a-z0-9-]*|[!a-z]*) result 0 "a user name must start with a letter and use only lower-case letters, digits and hyphens"; exit 1;;
    esac
    [ ${#PW} -ge 8 ] || { result 0 "the password must be at least 8 characters"; exit 1; }
    # rename the stock account if the chosen name differs, then set the one password everywhere
    if [ "$NEW" != "$USER_NAME" ]; then
      if id "$NEW" >/dev/null 2>&1; then result 0 "$NEW already exists"; exit 1; fi
      usermod -l "$NEW" -d "/home/$NEW" -m "$USER_NAME" 2>>"$LOG" && groupmod -n "$NEW" "$USER_NAME" 2>/dev/null
      sed -i "s/^$USER_NAME /$NEW /" /etc/sudoers.d/010_looper-nopasswd 2>/dev/null
      sed -i "s/\"$USER_NAME\"/\"$NEW\"/g" /etc/polkit-1/rules.d/50-looper.rules 2>/dev/null
      sed -i -e "s/^User=$USER_NAME/User=$NEW/" -e "s#/home/$USER_NAME#/home/$NEW#g" /etc/systemd/system/looper-*.service 2>/dev/null
      chown -R "$NEW":"$NEW" /opt/looper "/home/$NEW" 2>/dev/null
      systemctl daemon-reload
      USER_NAME=$NEW
    fi
    printf '%s:%s' "$USER_NAME" "$PW" | chpasswd || { result 0 "could not set the password"; exit 1; }
    mkdir -p /etc/looper
    python3 - "$USER_NAME" "$PW" <<'PY' > /etc/looper/web-auth
import hashlib, os, sys
user, pw = sys.argv[1], sys.argv[2]
salt = os.urandom(16); rounds = 100000
print(f"{user}:pbkdf2_sha256${rounds}${salt.hex()}${hashlib.pbkdf2_hmac('sha256', pw.encode(), salt, rounds).hex()}")
PY
    chown "$USER_NAME":"$USER_NAME" /etc/looper/web-auth 2>/dev/null; chmod 600 /etc/looper/web-auth
    rm -f "$BOOT/setup-code.txt" "$RUN/setup-code"          # the code is spent
    systemctl enable --now ssh >/dev/null 2>&1               # SSH only exists once there is a password
    systemctl restart looper-kiosk >/dev/null 2>&1
    log "claimed by $USER_NAME"
    result 1 "welcome — signed in as $USER_NAME"
    ;;

  reset-login)
    # only reachable from the pedal's own screen (the bridge enforces that): forget the
    # credential so the claim page appears again
    rm -f /etc/looper/web-auth
    systemctl restart looper-bridge >/dev/null 2>&1 &
    result 1 "login cleared — the screen will ask you to set a new one"
    ;;

  # ---------------------------------------------------------------- login
  set-password)
    PW=$(python3 -c "import json;print(json.load(open('$REQ')).get('password',''))" 2>/dev/null)
    if [ ${#PW} -lt 6 ]; then result 0 "the password must be at least 6 characters"; exit 1; fi
    if printf '%s:%s' "$USER_NAME" "$PW" | chpasswd; then
      # the web login shares the appliance password
      mkdir -p /etc/looper
      python3 - "$USER_NAME" "$PW" <<'PY' > /etc/looper/web-auth
import hashlib, os, sys
user, pw = sys.argv[1], sys.argv[2]
salt = os.urandom(16); rounds = 100000
print(f"{user}:pbkdf2_sha256${rounds}${salt.hex()}${hashlib.pbkdf2_hmac('sha256', pw.encode(), salt, rounds).hex()}")
PY
      # owned by the app user: the bridge runs with a different primary group, so ownership
      # (not group) is what makes it readable to it, and to nobody else
      chown "$USER_NAME":"$USER_NAME" /etc/looper/web-auth 2>/dev/null; chmod 600 /etc/looper/web-auth
      result 1 "password changed for $USER_NAME (console, SSH and the web login)"
    else
      result 0 "changing the password failed"
    fi
    ;;

  ssh-enable)
    ON=$(field on)
    if [ "${ON:-1}" = "0" ]; then
      systemctl disable --now ssh >/dev/null 2>&1 && result 1 "SSH off" || result 0 "could not stop SSH"
    else
      systemctl enable --now ssh >/dev/null 2>&1 && result 1 "SSH on" || result 0 "could not start SSH"
    fi
    ;;

  set-username)
    NEW=$(field username)
    case "$NEW" in
      ''|*[!a-z0-9-]*|[!a-z]*) result 0 "a user name must start with a letter and use only lower-case letters, digits and hyphens"; exit 1;;
    esac
    [ "$NEW" = "$USER_NAME" ] && { result 1 "already $NEW"; exit 0; }
    id "$NEW" >/dev/null 2>&1 && { result 0 "$NEW already exists"; exit 1; }
    # do the rename after everything using the account has stopped, then reboot
    log "renaming $USER_NAME -> $NEW"
    cat > /usr/local/sbin/looper-finish-rename <<RENAME
#!/bin/bash
set -u
OLD=$USER_NAME
NEW=$NEW
systemctl stop looper-kiosk looper-bridge looper-audio looper-backing 2>/dev/null
pkill -u "\$OLD" 2>/dev/null; sleep 1; pkill -9 -u "\$OLD" 2>/dev/null
usermod -l "\$NEW" -d "/home/\$NEW" -m "\$OLD" && groupmod -n "\$NEW" "\$OLD" 2>/dev/null
sed -i "s/^\$OLD /\$NEW /" /etc/sudoers.d/010_looper-nopasswd 2>/dev/null
mv /etc/sudoers.d/010_looper-nopasswd /etc/sudoers.d/010_\${NEW}-nopasswd 2>/dev/null
sed -i "s/\\"\$OLD\\"/\\"\$NEW\\"/g" /etc/polkit-1/rules.d/50-looper.rules 2>/dev/null
sed -i "s/^User=\$OLD/User=\$NEW/" /etc/systemd/system/looper-*.service 2>/dev/null
sed -i "s#/home/\$OLD#/home/\$NEW#g" /etc/systemd/system/looper-*.service 2>/dev/null
chown -R "\$NEW":"\$NEW" /opt/looper "/home/\$NEW" 2>/dev/null
systemctl daemon-reload
rm -f /usr/local/sbin/looper-finish-rename
systemctl reboot
RENAME
    chmod +x /usr/local/sbin/looper-finish-rename
    result 1 "renaming to $NEW and restarting — log in as $NEW after the reboot"
    setsid /usr/local/sbin/looper-finish-rename >> "$LOG" 2>&1 &
    ;;

  # ---------------------------------------------------------------- hotspot
  set-hotspot)
    SSID=$(field ssid); PASS=$(python3 -c "import json;print(json.load(open('$REQ')).get('password',''))" 2>/dev/null)
    [ -n "$SSID" ] && [ ${#SSID} -le 32 ] || { result 0 "the network name must be 1-32 characters"; exit 1; }
    [ ${#PASS} -ge 8 ] && [ ${#PASS} -le 63 ] || { result 0 "the Wi-Fi password must be 8-63 characters"; exit 1; }
    for f in "$BOOT/looper.conf" /etc/looper/looper.conf; do
      [ -f "$f" ] || continue
      sed -i -e "s/^HOTSPOT_SSID=.*/HOTSPOT_SSID=$SSID/" -e "s/^HOTSPOT_PASS=.*/HOTSPOT_PASS=$PASS/" "$f"
    done
    if nmcli connection modify looper-hotspot 802-11-wireless.ssid "$SSID" wifi-sec.psk "$PASS" 2>>"$LOG"; then
      result 1 "hotspot is now \"$SSID\" — rejoin it on your phone"
      ( sleep 1; nmcli connection down looper-hotspot >/dev/null 2>&1; nmcli connection up looper-hotspot >/dev/null 2>&1 ) &
    else
      result 0 "could not change the hotspot (is it running?)"
    fi
    ;;

  console)
    # The kiosk owns tty1. Switching virtual terminals shows a login prompt on the screen
    # and back again, with nothing restarted and the pedal untouched.
    ON=$(field on)
    if [ "${ON:-1}" = "0" ]; then
      chvt 1 2>>"$LOG" && result 1 "back to Studio on the screen" || result 0 "could not switch back"
    else
      systemctl start getty@tty2 >/dev/null 2>&1
      sleep 0.3
      if chvt 2 2>>"$LOG"; then
        result 1 "console on the screen — log in as $USER_NAME (Ctrl+Alt+F1 also returns to Studio)"
      else
        result 0 "could not switch the screen"
      fi
    fi
    ;;

  stage-bundle)
    UP=$RUN/upload.tar.gz
    [ -s "$UP" ] || { result 0 "no upload found"; exit 1; }
    V=$(tar -xzOf "$UP" --wildcards '*/VERSION' 2>/dev/null | head -1 | tr -d '[:space:]')
    case "$V" in
      ''|*[!0-9.]*) rm -f "$UP"; result 0 "that file is not a LoopSmith update bundle"; exit 1;;
    esac
    tar -tzf "$UP" 2>/dev/null | grep -q 'looper-update/app/pi/looper_bridge.py' || {
      rm -f "$UP"; result 0 "the bundle has no app in it"; exit 1; }
    mkdir -p /var/lib/looper
    rm -f /var/lib/looper/looper-update-*.tar.gz
    mv "$UP" "/var/lib/looper/looper-update-$V.tar.gz"
    chmod 644 "/var/lib/looper/looper-update-$V.tar.gz"
    result 1 "bundle $V ready — press Install"
    ;;

  hotspot-enable)
    ON=$(field on)   # "1" / "0"
    for f in "$BOOT/looper.conf" /etc/looper/looper.conf; do
      [ -f "$f" ] || continue
      if grep -q "^HOTSPOT_ENABLED=" "$f"; then sed -i "s/^HOTSPOT_ENABLED=.*/HOTSPOT_ENABLED=${ON:-1}/" "$f"
      else printf 'HOTSPOT_ENABLED=%s\n' "${ON:-1}" >> "$f"; fi
    done
    if [ "${ON:-1}" = "0" ]; then
      nmcli connection modify looper-hotspot connection.autoconnect no 2>>"$LOG"
      nmcli connection down looper-hotspot >/dev/null 2>&1
      result 1 "hotspot off — the pedal is reachable on the home network only"
    else
      nmcli connection modify looper-hotspot connection.autoconnect yes 2>>"$LOG"
      nmcli connection up looper-hotspot >/dev/null 2>&1
      result 1 "hotspot on"
    fi
    ;;

  # ---------------------------------------------------------------- bluetooth
  bt-power)
    ON=$(field on)
    bluetoothctl power "${ON:-on}" >/dev/null 2>&1
    result 1 "bluetooth ${ON:-on}"
    ;;

  bt-scan)
    bluetoothctl power on >/dev/null 2>&1
    bluetoothctl --timeout 12 scan on >/dev/null 2>&1
    python3 - <<'PY' > "$RES"
import json, subprocess, re
def run(*a):
    try: return subprocess.run(a, capture_output=True, text=True, timeout=15).stdout
    except Exception: return ""
paired = {m.group(1) for m in re.finditer(r"^Device ([0-9A-F:]{17})", run("bluetoothctl", "devices", "Paired"), re.M)}
conn    = {m.group(1) for m in re.finditer(r"^Device ([0-9A-F:]{17})", run("bluetoothctl", "devices", "Connected"), re.M)}
out = []
for line in run("bluetoothctl", "devices").splitlines():
    m = re.match(r"^Device ([0-9A-F:]{17}) (.+)$", line.strip())
    if not m: continue
    mac, name = m.group(1), m.group(2)
    info = run("bluetoothctl", "info", mac)
    icon = re.search(r"Icon: (\S+)", info)
    out.append({"mac": mac, "name": name, "icon": icon.group(1) if icon else "",
                "paired": mac in paired, "connected": mac in conn})
out.sort(key=lambda d: (not d["connected"], not d["paired"], d["name"].lower()))
print(json.dumps({"ok": True, "message": f"{len(out)} devices", "data": {"devices": out}}))
PY
    chmod 644 "$RES" 2>/dev/null
    ;;

  bt-pair|bt-connect|bt-disconnect|bt-remove)
    MAC=$(field mac)
    case "$MAC" in ??:??:??:??:??:??) ;; *) result 0 "bad device address"; exit 1;; esac
    bluetoothctl power on >/dev/null 2>&1
    case "$ACTION" in
      bt-pair)
        OUT=$( { bluetoothctl --timeout 25 pair "$MAC"; bluetoothctl trust "$MAC"; bluetoothctl --timeout 15 connect "$MAC"; } 2>&1 | tail -6 )
        if bluetoothctl info "$MAC" | grep -q "Connected: yes"; then result 1 "paired and connected"
        elif bluetoothctl info "$MAC" | grep -q "Paired: yes"; then result 1 "paired (not connected yet — try Connect)"
        else result 0 "$(echo "$OUT" | grep -iE 'passkey|pin|fail|error' | tail -1 | cut -c1-160)"; fi
        ;;
      bt-connect)
        OUT=$(bluetoothctl --timeout 20 connect "$MAC" 2>&1 | tail -3)
        bluetoothctl info "$MAC" | grep -q "Connected: yes" && result 1 "connected" || result 0 "$(echo "$OUT" | tail -1 | cut -c1-160)"
        ;;
      bt-disconnect) bluetoothctl disconnect "$MAC" >/dev/null 2>&1; result 1 "disconnected" ;;
      bt-remove)     bluetoothctl remove "$MAC" >/dev/null 2>&1; result 1 "removed" ;;
    esac
    ;;

  *) result 0 "unknown action: $ACTION" ;;
esac
exit 0
