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
#include "LooperTiming.h"

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
        STOPPED,        // loop exists, playback halted
        ARMED,          // sync: waiting for the next beat/bar to start recording
        COUNT_IN        // sync: metronome count-in before recording starts
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

    // --- musical sync (see LooperTiming.h and docs/LOOPER_SYNC.md) ---
    // Config setters, callable from the UI thread; the ISR picks a change up
    // at the next audio block. Values are clamped by the engine.
    void syncSetMode(uint8_t m)            { cfgMode_ = m; cfgSeq_ = cfgSeq_ + 1; }
    void syncSetSource(uint8_t s)          { cfgSource_ = s; cfgSeq_ = cfgSeq_ + 1; }
    void syncSetSamplesPerBeat(uint32_t s) { cfgSpb_ = s; cfgSeq_ = cfgSeq_ + 1; }
    void syncSetCountIn(uint8_t bars)      { cfgCountIn_ = bars; cfgSeq_ = cfgSeq_ + 1; }
    void syncSetBars(uint16_t bars)        { cfgBars_ = bars; cfgSeq_ = cfgSeq_ + 1; }
    void syncSetMet(uint8_t m)             { cfgMet_ = m; cfgSeq_ = cfgSeq_ + 1; }
    void syncSetMetVol(float v)            { cfgMetVol_ = (uint16_t)(constrain(v, 0.0f, 1.0f) * 256.0f); }
    // configured values (UI-side mirrors, for status)
    uint8_t  syncMode() const     { return cfgMode_; }
    uint8_t  syncSource() const   { return cfgSource_; }
    uint8_t  syncCountIn() const  { return cfgCountIn_; }
    uint16_t syncBars() const     { return cfgBars_; }
    uint8_t  syncMet() const      { return cfgMet_; }
    float    syncMetVol() const   { return cfgMetVol_ / 256.0f; }
    // live engine state (ISR mirrors, for status)
    uint8_t  syncPhase() const    { return syncPhase_; }     // LooperTiming::Phase
    uint8_t  syncBeat() const     { return syncBeat_; }      // 1-based beat in the bar
    float    syncBpm() const                                 // effective tempo
    {
        uint32_t s = syncSpb_;
        return s ? 60.0f * AUDIO_SAMPLE_RATE_EXACT / s : 0.0f;
    }
    // events from the MIDI clock follower (main thread)
    void syncExtBeat(uint32_t spb) { extSpb_ = spb; extBeatSeq_ = extBeatSeq_ + 1; }
    void syncExtStart()            { extEvt_ = 1; extEvtSeq_ = extEvtSeq_ + 1; }
    void syncExtContinue()         { extEvt_ = 2; extEvtSeq_ = extEvtSeq_ + 1; }
    void syncExtStop()             { extEvt_ = 3; extEvtSeq_ = extEvtSeq_ + 1; }

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
    void applySyncStaging();
    void startImmediateRecording();
    void startClick(uint32_t offset, bool accent);
    void mixClickInto(int16_t *data);
    void emitClickBlock();
    static bool clickEligible(uint8_t s)
    {
        // Clicks sound only while the looper isn't playing loop audio — once
        // the loop plays, the loop itself is the timing reference.
        return s == EMPTY || s == ARMED || s == COUNT_IN || s == RECORDING || s == STOPPED;
    }

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

    // musical sync (ISR side)
    LooperTiming timing_;
    uint32_t recStart_ = 0;      // sample offset an armed recording starts at, first block only
    uint8_t  cfgSeqSeen_ = 0, extBeatSeqSeen_ = 0, extEvtSeqSeen_ = 0;
    // metronome click synth: a short decaying square burst, no allocations
    uint32_t clickRemain_ = 0;   // samples left of the current click
    uint32_t clickStart_ = 0;    // offset in the current block where it begins
    uint32_t clickHalf_ = 0;     // half period (pitch), samples
    uint32_t clickPhase_ = 0;
    int32_t  clickAmp_ = 0;
    int32_t  clickSign_ = 1;
    static const uint32_t CLICK_LEN = 384;   // ~8.7 ms

    // shared with UI thread
    volatile uint8_t  isrPublic_ = EMPTY;   // raw ISR state (incl. DUB_FINALIZE/STOP_COMMIT)
    volatile uint32_t importLen_ = 0;
    volatile bool     busy_ = false;
    volatile uint8_t  pendingCmd = 0;
    volatile uint8_t  publicState = EMPTY;
    volatile uint32_t lengthSamples_ = 0;
    volatile uint32_t posSamples_ = 0;
    volatile bool     canUndo_ = false;

    // sync config staging (UI thread writes, ISR copies into the engine).
    // Each field is a single word, so the worst a mid-write ISR can see is one
    // block of a half-applied setting. Defaults mirror LooperTiming's.
    volatile uint8_t  cfgSeq_ = 0;
    volatile uint8_t  cfgMode_ = LooperTiming::MODE_OFF;
    volatile uint8_t  cfgSource_ = LooperTiming::SRC_INTERNAL;
    volatile uint32_t cfgSpb_ = 22050;             // 120 BPM
    volatile uint8_t  cfgCountIn_ = 1;
    volatile uint16_t cfgBars_ = 0;
    volatile uint8_t  cfgMet_ = LooperTiming::MET_REC;
    volatile uint16_t cfgMetVol_ = 154;            // ~0.6, read directly by the ISR
    // external clock events (main thread posts, ISR consumes)
    volatile uint8_t  extBeatSeq_ = 0;
    volatile uint32_t extSpb_ = 0;
    volatile uint8_t  extEvtSeq_ = 0;
    volatile uint8_t  extEvt_ = 0;                 // 1=start 2=continue 3=stop
    // engine state mirrors (ISR writes, UI reads)
    volatile uint8_t  syncPhase_ = 0;
    volatile uint8_t  syncBeat_ = 1;
    volatile uint32_t syncSpb_ = 22050;
};
