#!/usr/bin/env bash
# One-off transition step, run ONLY by the updater that shipped before 2.7.0.
#
# That updater copied every *.rules file in a bundle into /etc/udev/rules.d, but
# 50-looper.rules is a polkit rule, and from 2.7.0 it also has to allow
# looper-rollback.service - the "Restore previous app" button. Without this the
# first 2.7.0 install would leave the rule in the wrong directory and rollback
# refused by polkit until the next update. The 2.7.0 updater installs the rule
# in the right place itself and never runs bundle hooks, so this cannot run
# again once 2.7.0 is in.
set -u
APP=/opt/looper
RULE=$APP/pi/50-looper.rules
[ -f "$RULE" ] || RULE=$(dirname "$0")/udev/50-looper.rules
if [ -f "$RULE" ]; then
  mkdir -p /etc/polkit-1/rules.d
  install -m 644 "$RULE" /etc/polkit-1/rules.d/50-looper.rules
  rm -f /etc/udev/rules.d/50-looper.rules
  echo "postinstall: polkit rule installed for looper-rollback.service"
fi
exit 0
