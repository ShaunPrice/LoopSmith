// LoopSmith v2 — Teensy 4.1 + Audio Shield guitar looper with
// SD-defined dynamic effect chains. See the repo README for wiring and usage.
//
//   guitar -> line in -> [PatchScript FX chain] -> looper -> line out
//
// Presets: /presets/*.txt on SD (mirrored to shield flash)
// Editor:  editor/index.html (Chrome/Edge, Web Serial)

#include <Arduino.h>
#include <Audio.h>
#include <Wire.h>
#include <SPI.h>

#include "config.h"
#include "Pedal.h"
#include "Controls.h"
#include "SerialProtocol.h"

extern "C" uint8_t external_psram_size;

Pedal          pedal;
Controls       controls;
SerialProtocol proto;

#if defined(MIDI_INTERFACE)
// USB MIDI control (any channel): Program Change = preset index,
// CC7 = volume, CC80 LOOP, CC81 STOP, CC82 UNDO, CC83 CLEAR,
// CC84 bypass (>=64 on), CC85 next preset, CC86 previous preset.
static void pollMidi()
{
    while (usbMIDI.read()) {
        uint8_t type = usbMIDI.getType();
        if (type == usbMIDI.NoteOn || type == usbMIDI.NoteOff) {
            uint8_t ch = usbMIDI.getChannel(), n = usbMIDI.getData1(), v = usbMIDI.getData2();
            if (type == usbMIDI.NoteOn && v > 0) pedal.patch.noteOn(ch, n, v / 127.0f);
            else pedal.patch.noteOff(ch, n);
        } else if (type == usbMIDI.ProgramChange) {
            String err;
            pedal.loadPresetByIndex(usbMIDI.getData1(), err);
        } else if (type == usbMIDI.ControlChange) {
            uint8_t cc = usbMIDI.getData1(), v = usbMIDI.getData2();
            AudioEffectLooper &lp = pedal.patch.looper;
            switch (cc) {
            case 7:  pedal.patch.setVolume(v / 127.0f); pedal.persistLater(); break;
            case 80: if (v >= 64) lp.tapLoop(); break;
            case 81: if (v >= 64) lp.tapStop(); break;
            case 82: if (v >= 64) lp.undo(); break;
            case 83: if (v >= 64) lp.clearLoop(); break;
            case 84: pedal.patch.setBypass(v >= 64); pedal.persistLater(); break;
            case 85: if (v >= 64) pedal.nextPreset(); break;
            case 86: if (v >= 64) pedal.prevPreset(); break;
            default: break;
            }
        }
    }
}
#endif

void setup()
{
    Serial.begin(115200);
    uint32_t t0 = millis();
    while (!Serial && millis() - t0 < 1500) {}

    AudioMemory(AUDIO_MEM_BLOCKS);

    pedal.patch.begin();

    bool psramOk = pedal.patch.looper.begin();
    pedal.begin();
    controls.begin();
    proto.begin(&pedal);

    Serial.println("LoopSmith " FIRMWARE_VERSION);
    Serial.printf("  PSRAM: %u MB%s\n", (unsigned)external_psram_size,
                  psramOk ? "" : "  !! no PSRAM found - looper disabled");
    if (psramOk)
        Serial.printf("  loop time: %.1f s\n", pedal.patch.looper.maxSeconds());
    Serial.printf("  SD: %s   shield flash: %s\n",
                  pedal.store.sdPresent() ? "ok" : "missing",
                  pedal.store.flashPresent() ? "ok" : "missing");
    Serial.printf("  presets: %d", (int)pedal.store.presets().size());
    if (pedal.presetIndex >= 0)
        Serial.printf("  (loaded %s)", pedal.presetName().c_str());
    Serial.println();
#if defined(AUDIO_INTERFACE)
    Serial.println("  USB: serial + MIDI + audio (pedal appears as a sound card)");
#else
    Serial.println("  USB: serial only");
#endif
    Serial.println("type 'help' for the console commands");
}

void loop()
{
    SwitchEvents e = controls.poll();
    AudioEffectLooper &lp = pedal.patch.looper;
    bool running = (lp.state() == AudioEffectLooper::RECORDING ||
                    lp.state() == AudioEffectLooper::PLAYING ||
                    lp.state() == AudioEffectLooper::OVERDUBBING);

    // Time-critical actions fire on the press edge; the rest fire on release
    // when the switch also has a hold action (so tap and hold can be told
    // apart). STOP is special: press when running, release when stopped, so
    // holding STOP to clear never audibly restarts the loop first.
    static bool stopActedOnPress[NUM_SWITCHES] = {false};
    auto immediate = [](uint8_t a) {
        return a == ACT_LOOP || a == ACT_UNDO || a == ACT_BYPASS;   // clear is destructive: release rule
    };
    for (int i = 0; i < NUM_SWITCHES; i++) {
        const SwitchConfig &c = pedal.switches[i];
        if (e.pressed[i]) {
            if (c.tap == ACT_STOP) {
                if (c.hold == ACT_NONE) { lp.tapStop(); stopActedOnPress[i] = true; }   // no hold: always on press
                else { stopActedOnPress[i] = running; if (running) lp.tapStop(); }
            } else if (c.tap == ACT_NOTE) {
                pedal.runAction(ACT_NOTE, c.note, true);
            } else if (immediate(c.tap) || c.hold == ACT_NONE) {
                pedal.runAction(c.tap, 0, true);
            }
        }
        if (e.tapped[i]) {
            if (c.tap == ACT_STOP) { if (!stopActedOnPress[i]) lp.tapStop(); }
            else if (c.tap != ACT_NOTE && !immediate(c.tap) && c.hold != ACT_NONE) pedal.runAction(c.tap, 0, true);
        }
        if (e.held[i] && c.hold != ACT_NONE) pedal.runAction(c.hold, c.note, true);
        if (e.released[i]) {
            if (c.tap == ACT_NOTE || c.hold == ACT_NOTE) pedal.runAction(ACT_NOTE, c.note, false);
        }
    }

#if ENABLE_VOLUME_POT
    static uint32_t lastPot = 0;
    static int lastVal = -1;
    if (millis() - lastPot > 50) {
        lastPot = millis();
        int v = analogRead(PIN_VOLUME_POT);
        if (lastVal < 0 || abs(v - lastVal) > 8) {
            lastVal = v;
            pedal.patch.setVolume(v / 1023.0f);
        }
    }
#endif

    proto.poll();
#if defined(MIDI_INTERFACE)
    pollMidi();
#endif
    pedal.patch.pollUsbVolume();
    pedal.store.poll();
    pedal.poll();
    controls.updateLeds(lp.state(), lp.hasLoop());
}
