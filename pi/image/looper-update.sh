#!/bin/bash
# LoopSmith companion — in-place update of the app on the Pi.
#
#   looper-update.sh check    print JSON: current version, what is available, from where
#   looper-update.sh apply    install it with app/service rollback and restart the services
#   looper-update.sh os       apt package updates (no reboot)
#
# Update bundles are plain tarballs made by pi/image/build_release.sh. They are looked for in
# this order, so the offline route always wins and never needs credentials:
#
#   1. looper-update-*.tar.gz uploaded through the setup page (/var/lib/looper), or dropped on
#      the USB drive (/media/usb) or the SD card's boot partition
#   2. UPDATE_URL in looper.conf — any HTTPS tarball
#   3. UPDATE_REPO in looper.conf ("owner/name") — the latest commit of a GitHub repo; a private
#      one needs a token in /etc/looper/github-token (chmod 600, created by you, never by the app)
set -u
BOOT=/boot/firmware; [ -d "$BOOT" ] || BOOT=/boot
APP=/opt/looper
STATE=/var/lib/looper
LOG=$STATE/update.log
RUN=/run/looper
HELPER="$(dirname "$0")/update_transaction.py"
CONF_FILES=("$BOOT/looper.conf" /etc/looper/looper.conf)
mkdir -p "$STATE" "$RUN" 2>/dev/null

log()  { printf '%s %s\n' "$(date '+%F %T')" "$*" >> "$LOG" 2>/dev/null || true; }
result() { printf '%s\n' "$*" > "$RUN/update-result" 2>/dev/null || true; }
conf() { for f in "${CONF_FILES[@]}"; do [ -f "$f" ] || continue; v=$(grep -E "^$1=" "$f" 2>/dev/null | tail -1 | cut -d= -f2- | tr -d '"'"'" | xargs); [ -n "${v:-}" ] && { echo "$v"; return; }; done; }
cur()  { cat "$APP/VERSION" 2>/dev/null || echo 0.0.0; }
# a.b.c comparison: is $1 newer than $2?
newer() { [ "$1" != "$2" ] && [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" = "$1" ]; }

json() { # json <available> <latest> <source> <detail>
  printf '{"version":"%s","available":%s,"latest":"%s","source":"%s","detail":"%s","checked":%s,"os_reboot_required":%s}\n' \
    "$(cur)" "$1" "$2" "$3" "$(echo "${4:-}" | tr -d '"' | tr '\n' ' ')" "$(date +%s)" \
    "$([ -f /var/run/reboot-required ] && echo true || echo false)"
}

find_bundle() {   # newest local bundle, if any
  ls -1t /var/lib/looper/looper-update-*.tar.gz /media/usb/looper-update-*.tar.gz \
        "$BOOT"/looper-update-*.tar.gz /media/usb/looper/looper-update-*.tar.gz 2>/dev/null | head -1
}
bundle_version() { tar -xzOf "$1" --wildcards '*/VERSION' 2>/dev/null | head -1 | tr -d '[:space:]'; }

download() {      # download <dest>; echoes the source it used, empty when there is nothing
  local dest=$1 url repo tok
  url=$(conf UPDATE_URL)
  if [ -n "${url:-}" ]; then
    curl -fsSL --max-time 120 -o "$dest" "$url" && { echo "url"; return 0; }
    log "download failed: $url"; return 1
  fi
  repo=$(conf UPDATE_REPO)
  if [ -n "${repo:-}" ]; then
    local branch hdr=()
    branch=$(conf UPDATE_BRANCH); branch=${branch:-master}
    tok=$(cat /etc/looper/github-token 2>/dev/null | tr -d '[:space:]')
    [ -n "${tok:-}" ] && hdr=(-H "Authorization: Bearer $tok")
    curl -fsSL --max-time 180 "${hdr[@]}" -o "$dest" \
      "https://api.github.com/repos/$repo/tarball/$branch" && { echo "github"; return 0; }
    log "github download failed: $repo@$branch"; return 1
  fi
  return 1
}

# A GitHub tarball is the whole repository, not a bundle: build one from it in place.
repack_repo() {   # repack_repo <repo tarball> <out bundle>
  local src=$1 out=$2 tmp; tmp=$(mktemp -d)
  python3 "$HELPER" unpack "$src" "$tmp" || { rm -rf "$tmp"; return 1; }
  local root; root=$(find "$tmp" -mindepth 1 -maxdepth 1 -type d | head -1)
  [ -n "$root" ] && [ -f "$root/VERSION" ] || { rm -rf "$tmp"; return 1; }
  local stage=$tmp/looper-update
  mkdir -p "$stage/app/pi" "$stage/app/editor" "$stage/units" "$stage/udev"
  cp "$root/VERSION" "$stage/VERSION"
  cp "$root"/pi/looper_bridge.py "$root"/pi/fake_pedal.py "$root"/pi/record.sh "$root"/pi/play.sh "$stage/app/pi/" 2>/dev/null
  cp -r "$root"/pi/www "$stage/app/pi/" 2>/dev/null
  cp -r "$root"/pi/image/splash "$stage/app/" 2>/dev/null
  cp -r "$root"/midi "$stage/app/midi" 2>/dev/null
  cp "$root"/editor/index.html "$stage/app/editor/" 2>/dev/null
  for f in looper-net.py provision.sh kiosk.sh usb-mount.sh midi-connect.sh looper-update.sh looper-admin.sh update_transaction.py; do
    [ -f "$root/pi/image/$f" ] && cp "$root/pi/image/$f" "$stage/app/pi/"
  done
  for f in "$root"/pi/image/*.service "$root"/pi/image/*.timer; do [ -f "$f" ] && cp "$f" "$stage/units/"; done
  sed -e "s/__USER__/looper/" -e "s|--editor /opt/looper/editor|--editor /opt/looper/editor --www /opt/looper/pi/www --storage /media/usb|" \
      "$root/pi/looper-bridge.service" > "$stage/units/looper-bridge.service" 2>/dev/null
  for f in "$root"/pi/image/*.rules "$root"/pi/99-teensy-looper.rules; do [ -f "$f" ] && cp "$f" "$stage/udev/"; done
  tar -czf "$out" -C "$tmp" looper-update && { rm -rf "$tmp"; return 0; }
  rm -rf "$tmp"; return 1
}

do_check() {
  local b v
  b=$(find_bundle)
  if [ -n "${b:-}" ]; then
    v=$(bundle_version "$b")
    if [ -n "$v" ] && newer "$v" "$(cur)"; then json true "$v" "bundle" "$(basename "$b")"; return; fi
  fi
  local tmp src; tmp=$(mktemp /tmp/looper-check.XXXXXX.tar.gz)
  if [ -z "$(conf UPDATE_URL)$(conf UPDATE_REPO)" ]; then
    json false "$(cur)" "${b:+bundle}" "no update source configured; upload a bundle or configure UPDATE_URL / UPDATE_REPO"; return
  fi
  src=$(download "$tmp" 2>/dev/null) || { json false "$(cur)" "remote" "configured update source could not be reached; check network and access"; rm -f "$tmp"; return; }
  local out; out=$(mktemp /tmp/looper-remote.XXXXXX.tar.gz)
  if [ "$src" = "github" ]; then repack_repo "$tmp" "$out" || { json false "$(cur)" "$src" "downloaded tarball was not usable"; rm -f "$tmp"; return; }
  else cp "$tmp" "$out"; fi
  v=$(bundle_version "$out"); rm -f "$tmp"
  if [ -n "$v" ] && newer "$v" "$(cur)"; then json true "$v" "$src" "ready to install"; else json false "${v:-$(cur)}" "$src" "already up to date"; fi
  rm -f "$out"
}

do_apply() {
  local b tmp src v; tmp=$(mktemp /tmp/looper-update.XXXXXX.tar.gz)
  b=$(find_bundle)
  if [ -n "${b:-}" ] && [ -n "$(bundle_version "$b")" ] && newer "$(bundle_version "$b")" "$(cur)"; then
    cp "$b" "$tmp"; src="bundle $(basename "$b")"
  else
    local dl s; dl=$(mktemp /tmp/looper-download.XXXXXX.tar.gz)
    s=$(download "$dl") || { echo "no update available"; result "no update available"; log "apply: nothing to install"; return 1; }
    if [ "$s" = "github" ]; then repack_repo "$dl" "$tmp" || { echo "bad tarball"; return 1; }; else cp "$dl" "$tmp"; fi
    rm -f "$dl"; src="$s"
  fi
  v=$(bundle_version "$tmp")
  [ -n "$v" ] || { echo "bundle has no VERSION"; return 1; }
  newer "$v" "$(cur)" || { echo "already at $(cur)"; result "already at $(cur)"; return 0; }

  local work; work=$(mktemp -d)
  python3 "$HELPER" unpack "$tmp" "$work" || { result "unsafe or invalid bundle"; rm -rf "$work" "$tmp"; return 1; }
  local stage=$work/looper-update
  if ! python3 "$HELPER" apply "$stage" >> "$LOG" 2>&1; then
    result "update failed; see update progress and log for rollback status"
    rm -rf "$work" "$tmp"; return 1
  fi
  # Only trusted installed code runs as the post-update step. Bundle-supplied
  # arbitrary hooks are not executed. OS packages/boot firmware are separate.
  systemctl restart looper-audio looper-backing looper-kiosk 2>/dev/null || true
  local theme=/usr/share/plymouth/themes/looper
  if [ -d "$theme" ] && [ -d "$APP/splash" ] && ! diff -rq "$APP/splash" "$theme" >/dev/null 2>&1; then
    if ! { install -m 644 "$APP"/splash/* "$theme"/ && plymouth-set-default-theme -R looper; } >> "$LOG" 2>&1; then
      log "app updated; boot splash rebuild failed (retry separately)"
    fi
  fi
  [ -n "${b:-}" ] && [ -f "$b" ] && mv "$b" "$b.installed" 2>/dev/null    # don't install the same bundle twice
  log "updated to $v"
  result "updated to $v"
  echo "updated to $v"
  rm -rf "$work" "$tmp"
}

case "${1:-check}" in
  check) do_check ;;
  apply) do_apply ;;
  rollback) python3 "$HELPER" rollback ;;
  os)    DEBIAN_FRONTEND=noninteractive apt-get update -qq >> "$LOG" 2>&1 &&
         DEBIAN_FRONTEND=noninteractive apt-get -y -qq -o Dpkg::Options::=--force-confold upgrade >> "$LOG" 2>&1 &&
         log "os packages upgraded" && echo "os packages upgraded" ;;
  *)     sed -n 2,12p "$0"; exit 1 ;;
esac
