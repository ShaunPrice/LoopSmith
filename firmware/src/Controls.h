// Controls — footswitch debounce/press/hold detection and status LEDs.
//
// Performance switches (LOOP, STOP, UNDO, BYPASS) fire on *press* so the pedal
// feels immediate; menu-ish switches (FX NEXT) distinguish tap from hold on
// release. STOP doubles as hold-to-clear.

#pragma once

#include <Arduino.h>
#include "config.h"
#include "AudioEffectLooper.h"

class Button {
public:
    void begin(uint8_t pin)
    {
        pin_ = pin;
        pinMode(pin, INPUT_PULLUP);
        stable_ = raw_ = digitalRead(pin);
        lastChange_ = millis();
    }

    void poll(uint32_t now)
    {
        pressed_ = tapped_ = held_ = released_ = false;
        int r = digitalRead(pin_);
        if (r != raw_) {
            raw_ = r;
            lastChange_ = now;
        }
        if ((now - lastChange_) >= BUTTON_DEBOUNCE_MS && r != stable_) {
            stable_ = r;
            if (stable_ == LOW) {                 // press
                pressed_ = true;
                pressTime_ = now;
                holdFired_ = false;
            } else {                              // release
                released_ = true;
                if (!holdFired_ && (now - pressTime_) < holdMs_) tapped_ = true;
            }
        }
        if (stable_ == LOW && !holdFired_ && (now - pressTime_) >= holdMs_) {
            holdFired_ = true;
            held_ = true;
        }
    }

    void setHoldMs(uint32_t ms) { holdMs_ = ms; }
    bool pressed() const  { return pressed_; }    // debounced press edge
    bool tapped() const   { return tapped_; }     // released before hold
    bool held() const     { return held_; }       // hold threshold crossed (once)
    bool released() const { return released_; }   // any release edge
    bool down() const     { return stable_ == LOW; }

private:
    uint8_t  pin_ = 0;
    int      raw_ = HIGH, stable_ = HIGH;
    uint32_t lastChange_ = 0, pressTime_ = 0;
    uint32_t holdMs_ = BUTTON_HOLD_MS;
    bool     pressed_ = false, tapped_ = false, held_ = false, released_ = false, holdFired_ = false;
};

struct SwitchEvents {
    bool pressed[6];    // debounced press edge
    bool tapped[6];     // released before the hold threshold
    bool held[6];       // hold threshold crossed
    bool released[6];   // any release edge
};

class Controls {
public:
    void begin()
    {
        const uint8_t pins[6] = {PIN_FS_LOOP, PIN_FS_STOP, PIN_FS_UNDO, PIN_FS_FX_NEXT, PIN_FS_FX_PREV, PIN_FS_FX_BYPASS};
        for (int i = 0; i < 6; i++) { sw_[i].begin(pins[i]); sw_[i].setHoldMs(LOOPER_HOLD_CLEAR_MS); }
        pinMode(PIN_LED_REC, OUTPUT);
        pinMode(PIN_LED_PLAY, OUTPUT);
    }

    SwitchEvents poll()
    {
        uint32_t now = millis();
        SwitchEvents e;
        for (int i = 0; i < 6; i++) {
            sw_[i].poll(now);
            e.pressed[i]  = sw_[i].pressed();
            e.tapped[i]   = sw_[i].tapped();
            e.held[i]     = sw_[i].held();
            e.released[i] = sw_[i].released();
        }
        return e;
    }

    void updateLeds(AudioEffectLooper::State s, bool hasLoop)
    {
        uint32_t now = millis();
        bool fast = (now / 125) & 1;    // 4 Hz blink
        bool slow = (now / 500) & 1;    // 1 Hz blink

        bool rec = false, play = false;
        switch (s) {
        case AudioEffectLooper::RECORDING:   rec = true; break;
        case AudioEffectLooper::OVERDUBBING: rec = fast; play = true; break;
        case AudioEffectLooper::PLAYING:     play = true; break;
        case AudioEffectLooper::STOPPED:     play = hasLoop && slow; break;
        default: break;
        }
        // Heartbeat: with no loop the panel would be dark, and the Teensy's own LED is
        // no use as a running light - pin 13 is SPI SCK to the audio shield's flash, so it
        // only flickers with flash traffic (the one flash at boot is the preset mirror).
        // A short green blink every two seconds says the pedal is alive and idle.
        if (s == AudioEffectLooper::STOPPED && !hasLoop) play = (now % 2000) < 40;
        digitalWrite(PIN_LED_REC, rec ? HIGH : LOW);
        digitalWrite(PIN_LED_PLAY, play ? HIGH : LOW);
    }

private:
    Button sw_[6];
};
