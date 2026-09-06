// LoopSmith v2 — hardware configuration and tunables
//
// Target: Teensy 4.1 + PJRC Audio Shield Rev D (SGTL5000)
//         2x APS6404L-3SQR PSRAM soldered to the bottom pads (16 MB EXTMEM)
//         W25Q32JVS flash populated on the audio shield (CS pin 6)
//
// Pins already claimed by the audio shield (do not reuse):
//   I2S:  7 (DIN), 8 (DOUT), 20 (LRCLK), 21 (BCLK), 23 (MCLK)
//   I2C:  18 (SDA), 19 (SCL)
//   SPI:  11 (MOSI), 12 (MISO), 13 (SCK) — shared bus to the shield flash
//   CS:   6 (shield flash), 10 (shield SD socket — unused, held high)

#pragma once

// ---------------------------------------------------------------- footswitches
// Momentary SPST to ground, INPUT_PULLUP.
#define PIN_FS_LOOP        0   // record -> play -> overdub -> play ...
#define PIN_FS_STOP        1   // tap: stop / restart. hold: clear loop
#define PIN_FS_UNDO        2   // tap: undo / redo last overdub
#define PIN_FS_FX_NEXT     3   // tap: next preset. hold: reload current
#define PIN_FS_FX_PREV     4   // tap: previous preset
#define PIN_FS_FX_BYPASS   5   // tap: bypass effect chain

// ---------------------------------------------------------------------- LEDs
#define PIN_LED_REC        16  // red:   solid = recording, blink = overdub
#define PIN_LED_PLAY       17  // green: solid = playing, slow blink = stopped w/ loop

// ------------------------------------------------------------------ chip selects
#define PIN_SHIELD_FLASH_CS 6  // W25Q32 on the audio shield (LittleFS)
#define PIN_SHIELD_SD_CS    10 // shield SD socket — deselected at boot

// ------------------------------------------------------------------- optional pot
// The audio shield has pads for a 10k volume pot on A1 (pin 15).
#define ENABLE_VOLUME_POT  0
#define PIN_VOLUME_POT     15  // A1

// ----------------------------------------------------------------- audio config
#define AUDIO_MEM_BLOCKS   400   // ~104 KB of RAM2; AudioEffectDelay taps share this
#define DEFAULT_VOLUME     0.70f // SGTL5000 headphone volume 0..1
#define DEFAULT_LINEIN     8     // SGTL5000 line-in level 0..15, higher = more
                                 // sensitive (8 = 0.79 Vp-p full scale)
#define DEFAULT_MICGAIN    36    // dB, used only when input(MIC)

// -------------------------------------------------------------------- looper
// Two full-loop buffers (current + undo/scratch) are carved from EXTMEM.
// With 16 MB PSRAM that is ~95 s of mono 44.1 kHz loop time.
#define LOOPER_RAMP_SAMPLES   128   // ~2.9 ms punch in/out and seam fades
#define LOOPER_HOLD_CLEAR_MS  1200  // hold STOP this long to clear
#define BUTTON_HOLD_MS        900   // generic hold threshold (FX reload)
#define BUTTON_DEBOUNCE_MS    12

// After closing the initial recording, drop into:
//   0 = PLAYING (TC Ditto style)   1 = OVERDUBBING (Boss RC style)
#define LOOPER_CLOSE_TO_OVERDUB 0

// ------------------------------------------------------------------- presets
#define PRESET_DIR         "/presets"
#define SETTINGS_FILE      "/settings.txt"
#define PRESET_MAX_BYTES   16384
#define PATCH_MAX_STREAMS  48
#define PATCH_MAX_CONNS    96

#define FIRMWARE_VERSION   "2.2.2"
#define PROTOCOL_VERSION   1

// ---------------------------------------------------------------- diagnostics
// The `tone` serial command plays a quiet sine straight into the output stage
// (after the preset graph AND the USB tap, so the running patch, the loop and
// USB recordings are never touched — the tone reaches the headphone/line out
// only). It stops itself: the expiry is polled from loop() via Pedal::poll()
// and additionally from inside the blocking counted-transfer loops in
// SerialProtocol. Media/transfer commands also stop it before blocking work.
// Expiry is main-loop serviced; it is not a hardware watchdog deadline.
// Clamps keep a mistyped command from being loud or endless; the level is
// deliberately conservative (a diagnostic beep, not a reference tone).
#define TONE_MS_MIN        100
#define TONE_MS_MAX        5000
#define TONE_MS_DEFAULT    1000
#define TONE_FREQ_MIN      40.0f
#define TONE_FREQ_MAX      5000.0f
#define TONE_FREQ_DEFAULT  440.0f
#define TONE_LEVEL_MAX     0.05f
#define TONE_LEVEL_DEFAULT 0.02f
