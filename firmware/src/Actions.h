// Actions — what a footswitch can do. Configurable per switch (tap + hold),
// persisted in EEPROM, edited from the Studio dashboard (`switches` / `switch`).
#pragma once
#include <Arduino.h>

enum SwitchAction : uint8_t {
    ACT_NONE = 0, ACT_LOOP, ACT_STOP, ACT_UNDO, ACT_CLEAR, ACT_NEXT, ACT_PREV,
    ACT_RELOAD, ACT_BYPASS, ACT_SOURCE, ACT_NOTE, ACT_COUNT
};

static const char *const ACTION_NAMES[ACT_COUNT] = {
    "none", "loop", "stop", "undo", "clear", "next", "prev", "reload", "bypass", "source", "note"
};

inline int actionFromName(const String &n)
{
    for (int i = 0; i < ACT_COUNT; i++) if (n.equalsIgnoreCase(ACTION_NAMES[i])) return i;
    return -1;
}

struct SwitchConfig {
    uint8_t tap;    // SwitchAction on press/tap
    uint8_t hold;   // SwitchAction after the hold threshold (ACT_NONE = no hold)
    uint8_t note;   // MIDI note for ACT_NOTE (channel 10)
};

static const int NUM_SWITCHES = 6;
