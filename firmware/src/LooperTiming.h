// LooperTiming — the musical timing engine behind synchronised looping.
//
// Portable C++ (no Arduino/Teensy includes) so the timing logic is unit tested
// on the host (firmware/test/host). The engine keeps a beat grid in the audio
// sample domain and is advanced once per audio block from the looper's
// update() (the audio ISR). Boundaries are reported as sample offsets *within*
// the current block, so the looper can start and stop recording with sample
// precision even though it only runs every AUDIO_BLOCK_SAMPLES samples.
//
// Two tempo sources:
//   - internal: a configured BPM. With no grid established, the first tap
//     defines the downbeat — the grid starts at the tap and the optional
//     count-in / fixed-bar schedule counts down in samples, sample exact.
//     With met "on" the metronome grid runs while idle, and an arm then rides
//     it: recording starts on the grid's next beat/bar and the click never
//     shifts.
//   - MIDI clock: the grid chases beat events fed in from the USB MIDI clock
//     follower (MidiClockIn). A tap with no clock running is REFUSED (the
//     player asked for sync; recording unsynchronised would be a surprise).
//     Between beats the grid free-runs at the last measured tempo (a
//     flywheel), so a clock that dies mid-recording cannot leave the pedal
//     recording forever: a fixed-length or scheduled stop completes on the
//     flywheel. A clock loss or MIDI Stop while merely armed or counting in
//     cancels the arm — nothing destructive can fire from a dead clock.
//
// The meter is x/4 only (beatsPerBar quarter notes per bar, default 4/4).
// All methods are called from ONE context (the audio ISR, or the test). The
// looper object owns the volatile handoff from UI/MIDI threads. No allocation,
// no floating point, no unbounded loops (advance() walks at most one block).

#pragma once

#include <stdint.h>

class LooperTiming {
public:
    enum Mode : uint8_t   { MODE_OFF = 0, MODE_BEAT, MODE_BAR };
    enum Source : uint8_t { SRC_INTERNAL = 0, SRC_MIDI };
    enum Met : uint8_t    { MET_OFF = 0, MET_REC, MET_ON };
    enum Phase : uint8_t  { PH_IDLE = 0, PH_COUNT_IN, PH_ARMED, PH_RECORDING, PH_CLOSING };
    enum Request : uint8_t {
        REQ_IMMEDIATE = 0,  // engine declines to schedule — caller acts right now (legacy path)
        REQ_ACCEPTED,       // scheduled; watch Action for the boundary
        REQ_IGNORED,        // request makes no sense in this phase — do nothing
        REQ_REFUSED         // sync was asked for but can't be honoured (no clock) — do nothing
    };

    // What happened inside the block just advanced over. Offsets are samples
    // from the start of the block; -1 = no event. Beats are always at least
    // one block apart (min ~8k samples per beat), so one of each suffices.
    struct Action {
        int32_t startRecordAt = -1;
        int32_t stopRecordAt  = -1;
        int32_t clickAt       = -1;
        bool    accent        = false;   // click marks a bar start
        bool    cancelled     = false;   // an armed/count-in phase was abandoned
    };

    // --- configuration (a change while armed/counting-in cancels the arm) ---
    void setMode(uint8_t m)      { if (m > MODE_BAR) return; if (m != mode_) { mode_ = m; abandon(); internalGridRun_ = false; } }
    void setSource(uint8_t s)    { if (s > SRC_MIDI) return; if (s != source_) { source_ = s; abandon(); internalGridRun_ = false; } }
    void setMetronome(uint8_t m) { if (m <= MET_ON) met_ = m; }
    void setBeatsPerBar(uint8_t b) { if (b >= 1 && b <= 12) beatsPerBar_ = b; }
    void setCountInBars(uint8_t b) { countInBars_ = b > 8 ? 8 : b; }
    void setRecordBars(uint16_t b) { recordBars_ = b > 64 ? 64 : b; }
    void setCapacity(uint32_t samples) { capacity_ = samples; }
    void setSamplesPerBeat(uint32_t s)
    {
        if (s < MIN_SPB || s > MAX_SPB) return;
        spb_ = s;
        if (toNextBeat_ > s) toNextBeat_ = s;   // tempo change on a live grid: the next
    }                                           //   beat is never more than a beat away

    uint8_t  mode() const        { return mode_; }
    uint8_t  source() const      { return source_; }
    uint8_t  metronome() const   { return met_; }
    uint8_t  beatsPerBar() const { return beatsPerBar_; }
    uint8_t  countInBars() const { return countInBars_; }
    uint16_t recordBars() const  { return recordBars_; }
    uint32_t samplesPerBeat() const { return spb_; }
    Phase    phase() const       { return (Phase)phase_; }
    bool     extRunning() const  { return extRun_; }
    // 1-based beat currently sounding (the last one fired).
    uint8_t currentBeat() const
    {
        return (uint8_t)((beatInBar_ + beatsPerBar_ - 1) % beatsPerBar_ + 1);
    }

    // --- external transport (from the MIDI clock follower) ---
    void extStart()
    {
        extRun_ = true;
        beatInBar_ = 0;             // first beat after a Start is a bar start
        holdGridForExtBeat();
    }
    void extContinue()
    {
        extRun_ = true;             // bar phase resumes where it stopped
        holdGridForExtBeat();
    }
    // MIDI Stop, or the clock went missing. Never destructive: an armed or
    // counting-in record is cancelled; a recording in progress finishes its
    // schedule on the flywheel; a playing loop is untouched.
    void extStop()
    {
        extRun_ = false;
        if (phase_ == PH_COUNT_IN || phase_ == PH_ARMED) abandon();
    }
    // A beat boundary arrived from the external clock (every 24th tick).
    // spb = current tempo estimate in samples per beat (0 = not yet known).
    void extBeat(uint32_t spb)
    {
        pendingExtBeat_ = true;
        if (spb >= MIN_SPB && spb <= MAX_SPB) pendingSpb_ = spb;
    }

    // --- requests from the looper's command handler ---

    // Tap LOOP on an empty looper.
    Request armRecord()
    {
        if (mode_ == MODE_OFF) return REQ_IMMEDIATE;
        if (phase_ != PH_IDLE) return REQ_IGNORED;
        if (source_ == SRC_MIDI) {
            // Sync was asked for and there is nothing to sync to: refuse the
            // tap rather than surprise the player with an unsynchronised take.
            if (!extRun_) return REQ_REFUSED;
            armOnGrid_ = true;
        } else {
            // Internal tempo: if the metronome grid is already going (met
            // "on"), keep it — arming must not shift the click — and start on
            // its next boundary. Otherwise the tap defines the downbeat.
            armOnGrid_ = internalGridRun_;
            if (!armOnGrid_) {
                beatInBar_ = 0;
                toNextBeat_ = 0;                  // a beat fires at offset 0 of this block
                sinceBeat_ = spb_;                //   (dedupe guard must not swallow it)
            }
        }
        if (countInBars_ > 0) {
            phase_ = PH_COUNT_IN;
            if (armOnGrid_) {
                ciWaitAlign_ = true;              // wait for a bar line, then count
                ciBeatsLeft_ = 0;
            } else {
                ciRemain_ = (uint32_t)countInBars_ * beatsPerBar_ * spb_;
            }
        } else {
            phase_ = PH_ARMED;
        }
        return REQ_ACCEPTED;
    }

    // Tap LOOP while recording: close the loop on the next beat/bar boundary.
    Request requestStopRecord()
    {
        if (phase_ == PH_CLOSING) return REQ_IGNORED;   // already scheduled
        if (phase_ != PH_RECORDING) return REQ_IMMEDIATE;
        phase_ = PH_CLOSING;
        stopOnBar_ = (mode_ == MODE_BAR);
        extStopBeats_ = 0;                        // a manual close overrides a fixed length
        if (source_ == SRC_INTERNAL) {
            uint32_t unit = stopOnBar_ ? spb_ * beatsPerBar_ : spb_;
            stopTarget_ = (recSamples_ / unit + 1) * unit;
            if (capacity_ && stopTarget_ > capacity_) stopTarget_ = capacity_;
        } else {
            stopTarget_ = 0;                      // stop on a beat event instead
        }
        return REQ_ACCEPTED;
    }

    // Tap STOP while armed / counting in: abandon the arm.
    void cancel() { abandon(); }

    // The looper closed or aborted the recording on its own (manual STOP,
    // buffer full): drop any schedule.
    void notifyClosed()
    {
        if (phase_ == PH_RECORDING || phase_ == PH_CLOSING) clearSchedule();
    }

    // Loop cleared.
    void reset()
    {
        if (phase_ == PH_COUNT_IN || phase_ == PH_ARMED) pendingCancel_ = true;
        clearSchedule();
    }

    // Advance the musical clock over one audio block of n samples.
    Action advance(uint32_t n)
    {
        Action a;
        if (pendingCancel_) { a.cancelled = true; pendingCancel_ = false; }
        if (mode_ == MODE_OFF) return a;

        // A beat from the external clock lands at the start of this block. If
        // the flywheel already fired it (the tick came a hair late) only
        // resync; otherwise fire it now.
        if (pendingExtBeat_) {
            pendingExtBeat_ = false;
            if (pendingSpb_) { spb_ = pendingSpb_; pendingSpb_ = 0; }
            toNextBeat_ = (sinceBeat_ < spb_ / 2) ? spb_ : 0;
        }

        int32_t startOff = -1, stopOff = -1;

        // The internal metronome grid: with met "on" it clicks while idle so
        // the player can settle into the tempo before arming; once running it
        // is never reset by an arm. It starts/stops as the setting changes.
        if (source_ == SRC_INTERNAL) {
            bool wantIdle = (met_ == MET_ON);
            if (wantIdle && !internalGridRun_) {
                internalGridRun_ = true;
                if (phase_ == PH_IDLE) {          // fresh grid: downbeat now
                    beatInBar_ = 0;
                    toNextBeat_ = 0;
                    sinceBeat_ = spb_;
                }
            } else if (!wantIdle && internalGridRun_ && phase_ == PH_IDLE) {
                internalGridRun_ = false;
            }
        }

        // Off-grid count-in (fresh internal downbeat): a pure sample countdown
        // (exactly bars*bpb*spb).
        if (phase_ == PH_COUNT_IN && !armOnGrid_) {
            if (ciRemain_ >= n) {
                ciRemain_ -= n;
            } else {
                startOff = (int32_t)ciRemain_;
                ciRemain_ = 0;
                beginRecording();
            }
        }

        // Walk the block, firing grid beats (clicks, external boundaries).
        if (gridRunning()) {
            uint32_t off = 0;
            while (off < n) {
                if (toNextBeat_ == 0) {
                    fireBeat(off, a, startOff, stopOff);
                    toNextBeat_ = spb_;
                    sinceBeat_ = 0;
                }
                uint32_t step = n - off;
                if (toNextBeat_ < step) step = toNextBeat_;
                toNextBeat_ -= step;
                sinceBeat_ += step;
                off += step;
            }
        }

        // Recording length accounting + internal sample-exact stops.
        if (phase_ == PH_RECORDING || phase_ == PH_CLOSING) {
            uint32_t from = (startOff >= 0) ? (uint32_t)startOff : 0;
            uint32_t add = n - from;
            if (source_ == SRC_INTERNAL && stopTarget_ && recSamples_ + add >= stopTarget_) {
                stopOff = (int32_t)(from + (stopTarget_ - recSamples_));
                recSamples_ = stopTarget_;
                clearSchedule();
            } else if (capacity_ && recSamples_ + add >= capacity_) {
                // Out of loop memory — the looper closes there anyway.
                stopOff = (int32_t)(from + (capacity_ - recSamples_));
                recSamples_ = capacity_;
                clearSchedule();
            } else if (stopOff >= 0) {
                // an external boundary closed the take inside fireBeat()
                recSamples_ += (uint32_t)stopOff - from;
            } else {
                recSamples_ += add;
            }
        }

        a.startRecordAt = startOff;
        a.stopRecordAt = stopOff;
        return a;
    }

private:
    // 6..600 BPM at 44.1 kHz — a sanity net, not the UI range.
    static const uint32_t MIN_SPB = 4410;
    static const uint32_t MAX_SPB = 441000;

    bool gridRunning() const
    {
        if (mode_ == MODE_OFF) return false;
        if (phase_ != PH_IDLE) return true;
        // idle: a live external clock, or the internal metronome grid (met "on")
        return source_ == SRC_MIDI ? extRun_ : internalGridRun_;
    }

    // After Start/Continue, free-run silently until the first tick's beat
    // arrives (it realigns the grid within one block).
    void holdGridForExtBeat()
    {
        toNextBeat_ = spb_;
        sinceBeat_ = spb_;
    }

    void abandon()
    {
        if (phase_ == PH_COUNT_IN || phase_ == PH_ARMED) {
            pendingCancel_ = true;
            phase_ = PH_IDLE;
            ciWaitAlign_ = false;
            ciBeatsLeft_ = 0;
            ciRemain_ = 0;
        }
    }

    void clearSchedule()
    {
        phase_ = PH_IDLE;
        stopTarget_ = 0;
        extStopBeats_ = 0;
        stopOnBar_ = false;
        recSamples_ = 0;
    }

    void beginRecording()
    {
        phase_ = PH_RECORDING;
        recSamples_ = 0;
        stopTarget_ = 0;
        extStopBeats_ = 0;
        stopOnBar_ = false;
        if (recordBars_ > 0) {
            if (source_ == SRC_INTERNAL) {
                stopTarget_ = (uint32_t)recordBars_ * beatsPerBar_ * spb_;
                if (capacity_ && stopTarget_ > capacity_) stopTarget_ = capacity_;
            } else {
                extStopBeats_ = (uint32_t)recordBars_ * beatsPerBar_;
            }
        }
    }

    void fireBeat(uint32_t off, Action &a, int32_t &startOff, int32_t &stopOff)
    {
        bool barStart = (beatInBar_ == 0);

        bool click;
        switch (phase_) {
        case PH_COUNT_IN:  click = true; break;                 // the count-in IS the click
        case PH_ARMED:     click = (met_ == MET_ON); break;
        case PH_RECORDING:
        case PH_CLOSING:   click = (met_ != MET_OFF); break;
        default:           click = (met_ == MET_ON); break;     // idle grid (external clock)
        }
        if (click && a.clickAt < 0) { a.clickAt = (int32_t)off; a.accent = barStart; }

        if (phase_ == PH_COUNT_IN && armOnGrid_) {
            // Counting on an established grid (external clock, or the internal
            // metronome already running): wait for a bar line, count bars*bpb
            // beats (the bar-line beat is count 1), then start the take.
            if (ciWaitAlign_) {
                if (barStart) {
                    ciWaitAlign_ = false;
                    ciBeatsLeft_ = (uint32_t)countInBars_ * beatsPerBar_ - 1;
                }
            } else if (ciBeatsLeft_ > 0) {
                ciBeatsLeft_--;
            } else {
                startOff = (int32_t)off;
                beginRecording();
            }
        } else if (phase_ == PH_ARMED) {
            // Off-grid (fresh internal downbeat): the first beat — reset at
            // the tap — starts the take. On a grid: honour the quantise mode.
            bool match = !armOnGrid_ || (mode_ == MODE_BEAT) || barStart;
            if (match) {
                startOff = (int32_t)off;
                beginRecording();
            }
        } else if (phase_ == PH_CLOSING && source_ == SRC_MIDI) {
            if ((!stopOnBar_ || barStart) && stopOff < 0) {
                stopOff = (int32_t)off;
                clearSchedule();
            }
        } else if (phase_ == PH_RECORDING && source_ == SRC_MIDI && extStopBeats_ > 0) {
            if (--extStopBeats_ == 0) {
                stopOff = (int32_t)off;
                clearSchedule();
            }
        }

        beatInBar_ = (uint8_t)((beatInBar_ + 1) % beatsPerBar_);
    }

    // config
    uint8_t  mode_ = MODE_OFF;
    uint8_t  source_ = SRC_INTERNAL;
    uint8_t  met_ = MET_REC;
    uint8_t  beatsPerBar_ = 4;
    uint8_t  countInBars_ = 1;
    uint16_t recordBars_ = 0;
    uint32_t spb_ = 22050;                 // 120 BPM at 44.1 kHz
    uint32_t capacity_ = 0;

    // grid
    uint8_t  phase_ = PH_IDLE;
    uint8_t  beatInBar_ = 0;               // beat number the NEXT fire will carry
    uint32_t toNextBeat_ = 0;              // samples until the next beat fires
    uint32_t sinceBeat_ = 0;
    bool     extRun_ = false;
    bool     internalGridRun_ = false;     // internal met-"on" grid is live (survives arms)
    bool     armOnGrid_ = false;           // current arm rides an established grid
    bool     pendingExtBeat_ = false;
    uint32_t pendingSpb_ = 0;
    bool     pendingCancel_ = false;

    // scheduling
    bool     ciWaitAlign_ = false;         // external count-in: waiting for a bar line
    uint32_t ciBeatsLeft_ = 0;             // external count-in: beats still to count
    uint32_t ciRemain_ = 0;                // internal count-in: samples to go
    uint32_t recSamples_ = 0;              // samples recorded so far
    uint32_t stopTarget_ = 0;              // internal: recorded-length target (0 = none)
    uint32_t extStopBeats_ = 0;            // external: beats until auto-stop (0 = none)
    bool     stopOnBar_ = false;           // scheduled manual stop lands on a bar
};
