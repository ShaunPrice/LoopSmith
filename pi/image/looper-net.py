#!/usr/bin/env python3
"""
looper-net — runs at every boot BEFORE NetworkManager. Reads looper.conf (boot partition
first, then /etc/looper) and writes the NetworkManager keyfiles.

The Pi 5 has one radio, so it does one thing at a time: until the pedal has joined a
network it puts up a **setup hotspot** (a random password, shown on the screen and written
to setup-code.txt); once a home network is configured the hotspot is left switched off and
the radio joins that network instead. Publishes what it decided in /run/looper/net.json.
"""
import json
import os
import re
import sys
import time
import uuid

BOOT = "/boot/firmware" if os.path.isdir("/boot/firmware") else "/boot"
CONF_PATHS = [os.path.join(BOOT, "looper.conf"), "/etc/looper/looper.conf"]
NM_DIR = "/etc/NetworkManager/system-connections"
STATE_DIR = "/run/looper"
NS = uuid.UUID("6f1c2f1e-5a7b-4d2c-9d1e-guitarloop00".replace("guitarloop00", "0a0b0c0d0e0f"))

DEFAULTS = {"HOTSPOT_SSID": "LoopSmith-setup", "HOTSPOT_CHANNEL": "6",
            "HOME_SSID": "", "HOME_PASS": "", "HOSTNAME": "loopsmith"}


def read_conf():
    conf = dict(DEFAULTS)
    for p in CONF_PATHS:
        try:
            with open(p, encoding="utf-8", errors="replace") as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith("#") or "=" not in line:
                        continue
                    k, v = line.split("=", 1)
                    k = k.strip().upper()
                    v = v.strip().strip('"').strip("'")
                    if k in DEFAULTS:
                        conf[k] = v
            break                       # first file found wins
        except OSError:
            continue
    return conf


def wifi_ifaces():
    out = {}
    for n in sorted(os.listdir("/sys/class/net")):
        if not os.path.isdir(f"/sys/class/net/{n}/phy80211"):
            continue
        drv = ""
        try:
            drv = os.path.basename(os.readlink(f"/sys/class/net/{n}/device/driver"))
        except OSError:
            pass
        out[n] = drv
    return out


def keyfile_hotspot(iface, ssid, psk, channel, enabled=True):
    return f"""[connection]
id=looper-hotspot
uuid={uuid.uuid5(NS, "hotspot")}
type=wifi
interface-name={iface}
autoconnect={"true" if enabled else "false"}
autoconnect-priority=10

[wifi]
mode=ap
ssid={ssid}
band=bg
channel={channel}

[wifi-security]
key-mgmt=wpa-psk
psk={psk}
proto=rsn;
pairwise=ccmp;
group=ccmp;

[ipv4]
method=shared
address1=10.42.0.1/24

[ipv6]
method=disabled
"""


def keyfile_home(iface, ssid, psk):
    sec = f"\n[wifi-security]\nkey-mgmt=wpa-psk\npsk={psk}\n" if psk else ""
    pin = f"interface-name={iface}\n" if iface else ""
    return f"""[connection]
id=looper-home
uuid={uuid.uuid5(NS, "home")}
type=wifi
{pin}autoconnect=true
autoconnect-priority=5

[wifi]
mode=infrastructure
ssid={ssid}
{sec}
[ipv4]
method=auto

[ipv6]
method=auto
"""


def write_private(path, text):
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.chmod(tmp, 0o600)
    os.replace(tmp, path)


def pin_existing_home(iface):
    """A looper-home profile saved from /setup: keep it, make sure it is pinned to the client radio."""
    path = os.path.join(NM_DIR, "looper-home.nmconnection")
    if not os.path.exists(path):
        return False
    try:
        with open(path, encoding="utf-8") as f:
            txt = f.read()
    except OSError:
        return False
    new = re.sub(r"^interface-name=.*$", "", txt, flags=re.M)
    if iface:
        new = new.replace("[connection]\n", f"[connection]\ninterface-name={iface}\n", 1)
    if new != txt:
        write_private(path, new)
    return True


def main():
    conf = read_conf()
    # the onboard radio is on SDIO and appears early; give a USB adapter a moment
    deadline = time.time() + 12
    ifaces = wifi_ifaces()
    while time.time() < deadline and len(ifaces) < 2:
        time.sleep(1)
        ifaces = wifi_ifaces()
    onboard = [n for n, d in ifaces.items() if d.startswith("brcmfmac")]
    others = [n for n in ifaces if n not in onboard]

    wifi = list(ifaces)
    radio = wifi[0] if wifi else "wlan0"
    hotspot_if = home_if = radio                  # one radio, two possible roles

    # a home network already configured (from looper.conf or saved from /setup) means the
    # onboarding hotspot has done its job and stays down
    have_home = bool(conf["HOME_SSID"]) or os.path.exists(os.path.join(NM_DIR, "looper-home.nmconnection"))

    # the hotspot password is generated once and kept in /etc/looper/hotspot-pass
    pass_file = "/etc/looper/hotspot-pass"
    try:
        hotspot_pass = open(pass_file).read().strip()
    except OSError:
        hotspot_pass = ""
    if not hotspot_pass:
        import secrets, string
        alphabet = string.ascii_lowercase + string.digits
        hotspot_pass = "".join(secrets.choice(alphabet) for _ in range(10))
        try:
            os.makedirs("/etc/looper", exist_ok=True)
            write_private(pass_file, hotspot_pass + "\n")
        except OSError:
            pass

    os.makedirs(NM_DIR, exist_ok=True)
    hs_path = os.path.join(NM_DIR, "looper-hotspot.nmconnection")
    write_private(hs_path, keyfile_hotspot(hotspot_if, conf["HOTSPOT_SSID"], hotspot_pass,
                                           conf["HOTSPOT_CHANNEL"], enabled=not have_home))

    if conf["HOME_SSID"]:
        write_private(os.path.join(NM_DIR, "looper-home.nmconnection"),
                      keyfile_home(home_if, conf["HOME_SSID"], conf["HOME_PASS"]))
    else:
        pin_existing_home(home_if)

    os.makedirs(STATE_DIR, exist_ok=True)
    # the bridge (uid 1000) hands privileged requests to looper-admin through this directory,
    # so it must be able to write here; the files themselves carry their own modes
    try:
        os.chown(STATE_DIR, 1000, 1000)
        os.chmod(STATE_DIR, 0o755)
    except OSError:
        pass
    state = {"hotspot_enabled": not have_home, "hotspot_if": hotspot_if, "home_if": home_if,
             "hotspot_ssid": conf["HOTSPOT_SSID"], "hotspot_pass": hotspot_pass,
             "hotspot_ip": "10.42.0.1", "single_radio": True, "have_home": have_home,
             "radios": ifaces, "written": int(time.time())}
    with open(os.path.join(STATE_DIR, "net.json"), "w") as f:
        json.dump(state, f)
    os.chmod(os.path.join(STATE_DIR, "net.json"), 0o644)
    print(f"looper-net: radio={radio} home_configured={have_home} hotspot={'off' if have_home else conf['HOTSPOT_SSID']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
