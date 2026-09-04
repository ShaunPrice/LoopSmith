// PresetStore — presets live on the SD card and are mirrored to the audio
// shield's W25Q32 SPI flash (LittleFS) at boot, so the pedal keeps working with
// no card inserted. Reads prefer SD when present; writes go to both.

#pragma once

#include <Arduino.h>
#include <SD.h>
#include <LittleFS.h>
#include <vector>
#include "config.h"

class PresetStore {
public:
    void begin();                    // mounts SD + flash, mirrors presets
    bool sdPresent() const    { return sdOk_; }
    bool flashPresent() const { return flashOk_; }

    // sorted preset filenames (no directory prefix)
    const std::vector<String> &presets() const { return names_; }
    void rescan();
    bool sdUsable();                 // card present right now
    void poll();                     // hot-plug: mounts a card inserted after boot

    // Read a preset into a heap buffer (caller frees). false if missing/too big.
    bool readPreset(const String &name, char **data, size_t *len);
    bool readSettings(char **data, size_t *len);

    // Write to SD (if present) and the flash mirror. Rescans afterwards.
    bool writePreset(const String &name, const char *data, size_t len, String &err);
    bool removePreset(const String &name, String &err);

private:
    FS  *activeFS();
    bool readFile(FS &fs, const String &path, char **data, size_t *len);
    bool writeFile(FS &fs, const String &path, const char *data, size_t len);
    void mirrorToFlash();

    LittleFS_SPIFlash flashFs_;
    bool sdOk_ = false;
    uint32_t lastSdTry_ = 0;
    bool flashOk_ = false;
    std::vector<String> names_;
};
