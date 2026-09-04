# Building the pedal

Two jobs need a soldering iron: fitting the memory chips to the Teensy 4.1, and wiring the
enclosure. Neither is difficult, but the memory chips are the fine work — do them first, on the
bare board, before anything else is attached.

---

## 1. Fitting the memory

The Teensy 4.1 has three empty footprints on its underside. This project uses two of them.

| Footprint | Chip | Why |
|---|---|---|
| The **two PSRAM pads** (marked *PSRAM* / *FLASH* in the middle of the board) | 2 × **APS6404L-3SQR** (8 MB QSPI PSRAM, SOIC-8 208-mil) | **Required.** The looper records into PSRAM: two chips give 16 MB, which is the 95-second loop and its undo buffer. |
| The **audio adaptor's flash pad** (Rev D, marked *FLASH*) | 1 × **W25Q32JVSSIQ** (4 MB SPI flash, SOIC-8 208-mil) — larger W25Q parts also work | Optional. Holds a mirror of your presets so the pedal still boots and plays with no SD card in. |

Both are sold by [PJRC](https://www.pjrc.com/store/psram.html) and by Mouser, DigiKey and Element14.
Buy one spare of each — they cost little and the practice is worth more.

> **Why not one chip?** One PSRAM gives 8 MB and about 47 seconds of loop. The firmware uses
> whatever it finds, so a single chip works; the second one doubles the loop and makes the
> pointer-swap undo free.

### What you need

- A temperature-controlled iron with a fine chisel tip (2 mm is ideal — not a needle point)
- Thin solder, 0.5 mm or finer
- **No-clean flux**, in a pen or syringe — this is the part that makes it easy
- Solder wick and isopropyl alcohol
- Magnification: a loupe, a phone camera on macro, or a cheap USB microscope
- Tweezers, and tape or Blu Tack to hold the board still

### Orientation — get this right first

Every chip has a **pin 1** marker: a dimple, a dot, or a bevelled edge on one end. Each footprint
on the Teensy has a matching **square pad** and a silkscreen notch. Line the chip's marker up with
the square pad. The two PSRAM footprints sit side by side and face the **same way**.

Photograph the empty pads with your phone before you start, zoomed right in. If a chip ends up
rotated, that picture is how you will know.

### The method (drag soldering)

1. **Tape the Teensy down**, underside up, on a flat surface.
2. **Tin one corner pad**: melt a small blob of solder onto a single pad — pin 1's — and no others.
3. **Place the chip**: hold it with tweezers, line the marker up with the square pad, and reflow
   that one blob so the chip is tacked in place. Now check the alignment under magnification: every
   leg should sit centred on its pad. It is trivial to correct now and painful later.
4. **Flux generously** along one row of legs.
5. **Drag**: with a little solder on the tip, draw it slowly along the row. The flux pulls solder
   onto each joint; bridges between adjacent legs are normal at this stage.
6. **Wick the bridges away**: press clean wick onto the bridged legs with the iron; the excess
   leaves and the joints stay.
7. Repeat for the other row, then **clean with isopropyl** and inspect: each leg should show a
   small shiny fillet, and no two should be joined.

Take your time with the first chip; the second takes a quarter as long.

### Verifying, before you build anything around it

In the Arduino IDE with Teensyduino, open **File → Examples → Teensy → Extended Memory →
PSRAM_Memtest**, set the board to Teensy 4.1, and run it with the serial monitor open. It reports
how much PSRAM it found and runs several test patterns. You are looking for:

```
EXTMEM Memory Test, 16 MB
...
All memory tests passed :-)
```

If it reports 8 MB, one chip is not making contact. If it reports 0 MB, check orientation first,
then reflow the row nearest the notch. If a test fails, that is nearly always a dry joint: add
flux and re-drag the affected row.

For the flash chip, run **File → Examples → LittleFS → ListFiles** with `LittleFS_QSPIFlash`
selected, or simply flash LoopSmith and look at the reply to `ping`:

```
#PONG {"fw":"2.2.0","proto":1,"psram_mb":16,"sd":true,"flash":true}
```

`psram_mb` and `flash` tell you what the firmware can actually see.

### Fitting the audio adaptor

The adaptor stacks on the Teensy's outer pin rows. Solder pins into the Teensy first, check the
board sits flat and square, then solder the adaptor on top. Do this **after** the memory chips —
once the adaptor is on, the underside pads are hard to reach.

---

## 2. Wiring the enclosure

The firmware's pin map (`firmware/src/config.h`):

| Function | Teensy pin | Wiring |
|---|---|---|
| Footswitch 1 — LOOP | 0 | switch between the pin and GND (the firmware enables an internal pull-up) |
| Footswitch 2 — STOP | 1 | " |
| Footswitch 3 — UNDO | 2 | " |
| Footswitch 4 — NEXT | 3 | " |
| Footswitch 5 — PREV | 4 | " |
| Footswitch 6 — BYPASS | 5 | " |
| REC indicator | 16 | LED anode via 220 Ω to the pin, cathode to GND |
| PLAY indicator | 17 | " |
| Audio in / out | — | on the adaptor: LINE IN and LINE OUT |
| SD card | — | the adaptor's socket |

Every switch is wired the same way and every one is remappable in software, so it does not matter
which physical switch you call LOOP — decide with your feet and set it in Studio.

### Panel layout

A 1590BB-sized box (about 120 × 95 × 35 mm) fits six switches in two rows of three, with the jacks
on the top edge and USB on the back.

```
        ┌─────────────────────────────────────────┐
   IN ○ │                 USB                     │ ○ OUT      ← top edge
        │                                         │
        │     ●REC                    ●PLAY       │            ← 5 mm LEDs
        │                                         │
        │   (1)LOOP     (2)STOP     (3)UNDO       │            ← 12 mm switch holes
        │                                         │
        │   (4)NEXT     (5)PREV     (6)BYPASS     │
        └─────────────────────────────────────────┘
```

Hole sizes: **12 mm** for common panel-mount footswitches (check yours), **5 mm** for the LEDs,
**10 mm** for 6.35 mm jack sockets. Leave at least 40 mm between switch centres so a boot lands on
one at a time.

### Wiring notes

- Run a **single ground bus** around the switches and back to one Teensy GND — daisy-chaining
  grounds through the switch bodies invites hum.
- Keep the audio wiring away from the USB cable inside the box; if you hear a whine that changes
  with what the computer is doing, that is why.
- The pedal is powered from USB. If it will live on a pedalboard, a USB power bank or a good 5 V
  supply into a panel-mount USB extension is tidier than a laptop cable.
- Set the input sensitivity for your pickups in `settings.txt` (`lineInLevel`), not with a
  potentiometer — see the settings section of [PI_IMAGE.md](PI_IMAGE.md) and `sdcard/settings.txt`.

---

## 3. Connecting the companion Pi

One USB-A to micro-USB/USB-C cable from the Pi to the pedal carries everything: the editor link,
audio both ways and MIDI. The Pi needs its own 27 W supply — do not try to run it from the pedal or
a phone charger. Give it its active cooler; it runs a browser all day.

Nothing else is required: no HAT, no extra audio board. If you want the Pi to make its own sound
(backing tracks through its headphone-less HDMI, or a USB audio interface), any class-compliant USB
audio device works.
