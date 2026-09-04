// LoopFiles — save / load the loop as 16-bit mono 44.1 kHz WAV in /loops on the
// SD card, and stream files for the protocol's `loop get` / `loop put`.
#pragma once
#include <Arduino.h>
#include <SD.h>
#include <vector>
#include "AudioEffectLooper.h"

namespace LoopFiles {
    static const char *DIR = "/loops";
    bool validName(const String &n);                       // plain *.wav, no spaces/paths
    String normalizeName(const String &n);                 // appends .wav when missing
    void list(std::vector<String> &names);
    bool save(const String &name, AudioEffectLooper &lp, String &err);
    bool load(const String &name, AudioEffectLooper &lp, String &err);
    bool remove(const String &name, String &err);
    String path(const String &name);
}
