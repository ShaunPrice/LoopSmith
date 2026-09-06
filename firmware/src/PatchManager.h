// PatchManager — owns the fixed audio skeleton and builds/tears down the
// dynamic effect insert described by a PatchScript preset.
//
//   i2s in -> inMix (L+R mono sum) -> preGain -+-> [fxin .. dynamic FX .. fxout]
//                                              |            |
//                                              |            v (wet)
//                                              +---------> bypassMix -> looper
//                                                              |          |
//                                                       live   v          v  loop
//                                                            outMix (-> peakOut) -> i2s out
//
// Dynamic streams are cached by (type, name) and reused across preset loads —
// AudioStream objects are never deleted (safe on every Teensyduino version).
// Connections are created/destroyed per load inside an AudioNoInterrupts()
// critical section.

#pragma once

#include <Arduino.h>
#include <Audio.h>
#include <vector>
#include "AudioEffectLooper.h"
#include "PatchScript.h"
#include "config.h"

class PatchManager {
public:
    void begin();

    // Parse and apply a preset. On failure returns false with `err` set; parse,
    // validation and allocation failures leave the previous graph intact (a
    // rare out-of-memory during parameter apply falls back to dry bypass).
    // `warnings` collects non-fatal issues.
    bool loadPatch(const char *text, size_t len, String &err, String &warnings);

    // Tear down the dynamic chain (bypass stays engaged until the next load).
    void unloadPatch();

    void   setBypass(bool on);
    bool   bypassed() const { return bypass_; }
    void   setVolume(float v);          // 0..1 headphone volume
    float  volume() const { return volume_; }

    // settings.txt lines: key(args...) — see docs
    void applySettingsText(const char *text, size_t len, String &warnings);

    const String &patchTitle() const { return title_; }
    int dynamicStreams() const;         // active streams in the current patch
    int cachedStreams() const { return (int)cache_.size(); }

    float peakIn();                     // 0..1, decays after read
    float peakOut();

    // USB playback (backing tracks): honour the computer's volume/mute for
    // the pedal's sound card. No-op in serial-only builds.
    void  pollUsbVolume();

    // Instrument source: the line input (default) or the USB audio stream from
    // the computer — a DI recording or backing track then runs through the
    // effects chain and the looper, and the processed result returns over USB.
    void  setInputSource(bool usb);
    bool  usbSource() const { return usbSource_; }

    // MIDI voices: objects bound with obj.midi(channel, group[, note]) in the
    // preset. Driven by USB MIDI and the serial `note` command. channel 1-16.
    void  noteOn(uint8_t channel, uint8_t note, float velocity);
    void  noteOff(uint8_t channel, uint8_t note);
    int   voiceCount() const { return (int)voices_.size(); }

    // Diagnostics evidence (see docs/PROTOCOL.md "#STATUS payload"):
    // patchRev() counts successful patch loads/applies so a UI can tell "the
    // running patch changed" apart from "the same patch is still running";
    // noteTriggers() counts voices actually triggered — evidence a note made
    // it through the allocator, not merely that MIDI was transmitted.
    uint32_t patchRev() const { return patchRev_; }
    uint32_t noteTriggers() const { return noteTriggers_; }

    // Diagnostic test tone: a quiet sine mixed in AFTER the preset graph and
    // the USB recording tap, so the running patch, the loop and recordings are
    // untouched and the tone stops by itself (pollTone(), called every loop).
    bool  toneStart(uint32_t ms, float freq, float level);
    void  toneStop();
    bool  toneActive() const { return toneOn_; }
    void  pollTone();

    AudioEffectLooper looper;           // public: the UI drives it directly

private:
    struct Cached {
        String name;
        String type;
        AudioStream *stream;
        const struct EffectInfo *info;
        bool inUse;
    };

    void drainDelays();   // release audio blocks pinned by cached delay queues

    enum VoiceKind : uint8_t { VK_KARPLUS, VK_DRUM, VK_WAVEFORM, VK_SINE, VK_MODULATED, VK_PWM, VK_ENV,
                               VK_SVF, VK_SWEEP, VK_SDWAV };
    // Per-object voice extras, set with the PatchScript extensions midiRatio(),
    // midiVelocity(), sweep() and file(); the base amplitude is taken from the
    // object's own amplitude()/begin() setter so velocity scales what the preset set.
    struct VoiceExtra {
        AudioStream *s = nullptr;
        float ratio = 1.0f, velSens = 0.0f, base = 1.0f;
        float swAmp = 0.5f, swFrom = 800.0f, swTo = 80.0f, swMs = 150.0f;
        String file;
    };
    struct VoiceMember { AudioStream *s; VoiceKind kind; VoiceExtra x; };
    struct VoiceUnit {
        uint8_t  channel;        // 0 = omni
        String   group;
        int16_t  note;           // -1 = any note, else only this note (drum pad)
        int16_t  playing = -1;   // note currently held, -1 = free
        uint32_t stamp = 0;      // allocation age
        std::vector<VoiceMember> members;
    };
    std::vector<VoiceUnit> voices_;
    std::vector<VoiceExtra> extras_;   // collected during the setter pass, copied into members after it
    uint32_t voiceClock_ = 0;
    VoiceExtra &extraFor(AudioStream *s);
    void applyExtras();

    bool bindVoice(const String &name, const String &type, AudioStream *s,
                   const std::vector<PatchArg> &args, String &why);
    void releaseVoices();   // note-off every bound envelope (before voices_ is dropped)
    void triggerUnit(VoiceUnit &u, float freq, float vel, int note);

    // ---- fixed skeleton ----
    AudioInputI2S        i2sIn;
    AudioMixer4          inMix;
    AudioAmplifier       preGain;
    AudioAmplifier       fxIn;          // PatchScript endpoint "fxin"
    AudioMixer4          fxOut;         // PatchScript endpoint "fxout"
    AudioMixer4          bypassMix;     // 0: wet chain, 1: dry
    AudioMixer4          outMix;        // 0: live, 1: looper
    AudioMixer4          monitorMix_;   // 0: outMix (everything), 1: test tone
    AudioSynthWaveformSine testTone_;   // diagnostic tone (amplitude 0 when idle)
    AudioOutputI2S       i2sOut;
    AudioAnalyzePeak     peakIn_;
    AudioAnalyzePeak     peakOut_;
#if defined(AUDIO_INTERFACE)          // USB_MIDI_AUDIO_SERIAL builds
    AudioOutputUSB       usbOut;      // pedal output -> computer (record loops)
    AudioInputUSB        usbIn;       // computer -> output mix (backing tracks)
#endif
    AudioControlSGTL5000 sgtl;

    // static patch cords for the skeleton (constructed in begin())
    std::vector<AudioConnection *> staticConns_;

    // dynamic graph
    std::vector<Cached> cache_;
    std::vector<AudioConnection *> dynConns_;

    String title_;
    float  usbInLevel_ = 1.0f;          // settings.txt usbInLevel(), unity for the mono sum
    float  monoL_ = 1.0f, monoR_ = 1.0f; // settings.txt monoSum() line-in gains
    bool   usbSource_ = false;
    float  hostVol_ = 1.0f;             // USB host volume/mute (0..1)
    bool   bypass_ = true;              // dry until a patch loads
    float  volume_ = DEFAULT_VOLUME;
    float  lastPeakIn_ = 0, lastPeakOut_ = 0;
    uint32_t patchRev_ = 0;             // bumped on every successful loadPatch
    uint32_t noteTriggers_ = 0;         // bumped whenever a voice unit fires
    bool     toneOn_ = false;
    uint32_t toneOffAt_ = 0;            // millis() deadline for the auto-stop
};
