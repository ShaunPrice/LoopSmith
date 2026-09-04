#include "PresetStore.h"

static bool isPresetName(const String &n)
{
    if (!n.endsWith(".txt") && !n.endsWith(".TXT")) return false;
    if (n.startsWith(".")) return false;             // macOS ._ metadata files
    if (n.indexOf(' ') != -1) return false;          // unaddressable over the protocol
    return true;
}

void PresetStore::begin()
{
    pinMode(PIN_SHIELD_SD_CS, OUTPUT);
    digitalWrite(PIN_SHIELD_SD_CS, HIGH);            // keep the shield SD socket quiet

    sdOk_ = SD.begin(BUILTIN_SDCARD);

    flashOk_ = flashFs_.begin(PIN_SHIELD_FLASH_CS);
    if (!flashOk_) {
        // first use: format the W25Q32 for LittleFS
        if (flashFs_.quickFormat()) {
            flashOk_ = flashFs_.begin(PIN_SHIELD_FLASH_CS);
        }
    }

    if (sdOk_ && flashOk_) mirrorToFlash();
    rescan();
}

bool PresetStore::sdUsable()
{
    return sdOk_ && SD.mediaPresent();   // survives mid-session card removal
}

void PresetStore::poll()
{
    if (sdOk_ || millis() - lastSdTry_ < 4000) return;
    lastSdTry_ = millis();
    if (SD.begin(BUILTIN_SDCARD)) {
        sdOk_ = true;
        Serial.println("SD card inserted - mounted");
        if (flashOk_) mirrorToFlash();
        rescan();
    }
}

FS *PresetStore::activeFS()
{
    if (sdUsable()) return &SD;
    if (flashOk_) return &flashFs_;
    return nullptr;
}

void PresetStore::rescan()
{
    names_.clear();
    FS *fs = activeFS();
    if (!fs) return;

    File dir = fs->open(PRESET_DIR);
    if (!dir || !dir.isDirectory()) return;
    while (true) {
        File f = dir.openNextFile();
        if (!f) break;
        if (!f.isDirectory()) {
            String n = f.name();
            if (isPresetName(n)) names_.push_back(n);
        }
        f.close();
    }
    dir.close();

    // case-insensitive sort so 01_, 02_, ... order holds
    for (size_t i = 1; i < names_.size(); i++) {
        String key = names_[i];
        size_t j = i;
        while (j > 0) {
            String a = names_[j - 1], b = key;
            a.toLowerCase();
            b.toLowerCase();
            if (a.compareTo(b) <= 0) break;
            names_[j] = names_[j - 1];
            j--;
        }
        names_[j] = key;
    }
}

bool PresetStore::readFile(FS &fs, const String &path, char **data, size_t *len)
{
    File f = fs.open(path.c_str(), FILE_READ);
    if (!f) return false;
    size_t n = f.size();
    if (n == 0 || n > PRESET_MAX_BYTES) { f.close(); return false; }
    char *buf = (char *)malloc(n + 1);
    if (!buf) { f.close(); return false; }
    size_t got = f.read((uint8_t *)buf, n);
    f.close();
    if (got != n) { free(buf); return false; }
    buf[n] = 0;
    *data = buf;
    *len = n;
    return true;
}

bool PresetStore::writeFile(FS &fs, const String &path, const char *data, size_t len)
{
    fs.remove(path.c_str());                          // FILE_WRITE appends; start clean
    File f = fs.open(path.c_str(), FILE_WRITE);
    if (!f) return false;
    size_t put = f.write((const uint8_t *)data, len);
    f.close();
    return put == len;
}

bool PresetStore::readPreset(const String &name, char **data, size_t *len)
{
    FS *fs = activeFS();
    if (!fs) return false;
    return readFile(*fs, String(PRESET_DIR) + "/" + name, data, len);
}

bool PresetStore::readSettings(char **data, size_t *len)
{
    FS *fs = activeFS();
    if (!fs) return false;
    return readFile(*fs, SETTINGS_FILE, data, len);
}

bool PresetStore::writePreset(const String &name, const char *data, size_t len, String &err)
{
    if (!isPresetName(name) || name.indexOf('/') != -1 || name.indexOf('\\') != -1 ||
        name.indexOf(' ') != -1) {
        err = "preset names must be plain *.txt files without spaces";
        return false;
    }
    if (len == 0 || len > PRESET_MAX_BYTES) {
        err = "preset size out of range";
        return false;
    }
    // When an SD card is in, it is the master copy: an SD failure is an error
    // even if the flash mirror succeeded (otherwise the write would silently
    // diverge from the store presets are listed from). Cardless, the flash
    // mirror is the store and a flash write alone counts.
    String path = String(PRESET_DIR) + "/" + name;
    bool ok;
    if (sdUsable()) {
        SD.mkdir(PRESET_DIR);
        ok = writeFile(SD, path, data, len);
        if (!ok) err = "SD write failed";
        else if (flashOk_) {                 // mirror, best-effort
            flashFs_.mkdir(PRESET_DIR);
            writeFile(flashFs_, path, data, len);
        }
    } else if (flashOk_) {
        flashFs_.mkdir(PRESET_DIR);
        ok = writeFile(flashFs_, path, data, len);
        if (!ok) err = "flash write failed";
    } else {
        err = "no storage available";
        ok = false;
    }
    if (ok) rescan();
    return ok;
}

bool PresetStore::removePreset(const String &name, String &err)
{
    if (name.indexOf('/') != -1 || name.indexOf('\\') != -1) {
        err = "bad name";
        return false;
    }
    String path = String(PRESET_DIR) + "/" + name;
    bool any = false;
    if (sdUsable() && SD.remove(path.c_str())) any = true;
    if (flashOk_ && flashFs_.remove(path.c_str())) any = true;
    if (any) rescan();
    else err = "not found";
    return any;
}

// Copy presets (and settings.txt) from SD onto the flash mirror. Files are
// copied when missing or when the size differs. The mirror is deliberately
// NEVER pruned: a preset uploaded over USB while no card was in must not be
// deleted by the next boot-with-card (stale flash-only files linger instead —
// the safe failure mode — and `rm` removes from both stores).
void PresetStore::mirrorToFlash()
{
    flashFs_.mkdir(PRESET_DIR);

    // FAT is case-insensitive, LittleFS is not: index the mirror's names once
    // so a re-cased SD file replaces its old spelling instead of duplicating.
    std::vector<String> flashNames;
    File fdir = flashFs_.open(PRESET_DIR);
    if (fdir && fdir.isDirectory()) {
        while (true) {
            File f = fdir.openNextFile();
            if (!f) break;
            if (!f.isDirectory()) flashNames.push_back(String(f.name()));
            f.close();
        }
        fdir.close();
    }

    // SD -> flash
    File dir = SD.open(PRESET_DIR);
    if (dir && dir.isDirectory()) {
        while (true) {
            File f = dir.openNextFile();
            if (!f) break;
            String n = f.name();
            if (!f.isDirectory() && isPresetName(n) && f.size() <= PRESET_MAX_BYTES) {
                for (auto &fn : flashNames) {
                    if (fn.equalsIgnoreCase(n) && !fn.equals(n)) {
                        flashFs_.remove((String(PRESET_DIR) + "/" + fn).c_str());
                    }
                }
                String path = String(PRESET_DIR) + "/" + n;
                File m = flashFs_.open(path.c_str(), FILE_READ);
                bool same = m && (size_t)m.size() == (size_t)f.size();
                if (m) m.close();
                if (!same) {
                    char *buf = (char *)malloc(f.size());
                    if (buf && f.read((uint8_t *)buf, f.size()) == (size_t)f.size()) {
                        writeFile(flashFs_, path, buf, f.size());
                    }
                    free(buf);
                }
            }
            f.close();
        }
        dir.close();
    }

    // settings.txt
    File s = SD.open(SETTINGS_FILE, FILE_READ);
    if (s) {
        size_t n = s.size();
        if (n > 0 && n <= PRESET_MAX_BYTES) {
            char *buf = (char *)malloc(n);
            if (buf && s.read((uint8_t *)buf, n) == n) {
                File m = flashFs_.open(SETTINGS_FILE, FILE_READ);
                bool same = m && (size_t)m.size() == n;
                if (m) m.close();
                if (!same) writeFile(flashFs_, SETTINGS_FILE, buf, n);
            }
            free(buf);
        }
        s.close();
    }
}
