// AudioEffectLooper — single-track guitar looper backed by Teensy 4.1 PSRAM (EXTMEM).
//
// Two full-length buffers are carved from EXTMEM: `cur` (what you hear) and `alt`
// (overdub scratch / undo history). Overdubbing reads cur and writes cur+input into
// alt; each time the write pass covers the whole loop the buffers swap, which makes
// undo/redo an O(1) pointer swap and never glitches playback.
//
// All state transitions happen inside update() (the audio ISR) at block boundaries.
// The UI thread only posts commands via an atomic byte, so there are no races and
// no locks. Punch in/out and the loop seam get short linear ramps to avoid clicks.
//
// With 2x APS6404L (16 MB) this gives ~95 seconds of mono 44.1 kHz loop time.

#pragma once

#include <Arduino.h>
#include <AudioStream.h>
#include "config.h"

class AudioEffectLooper : public AudioStream {
public:
    enum State : uint8_t {
        EMPTY = 0,      // no loop recorded
        RECORDING,      // laying down the initial loop
        PLAYING,        // loop playback
        OVERDUBBING,    // playback + layering input into the scratch buffer
        DUB_FINALIZE,   // dub ended mid-pass; completing the scratch copy silently
        STOPPING,       // one-block fade-out, then STOPPED
        STOP_COMMIT,    // stopped mid-dub-finalize: fast-finish the commit, then STOPPED
        STOPPED         // loop exists, playback halted
    };

    AudioEffectLooper() : AudioStream(1, inputQueueArray) {}

    // Allocate loop buffers from PSRAM. Call once in setup(), before audio starts.
    // Returns false if no PSRAM is fitted (looper stays disabled, passthrough only).
    bool begin();

    // --- UI thread API (footswitches / serial). Safe to call any time. ---
    void tapLoop()   { postCommand(CMD_TAP_LOOP); }  // rec -> play -> dub -> play...
    void tapStop()   { postCommand(CMD_TAP_STOP); }  // stop / restart
    void undo()      { postCommand(CMD_UNDO); }      // undo <-> redo last committed pass
    void clearLoop() { postCommand(CMD_CLEAR); }

    // --- status (reads are single-word, atomic on ARM) ---
    State    state() const          { return (State)publicState; }
    bool     hasLoop() const        { return lengthSamples_ != 0; }
    bool     canUndo() const        { return canUndo_; }
    uint32_t lengthSamples() const  { return lengthSamples_; }
    uint32_t positionSamples() const{ return posSamples_; }
    float    lengthSeconds() const  { return lengthSamples_ / (float)AUDIO_SAMPLE_RATE_EXACT; }
    float    positionSeconds() const{ return posSamples_ / (float)AUDIO_SAMPLE_RATE_EXACT; }
    float    maxSeconds() const     { return capacity / (float)AUDIO_SAMPLE_RATE_EXACT; }
    bool     enabled() const        { return capacity != 0; }
    const char* stateName() const;

    // --- bulk access from the main thread (LoopFiles) ---
    // Playback buffer + length — only when the ISR is truly idle in PLAYING or
    // STOPPED (not mid-commit); nullptr otherwise. Call with busy set.
    const int16_t *exportData(uint32_t &len) const;
    // After clearLoop() has been consumed (state EMPTY): the buffer to fill.
    int16_t  *importBuffer() { return (state() == EMPTY && !hasLoop()) ? cur : nullptr; }
    uint32_t  capacitySamples() const { return capacity; }
    void      importCommit(uint32_t samples) { importLen_ = samples; postCommand(CMD_IMPORT); }
    // While busy the ISR ignores footswitch/MIDI commands (no buffer swaps mid-copy).
    void      setBusy(bool b) { busy_ = b; }

    virtual void update() override;

private:
    enum : uint8_t {
        CMD_TAP_LOOP = 0x01,
        CMD_TAP_STOP = 0x02,
        CMD_UNDO     = 0x04,
        CMD_CLEAR    = 0x08,
        CMD_IMPORT   = 0x10,
    };
    static const uint32_t RAMP = LOOPER_RAMP_SAMPLES; // punch/seam ramp (~2.9 ms)
    static const uint32_t MIN_LOOP = 4410;     // refuse to close a loop under 100 ms
    static const uint32_t COMMIT_CHUNK = 64 * 128; // samples copied per update in STOP_COMMIT

    void postCommand(uint8_t c) {
        __atomic_or_fetch(&pendingCmd, c, __ATOMIC_ACQ_REL);
    }

    // ISR-side helpers
    void handleCommand(uint8_t cmd);
    void closeRecording(uint8_t nextState);
    void applySeamFades();
    void swapBuffers();

    audio_block_t *inputQueueArray[1];

    int16_t *bufA = nullptr, *bufB = nullptr;
    int16_t *cur = nullptr;   // playback buffer
    int16_t *alt = nullptr;   // overdub scratch / undo history
    uint32_t capacity = 0;    // samples per buffer

    // ISR state (touched only inside update())
    uint8_t  isrState = EMPTY;
    uint32_t pos = 0;         // playhead / record head, samples
    uint32_t length = 0;      // loop length, samples
    uint32_t passRemaining = 0; // samples left before the dub pass covers the loop
    uint32_t rampPos = 0;     // input ramp progress for punch in
    uint32_t rampOut = 0;     // input ramp-down remaining for finalize
    uint32_t playRamp = RAMP; // output fade-in progress after a restart
    bool     commitFade = false; // STOP_COMMIT still owes its one-block fade-out

    // shared with UI thread
    volatile uint8_t  isrPublic_ = EMPTY;   // raw ISR state (incl. DUB_FINALIZE/STOP_COMMIT)
    volatile uint32_t importLen_ = 0;
    volatile bool     busy_ = false;
    volatile uint8_t  pendingCmd = 0;
    volatile uint8_t  publicState = EMPTY;
    volatile uint32_t lengthSamples_ = 0;
    volatile uint32_t posSamples_ = 0;
    volatile bool     canUndo_ = false;
};
