// MidiClockIn — follows an incoming USB MIDI clock (24 PPQN) and turns it into
// beat events plus a smoothed tempo estimate for the looper's timing engine.
//
// Portable C++ (no Arduino includes) so it is unit tested on the host: all
// methods take the current time in microseconds as an argument. Call the
// on*() handlers from the USB MIDI poll loop and checkTimeout() every main
// loop pass. The pedal is a clock FOLLOWER only — it never sends MIDI clock.
//
// Per the MIDI spec, the first clock tick after a Start is the downbeat; a
// Continue resumes the tick count where it stopped (bar phase is kept by the
// timing engine). Ticks that arrive while stopped are ignored. Tempo is a
// smoothed (EMA, 1/8) tick interval, clamped to 10..1000 BPM so one garbled
// tick can't fling the tempo; it converges on a change within a couple of
// beats.

#pragma once

#include <stdint.h>

class MidiClockIn {
public:
    enum State : uint8_t {
        CLK_IDLE = 0,    // never seen a Start
        CLK_RUNNING,
        CLK_STOPPED,     // MIDI Stop received
        CLK_LOST         // ticks went missing while running
    };

    explicit MidiClockIn(uint32_t sampleRate = 44100) : sampleRate_(sampleRate) {}

    void onStart(uint32_t nowUs)
    {
        state_ = CLK_RUNNING;
        tickInBeat_ = 0;             // first tick after Start = downbeat
        haveLast_ = false;
        lastTickUs_ = nowUs;
    }

    void onContinue(uint32_t nowUs)
    {
        if (state_ == CLK_RUNNING) return;
        if (state_ == CLK_IDLE) { onStart(nowUs); return; }   // Continue without Start
        state_ = CLK_RUNNING;        // tick count resumes where it stopped
        haveLast_ = false;
        lastTickUs_ = nowUs;
    }

    void onStop()
    {
        if (state_ == CLK_RUNNING) state_ = CLK_STOPPED;
    }

    // A 0xF8 tick. Returns true when it lands on a beat (every 24th from Start).
    bool onTick(uint32_t nowUs)
    {
        if (state_ != CLK_RUNNING) return false;
        if (haveLast_) {
            uint32_t d = nowUs - lastTickUs_;
            if (d >= MIN_TICK_US && d <= MAX_TICK_US) {
                if (avgTickUs_ == 0) avgTickUs_ = d;
                else avgTickUs_ += ((int32_t)d - (int32_t)avgTickUs_) / 8;
            }
        }
        lastTickUs_ = nowUs;
        haveLast_ = true;
        bool beat = (tickInBeat_ == 0);
        tickInBeat_ = (uint8_t)((tickInBeat_ + 1) % 24);
        return beat;
    }

    // Call every main loop pass. Returns true exactly once when a running
    // clock goes missing (no tick for half a second).
    bool checkTimeout(uint32_t nowUs)
    {
        if (state_ != CLK_RUNNING) return false;
        if ((uint32_t)(nowUs - lastTickUs_) > TIMEOUT_US) {
            state_ = CLK_LOST;
            return true;
        }
        return false;
    }

    bool  running() const { return state_ == CLK_RUNNING; }
    State state() const   { return (State)state_; }

    // Smoothed tempo as audio samples per quarter note; 0 until measured.
    uint32_t samplesPerBeat() const
    {
        if (avgTickUs_ == 0) return 0;
        return (uint32_t)(((uint64_t)avgTickUs_ * 24u * sampleRate_) / 1000000u);
    }

    const char *stateName() const
    {
        switch (state_) {
        case CLK_RUNNING: return "running";
        case CLK_STOPPED: return "stopped";
        case CLK_LOST:    return "lost";
        default:          return "idle";
        }
    }

private:
    static const uint32_t TIMEOUT_US  = 500000;  // half a second without a tick = lost
    static const uint32_t MIN_TICK_US = 2500;    // ignore ticks implying > 1000 BPM
    static const uint32_t MAX_TICK_US = 250000;  // ...or < 10 BPM

    uint32_t sampleRate_;
    uint32_t avgTickUs_ = 0;
    uint32_t lastTickUs_ = 0;
    uint8_t  state_ = CLK_IDLE;
    uint8_t  tickInBeat_ = 0;
    bool     haveLast_ = false;
};
