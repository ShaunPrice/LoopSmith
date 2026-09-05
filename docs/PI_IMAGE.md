# The companion image (Raspberry Pi 5)

A prepared SD card that turns a Raspberry Pi 5 into LoopSmith's companion computer. It serves
*Studio* on your network and on an HDMI screen, plays MIDI files into the pedal, keeps a loop
library on a USB drive, and updates itself. Nothing is installed by hand: the card sets itself up
on first boot.

## Build the card

```bash
curl -L -o raspios.img.xz https://downloads.raspberrypi.com/raspios_lite_arm64_latest
pi/image/build_image.sh raspios.img.xz arm64        # -> dist/LoopSmith-companion-arm64.img.xz
```

Flash the result with Raspberry Pi Imager (*Use custom*) or Etcher. **Do not apply Imager's own
customisation** — the image carries its own, and Imager's would set a password this design
deliberately leaves unset.

`build_image.sh` unpacks the stock image, mounts its boot partition (FAT, so macOS and Windows can
write it), stages the kit with `stage_kit.sh`, and recompresses. The root filesystem is never
touched; the Pi does the rest on first boot. To write a card directly instead, use
`pi/image/build_sd.sh raspios.img.xz /dev/diskN`, and `build_sd.sh - /dev/diskN` to refresh the kit
on a card you have already written.

Everything the image needs is on the boot partition, editable from any computer:

| On `bootfs` | Purpose |
|---|---|
| `looper.conf` | your settings — Wi-Fi, country, time zone, updates, splash and kiosk switches |
| `looper/` | the app, the first-boot installer, services, udev and polkit rules, the splash theme |
| `setup-code.txt` | written on first boot: the one-time code that claims the pedal |
| `config.txt`, `cmdline.txt` | HDMI, a quiet boot and the Wi-Fi regulatory domain |

## First boot, and how it is secured

No password ships with this image, and SSH starts switched off. On first boot the Pi:

1. generates a **setup code** and writes it to `setup-code.txt`, the console and the HDMI screen;
2. generates a random password for a temporary Wi-Fi network called **LoopSmith-setup**;
3. serves nothing but its **claim page** until someone completes it.

To claim it, either use the HDMI screen (no code needed — you are demonstrably at the pedal), or
join `LoopSmith-setup` and open `http://10.42.0.1/`. Enter the setup code, choose a user name and a
password of at least eight characters, and that one password then covers the web app, the console
and SSH. SSH is enabled at that moment, not before, and the setup code is destroyed.

Then join your own network from **/setup**. The Pi 5 has a single radio, so the setup network
switches off at that point and stays off; from then on the pedal lives at
`http://loopsmith.local/` (or the address the setup page shows).

### Afterwards

- Every browser that is not the pedal's own screen must **sign in**. Sessions last twelve hours and
  end when the bridge restarts. `WEB_AUTH=0` in `looper.conf` turns the requirement off.
- Changing the password from anywhere but the pedal's screen requires the current one.
- **At the pedal's screen you can always recover the account**: *Settings → Login → Reset the
  login* clears the credential and the claim page comes back, exactly as when the pedal was new.
  That is the intended path when you forget the password, and it needs physical access.
- The screen can be switched between Studio and a text console from the setup page
  (*This pedal computer → Show console on the screen*), or with
  <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>F2</kbd> and <kbd>Ctrl</kbd>+<kbd>Alt</kbd>+<kbd>F1</kbd>.

## The setup page

`http://loopsmith.local/setup`, also linked from Studio's top bar:

| Section | What it does |
|---|---|
| **Setup Wi-Fi** | the temporary network's name and password, while it still exists |
| **Home Wi-Fi** | scan, join, forget |
| **USB drive** | the loop and recording library; download or delete files |
| **Bluetooth** | scan, pair, connect, forget — a mouse, keyboard or controller for the screen |
| **Access** | the web login's state, SSH on/off, sign out of this browser |
| **Software** | version, check for updates, install, upload a bundle |
| **Login** | change the password; reset the account (at the pedal's screen only) |
| **This pedal computer** | which screen is showing, console/Studio, restart, shut down |

After an update the Studio kiosk on the Pi's screen reloads itself when it sees the new version. If it does not, **Reload the screen** on the Setup page restarts the kiosk browser (nothing else restarts), and Studio's own *Pedal computer* section has **Reload this screen** for whichever browser you are in.

## Updates

*Check for updates* → *Install*, from the setup page or Studio. Sources, in order:

1. **A bundle you upload** on the setup page (*Upload a bundle…*), or one dropped on the USB drive
   or the boot partition — built with `pi/image/build_release.sh`, needing no network at all.
2. **`UPDATE_URL`** in `looper.conf` — any HTTPS address serving such a bundle.
3. **`UPDATE_REPO=owner/name`** — the Pi fetches a GitHub repository and builds the bundle itself.
   A private repository needs a token *you* create, in `/etc/looper/github-token`, mode 600.

Every install keeps a rollback copy, verifies the new bridge answers, and restores the previous
version if it does not (`/var/lib/looper/update.log` records what happened). `looper-update.timer`
checks nightly and then applies operating-system security patches — never rebooting on its own.
`UPDATE_AUTO=0` leaves it all to the buttons.

## The boot splash

Instead of scrolling kernel text the screen shows the LoopSmith mark on a dark ground with a quiet
progress bar, until Studio appears (a Plymouth theme in `pi/image/splash`). `SPLASH=0` in
`looper.conf` restores the text.

## MIDI through the Pi

- **Files**: Studio's MIDI panel uploads `.mid` files to the USB drive and the Pi plays them into
  the pedal — tempo map honoured, loop option, all-notes-off on stop. The ten examples in
  [`midi/`](../midi/) are installed with the image.
- **Live**: `ws://loopsmith.local/midi` streams the pedal's MIDI port to every connected browser.
- **A controller** plugged into the Pi is routed to the pedal automatically.

## On the Pi

```
ssh <your user>@loopsmith.local          # once the pedal has been claimed
systemctl status looper-bridge looper-net looper-kiosk looper-update.timer
journalctl -u looper-bridge -f           # pedal connect/disconnect, editor sessions
```

Files: `/opt/looper/{pi,editor}` (the app), `/etc/looper/` (settings, credentials),
`/media/usb` (the drive), `/var/lib/looper/` (update log and staged bundles). The service and
account names use *looper* throughout — the product name changed, the internals did not.

## Troubleshooting

- **No setup network and no screen output.** Give the Pi its proper 27 W supply. An underpowered
  Pi 5 produces faults that look like software problems: dropped Wi-Fi, a blank screen, odd
  failures. `dmesg | grep -i voltage` will say so plainly.
- **The claim page will not accept the code.** It is case-insensitive but must match
  `setup-code.txt` on the card; the code is regenerated only on a fresh install.
- **Forgotten password.** At the pedal's screen: *Settings → Login → Reset the login*.
- **Locked out after bad passwords.** Debian's `pam_faillock` locks the account for *all* logins,
  including SSH keys. At the console: `sudo faillock --user <you> --reset`.
- **The screen stays on the console.** The kiosk needs Chromium, fetched on first internet contact:
  `systemctl status looper-provision`; apt's own output is in `/var/log/looper-provision.log`.
- **`loopsmith.local` does not resolve.** Android has no mDNS; use the numeric address from the
  setup page.
