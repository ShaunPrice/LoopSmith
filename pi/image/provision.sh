#!/bin/bash
# Runs once the Pi can reach the internet: installs Chromium + cage for the HDMI kiosk,
# then enables it. Until this succeeds the pedal is fully usable from phones/laptops —
# only the on-screen kiosk waits. Retried by systemd until it works.
set -u
BOOT=/boot/firmware; [ -d "$BOOT" ] || BOOT=/boot
KIOSK=1
if [ -f "$BOOT/looper.conf" ]; then v=$(grep -E '^KIOSK=' "$BOOT/looper.conf" | tail -1 | cut -d= -f2 | tr -d ' "'); [ -n "$v" ] && KIOSK=$v; fi
export DEBIAN_FRONTEND=noninteractive
LOG=/var/log/looper-provision.log; echo "== $(date) provision run ==" >> $LOG
echo "provision: waiting for the internet (details in $LOG)"
for i in $(seq 1 20); do
  if apt-get update >>$LOG 2>&1; then break; fi
  sleep 15
  [ "$i" = 20 ] && { echo "provision: no internet yet"; exit 1; }
done
if [ "$KIOSK" = "1" ]; then
  echo "provision: installing chromium + cage"
  if ! apt-get install -y chromium cage >>$LOG 2>&1; then
    echo "provision: install failed - last lines of $LOG:"; tail -5 $LOG; exit 1
  fi
fi
# nicer for a 1 GB Pi running a browser
if [ -f /etc/dphys-swapfile ]; then sed -i 's/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=512/' /etc/dphys-swapfile; systemctl restart dphys-swapfile 2>/dev/null || true; fi
# the boot splash: plymouth plus our theme, in place of the scrolling kernel text
SPLASH=1
if [ -f "$BOOT/looper.conf" ]; then v=$(grep -E '^SPLASH=' "$BOOT/looper.conf" | tail -1 | cut -d= -f2 | tr -d ' "'); [ -n "$v" ] && SPLASH=$v; fi
if [ "$SPLASH" = "1" ] && [ -d /opt/looper/splash ] && ! plymouth-set-default-theme --list 2>/dev/null | grep -q '^looper$'; then
  echo "provision: installing the boot splash"
  if apt-get install -y -qq plymouth plymouth-themes >>$LOG 2>&1; then
    install -d /usr/share/plymouth/themes/looper
    install -m 644 /opt/looper/splash/* /usr/share/plymouth/themes/looper/
    plymouth-set-default-theme -R looper >>$LOG 2>&1 && echo "provision: splash theme set"
  else
    echo "provision: plymouth could not be installed (the boot text stays)"
  fi
fi

# security patches from then on, applied automatically but never rebooting by itself
apt-get install -y -qq unattended-upgrades >>$LOG 2>&1 && \
  printf 'APT::Periodic::Update-Package-Lists "1";\nAPT::Periodic::Unattended-Upgrade "1";\n' > /etc/apt/apt.conf.d/20auto-upgrades && \
  printf 'Unattended-Upgrade::Automatic-Reboot "false";\n' > /etc/apt/apt.conf.d/51looper-no-reboot && \
  echo "provision: unattended security upgrades enabled"
mkdir -p /var/lib/looper && touch /var/lib/looper/provisioned
if [ "$KIOSK" = "1" ]; then
  systemctl enable looper-kiosk.service
  systemctl start --no-block looper-kiosk.service
fi
echo "provision: done"
exit 0
