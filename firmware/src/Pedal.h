// Pedal — glues storage, the patch manager and persistence together, and owns
// preset navigation. Everything the footswitches and the serial protocol call.

#pragma once

#include <Arduino.h>
#include <EEPROM.h>
#include "PatchManager.h"
#include "PresetStore.h"
#include "Actions.h"

class Pedal {
public:
    PatchManager patch;
    PresetStore  store;

    int    presetIndex = -1;    // -1 = none loaded (or a live-applied patch)
    String lastWarnings;
    uint32_t midiRxNotes = 0;   // USB MIDI note on/off received (diagnostics evidence)
    SwitchConfig switches[NUM_SWITCHES] = {
        {ACT_LOOP, ACT_NONE, 0}, {ACT_STOP, ACT_CLEAR, 0}, {ACT_UNDO, ACT_NONE, 0},
        {ACT_NEXT, ACT_RELOAD, 0}, {ACT_PREV, ACT_NONE, 0}, {ACT_BYPASS, ACT_NONE, 0}};

    // Run a footswitch/MIDI-mapped action. `on` = press (true) / release (false),
    // only meaningful for ACT_NOTE.
    void runAction(uint8_t act, uint8_t note, bool on)
    {
        AudioEffectLooper &lp = patch.looper;
        switch (act) {
        case ACT_LOOP:   lp.tapLoop(); break;
        case ACT_STOP:   lp.tapStop(); break;
        case ACT_UNDO:   lp.undo(); break;
        case ACT_CLEAR:  lp.clearLoop(); break;
        case ACT_NEXT:   nextPreset(); break;
        case ACT_PREV:   prevPreset(); break;
        case ACT_RELOAD: reloadPreset(); break;
        case ACT_BYPASS: patch.setBypass(!patch.bypassed()); persistLater(); break;
        case ACT_SOURCE: patch.setInputSource(!patch.usbSource()); break;
        case ACT_NOTE:   if (on) patch.noteOn(10, note, 1.0f); else patch.noteOff(10, note);
                         midiOut(10, note, 127, on); break;
        default: break;
        }
    }

    // Notes the pedal plays by itself (footswitches, the serial `note` command) go out
    // over USB MIDI too, so a DAW or the Pi can record what was played. Notes that
    // arrived over MIDI are not echoed back.
    void midiOut(uint8_t ch, uint8_t note, uint8_t vel, bool on)
    {
#if defined(USB_MIDI) || defined(USB_MIDI_SERIAL) || defined(USB_MIDI_AUDIO_SERIAL) || defined(USB_MIDI_DUAL_SERIAL) || defined(USB_MIDI_AUDIO_DUAL_SERIAL)
        if (on) usbMIDI.sendNoteOn(note, vel, ch); else usbMIDI.sendNoteOff(note, 0, ch);
#else
        (void)ch; (void)note; (void)vel; (void)on;
#endif
    }

    bool setSwitch(int idx, int tap, int hold, int note)
    {
        if (idx < 0 || idx >= NUM_SWITCHES || tap < 0 || tap >= ACT_COUNT || hold < 0 || hold >= ACT_COUNT) return false;
        switches[idx] = {(uint8_t)tap, (uint8_t)hold, (uint8_t)(note < 0 ? 0 : note > 127 ? 127 : note)};
        persistLater();
        return true;
    }

    void begin()
    {
        booting_ = true;
        store.begin();

        char *buf; size_t len;
        String warn;
        if (store.readSettings(&buf, &len)) {
            patch.applySettingsText(buf, len, warn);
            free(buf);
            if (warn.length()) Serial.print(warn);
        }

        // restore last session (volume / preset / bypass)
        Persist p;
        EEPROM.get(0, p);
        bool legacy = (p.magic == MAGIC_V2);        // same prefix layout, no switch config
        bool restored = (p.magic == MAGIC) || legacy;
        if (restored) patch.setVolume(p.volume);
        if (restored && !legacy) {
            for (int i = 0; i < NUM_SWITCHES; i++) {
                if (p.tap[i] < ACT_COUNT && p.hold[i] < ACT_COUNT)
                    switches[i] = {p.tap[i], p.hold[i], (uint8_t)(p.note[i] & 0x7F)};
            }
        }

        int idx = restored ? p.presetIndex : 0;
        if (!store.presets().empty()) {
            if (idx < 0 || idx >= (int)store.presets().size()) idx = 0;
            String err;
            if (!loadPresetByIndex(idx, err)) {
                Serial.print("preset load failed: ");
                Serial.println(err);
            } else if (restored && p.bypass) {
                patch.setBypass(true);   // after the load, so it wins
            }
        }
        booting_ = false;
        persist();                       // one write, with the full restored state
    }

    String presetName() const
    {
        if (presetIndex < 0 || presetIndex >= (int)store.presets().size()) return "";
        return store.presets()[presetIndex];
    }

    bool loadPresetByIndex(int idx, String &err)
    {
        if (idx < 0 || idx >= (int)store.presets().size()) {
            err = "no such preset";
            return false;
        }
        char *buf; size_t len;
        String name = store.presets()[idx];
        if (!store.readPreset(name, &buf, &len)) {
            err = "cannot read " + name;
            return false;
        }
        lastWarnings = "";
        bool ok = patch.loadPatch(buf, len, err, lastWarnings);
        free(buf);
        if (ok) {
            presetIndex = idx;
            if (lastWarnings.length()) Serial.print(lastWarnings);
            if (!booting_) persistLater();
        }
        return ok;
    }

    bool loadPresetByName(const String &name, String &err)
    {
        for (int i = 0; i < (int)store.presets().size(); i++) {
            if (store.presets()[i].equalsIgnoreCase(name))
                return loadPresetByIndex(i, err);
        }
        err = "no such preset";
        return false;
    }

    // Step forward/backward, skipping presets that fail to load so one broken
    // file can never wedge navigation. Returns false only if nothing loads.
    bool stepPreset(int dir, String &err)
    {
        int n = (int)store.presets().size();
        if (n == 0) { err = "no presets"; return false; }
        int base = (presetIndex >= 0) ? presetIndex : 0;
        for (int i = 1; i <= n; i++) {
            int idx = ((base + dir * i) % n + n) % n;
            if (loadPresetByIndex(idx, err)) return true;
        }
        return false;
    }

    void nextPreset() { String err; stepPreset(+1, err); }
    void prevPreset() { String err; stepPreset(-1, err); }

    void reloadPreset()
    {
        if (presetIndex < 0) return;
        String err;
        loadPresetByIndex(presetIndex, err);
    }

    // After a put/rm changed the preset list, re-find `name` so presetIndex
    // still points at the loaded preset (or -1 if it was removed).
    void refreshIndexFor(const String &name)
    {
        presetIndex = -1;
        for (int i = 0; i < (int)store.presets().size(); i++) {
            if (store.presets()[i].equalsIgnoreCase(name)) {
                presetIndex = i;
                return;
            }
        }
    }

    // Hot paths (MIDI CC sweeps, footswitches, serial vol) must not write the
    // EEPROM emulation directly: a flash program/erase runs with interrupts
    // off and stalls the audio engine. They mark dirty; poll() writes once
    // the value has been stable for a moment.
    void persistLater()
    {
        dirty_ = true;
        dirtySince_ = millis();
    }

    void poll()
    {
        patch.pollTone();                // auto-stop for the diagnostic test tone
        // The EEPROM emulation programs flash with interrupts off, which can
        // drop audio blocks — so only write while the looper is idle.
        AudioEffectLooper::State s = patch.looper.state();
        bool quiet = (s == AudioEffectLooper::EMPTY || s == AudioEffectLooper::STOPPED);
        if (dirty_ && quiet && millis() - dirtySince_ >= 1500) {
            dirty_ = false;
            persist();
        }
    }

    void persist()
    {
        if (booting_) return;
        Persist p = {};
        EEPROM.get(0, p);
        bool had = (p.magic == MAGIC);
        p.magic = MAGIC;
        // a live-applied patch (index -1) keeps the last stored preset
        if (presetIndex >= 0 || !had) p.presetIndex = (int16_t)max(presetIndex, -1);
        p.volume = patch.volume();
        p.bypass = patch.bypassed() ? 1 : 0;
        for (int i = 0; i < NUM_SWITCHES; i++) { p.tap[i] = switches[i].tap; p.hold[i] = switches[i].hold; p.note[i] = switches[i].note; }
        Persist old = {};
        EEPROM.get(0, old);
        if (memcmp(&p, &old, sizeof(p)) != 0) EEPROM.put(0, p);
    }

private:
    struct Persist {
        uint32_t magic;
        int16_t  presetIndex;
        float    volume;
        uint8_t  bypass;
        uint8_t  tap[NUM_SWITCHES];
        uint8_t  hold[NUM_SWITCHES];
        uint8_t  note[NUM_SWITCHES];
    };
    static const uint32_t MAGIC = 0x474C5333;    // "GLS3" (layout: + switch config)
    static const uint32_t MAGIC_V2 = 0x474C5332; // "GLS2" — earlier firmware, prefix-compatible
    bool booting_ = false;
    bool dirty_ = false;
    uint32_t dirtySince_ = 0;
};
