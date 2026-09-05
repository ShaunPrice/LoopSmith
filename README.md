<h1 align="center">LoopSmith</h1>

<p align="center">
  <b>A guitar looper, effects rack and polyphonic synthesiser in one pedal —<br>
  whose sounds are text files you can rewrite, and whose screen is a web page.</b>
</p>

<p align="center">
  <a href="LICENSE"><img alt="Licence: GPL-2.0" src="https://img.shields.io/badge/licence-GPL--2.0-blue.svg"></a>
  <img alt="Firmware" src="https://img.shields.io/badge/firmware-Teensy%204.1-orange.svg">
  <img alt="Companion" src="https://img.shields.io/badge/companion-Raspberry%20Pi%205-c51a4a.svg">
  <img alt="Audio" src="https://img.shields.io/badge/audio-16--bit%2044.1%20kHz-2dd4bf.svg">
</p>

---

LoopSmith is an open-hardware effects looper built on a **Teensy 4.1** and its audio adaptor,
with a **Raspberry Pi 5** beside it as a companion computer. It records loops, runs effect
chains, plays seventeen built-in instruments, and is driven either with your feet or from a
browser on any device in the room.

Three things make it different from a shop-bought looper.

|  |  |
|---|---|
| **Effects are files** | Every chain is a short text file on the pedal's SD card. The firmware builds the audio graph at run time, so a new sound is a file you write — never a firmware rebuild. |
| **It plays itself** | Plucked strings, FM pianos and bells, organ, basses, pads, leads, three drum kits and your own WAV samples run on the same chip, played from a keyboard, a MIDI file, the browser or a footswitch — and looped like anything else. |
| **The screen is a browser** | *Studio*, the editor, is a single HTML file. Over USB it drives the pedal directly; over Wi-Fi it reaches it through the Pi, and installs to a phone's home screen like an app. |

## What it does

- **Looper** — up to 95 seconds, mono, unlimited overdubs with one-level undo, musical stop that
  finishes the phrase, and hold-to-erase. Loops are files: save them to the card, trim and fade
  them in the browser, download them for a DAW, or upload audio back.
- **Effects** — 29 audio blocks (reverb, delay, chorus, flanger, bitcrusher, overdrive, granular,
  three filter types, and the building blocks to combine them) arranged as a chain per preset, up
  to 48 objects and 96 connections.
- **Instruments** — 17 of them, MIDI-driven, with per-voice pitch ratios, velocity sensitivity and
  note-tracking filters. Five can run at once alongside an effect chain.
- **Six footswitches**, each with a tap action and a hold action, remappable from the browser and
  stored in the pedal.
- **One USB cable** carries the editor link, a stereo sound card and MIDI in/out at the same time.
- **The companion Pi** serves Studio on your network, plays MIDI files into the pedal, routes USB
  MIDI controllers to it, keeps a loop library on a USB drive, shows Studio full-screen on an HDMI
  display, and updates itself.

## How it fits together

```
  guitar ──▶ Teensy 4.1 + Audio Adaptor ──▶ amp / headphones
                    │  ▲                          
       USB (serial, audio, MIDI)                  
                    ▼  │                          
             Raspberry Pi 5  ──── Wi-Fi / Ethernet ────▶ phone · tablet · laptop
                    │                                     (Studio, the editor)
                    └── HDMI ──▶ Studio full-screen
```

The pedal is complete on its own — the Pi adds the network, the screen and the MIDI-file player.

## Hardware

### Parts list

Prices change, so none are quoted; the SKUs are [Core Electronics](https://core-electronics.com.au)
part numbers for buyers in Australia. Everything except the memory chips and the enclosure parts is
a stock item.

#### The pedal

| Part | SKU | Notes |
|---|---|---|
| [Teensy 4.1](https://core-electronics.com.au/teensy-4-1.html) | `DEV-16771` | 600 MHz Cortex-M7; buy the version **without** pins so the audio adaptor can sit on it |
| [Teensy Audio Adaptor Board, Rev D](https://core-electronics.com.au/teensy-audio-adapter-board-rev-d.html) | `DEV-15845` | SGTL5000 codec, line in/out, microSD socket |
| 2 × APS6404L-3SQR PSRAM, SOIC-8 | — | **16 MB of loop memory.** Sold by PJRC; also on Mouser/DigiKey. See [docs/HARDWARE.md](docs/HARDWARE.md) |
| 1 × W25Q32JVSSIQ SPI flash, SOIC-8 | — | Optional: the preset mirror on the audio adaptor, so the pedal works with no SD card. Larger W25Q parts work too |
| microSD card, 8–32 GB | `CE09939` | Presets, loops and samples live here |
| 6 × SPST momentary footswitch, panel mount | — | Soft-touch “tact” type is fine; a music-electronics supplier is the easiest source |
| 2 × 5 mm LED (red, green) + 2 × 220 Ω resistor | — | Record and play indicators |
| 2 × 6.35 mm mono jack socket, panel mount | — | Instrument in, amp out |
| USB-C cable, panel-mount extension | — | Power and the computer link |
| Enclosure, ~120 × 95 × 35 mm die-cast aluminium | — | A “1590BB”-style box; drilling plan in [docs/HARDWARE.md](docs/HARDWARE.md) |

#### The companion computer

| Part | SKU | Notes |
|---|---|---|
| [Raspberry Pi 5, 8 GB](https://core-electronics.com.au/raspberry-pi-5-model-b-8gb.html) | `CE09786` | 4 GB (`CE09785`) is plenty; 8 GB gives the browser room |
| [Official 27 W USB-C power supply](https://core-electronics.com.au/raspberry-pi-5-power-supply-usb-c-pd-27w-black.html) | `CE09788` | Do not skimp here — an underpowered Pi 5 misbehaves in ways that look like software faults |
| [Raspberry Pi 5 Active Cooler](https://core-electronics.com.au/raspberry-pi-5-active-cooler.html) | `CE09791` | The Pi runs a browser continuously |
| [microSD card, 32 GB A2](https://core-electronics.com.au/raspberry-pi-a2-class-sd-card-32gb.html) | `CE09939` | For the prepared image |
| USB flash drive, 8 GB or more | — | Loop library, recordings and MIDI files |
| USB-A to micro-USB / USB-C cable | — | Pi to pedal |

### Fitting the memory

The Teensy 4.1 ships with its PSRAM and flash pads **empty**, and the looper needs the PSRAM.
Soldering two SOIC-8 chips to the underside of the board is the one piece of fine work in this
project, and [docs/HARDWARE.md](docs/HARDWARE.md) walks through it — chip orientation, a
drag-soldering method that needs only a normal iron, and how to verify the result before you
build anything around it.

## Getting started

1. **Fit the memory** to the Teensy and solder the audio adaptor to it — [docs/HARDWARE.md](docs/HARDWARE.md).
2. **Flash the firmware** with [PlatformIO](https://platformio.org):
   ```bash
   cd firmware && pio run -e teensy41 -t upload
   ```
3. **Prepare the pedal's SD card**: copy `sdcard/` to the root of a FAT32 card (`settings.txt`,
   `presets/`). Put it in the audio adaptor's socket.
4. **Try it without the Pi**: open `editor/index.html` in Chrome or Edge, press **Connect USB**,
   and pick the Teensy. Everything but the network features works from here.
5. **Build the companion card** — [docs/PI_IMAGE.md](docs/PI_IMAGE.md):
   ```bash
   curl -L -o raspios.img.xz https://downloads.raspberrypi.com/raspios_lite_arm64_latest
   pi/image/build_image.sh raspios.img.xz arm64      # -> dist/LoopSmith-companion-arm64.img.xz
   ```
   Flash it, put it in the Pi, and power on.

### First run, and the security model

**No password ships with the image.** On first boot the Pi generates a one-time **setup code**,
shows it on the HDMI screen, prints it on the console and writes it to `setup-code.txt` on the
card's boot partition. Until someone uses it, the pedal serves nothing but its claim page and SSH
is switched off.

- Until it has joined a network the Pi puts up a temporary Wi-Fi called **LoopSmith-setup**, with a
  password generated on that same first boot. Join it and open `http://10.42.0.1/`.
- Enter the setup code, choose a **user name and a password of at least eight characters**, and the
  pedal is yours. That one password covers the web app, the console and SSH.
- Join your home Wi-Fi from the setup page. **The setup network then switches off and stays off** —
  the Pi 5 has a single radio, and once it is on your network it stays there.
- Afterwards every browser that is not the pedal's own screen must sign in. The HDMI screen never
  asks, and **from that screen you can always reset the login** without knowing the old password —
  the recovery path when you forget it.

## Using it

| | |
|---|---|
| **First loop** | Tap **LOOP**, play, tap again to close the loop, tap a third time to overdub. **STOP** finishes the phrase; hold it to erase. |
| **Studio** | `http://loopsmith.local/` on your network, or open `editor/index.html` over USB. Build chains, play instruments, remap the switches, edit loops, watch the meters. |
| **Instruments** | Add up to five, play them from the on-screen keys, your computer keyboard, a MIDI controller, a MIDI file or a footswitch. |
| **MIDI files** | Ten examples come with it ([midi/](midi/)) — load `10_song.txt` for the band ones or `11_fullkit.txt` for the percussion ones — a click, four drum patterns, bass, chords, a lead line and a full band, all cut to whole bars so they loop. |
| **The setup page** | `/setup` — network, SSH, Bluetooth devices, the login, software updates, a console on the screen, restart and shut down. |

Full instructions are in [docs/](docs/): the preset format ([PATCHSCRIPT.md](docs/PATCHSCRIPT.md)),
the serial protocol ([PROTOCOL.md](docs/PROTOCOL.md)), the hardware build
([HARDWARE.md](docs/HARDWARE.md)) and the companion image ([PI_IMAGE.md](docs/PI_IMAGE.md)).

## What a preset looks like

```c
// name: Ambient Swell
// Chorus into reverb with a parallel dry tap.
AudioEffectChorus   chorus1;
AudioEffectFreeverb verb1;
AudioMixer4         mix1;

AudioConnection c1(fxin, 0, chorus1, 0);
AudioConnection c2(chorus1, 0, mix1, 1);      // dry tap
AudioConnection c3(chorus1, 0, verb1, 0);
AudioConnection c4(verb1, 0, mix1, 0);        // wet
AudioConnection c5(mix1, 0, fxout, 0);

chorus1.begin(3);
verb1.roomsize(0.78);
mix1.gain(0, 0.55);
```

That is a whole preset. It is deliberately the same thing the Teensy Audio System Design Tool
exports, so a patch designed in the standard tool runs on the pedal unchanged — plus a few
extensions for MIDI voices.

## Repository layout

```
firmware/     Teensy 4.1 firmware (PlatformIO): looper, dynamic effect graph, voice engine
editor/       Studio — the whole editor in one HTML file, no build step
pi/           the companion computer: bridge, setup pages, and the SD-card image kit
  image/      build a ready-to-flash card, plus the first-boot installer and services
sdcard/       what goes on the pedal's own card: settings.txt and the example presets
midi/         ten example MIDI files, and the generator that made them
docs/         hardware build, preset format, serial protocol, companion image
```

## Developing without hardware

`pi/fake_pedal.py` is a complete simulator of the pedal's serial protocol on a pseudo-terminal:

```bash
python3 pi/fake_pedal.py                     # prints the port it is listening on
python3 pi/looper_bridge.py --port /dev/pts/3 --http 127.0.0.1:8080
```

Open `http://127.0.0.1:8080/` and the editor behaves as though a pedal were attached — enough to
work on presets, instruments and the interface with nothing plugged in.

## Licence

Released under the **GNU General Public License, version 2** — the same licence as the Linux
kernel. See [LICENSE](LICENSE).

## Credits

Built on [PJRC](https://www.pjrc.com)'s Teensy and its Audio Library, which does the real
digital-signal-processing work, and on Raspberry Pi OS. The preset format is a superset of the
Teensy Audio System Design Tool's export format.
