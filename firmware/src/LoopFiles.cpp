#include "LoopFiles.h"

namespace LoopFiles {

static const size_t CHUNK = 8192;

String path(const String &name) { return String(DIR) + "/" + name; }

String normalizeName(const String &n)
{
    return (n.endsWith(".wav") || n.endsWith(".WAV")) ? n : n + ".wav";
}

bool validName(const String &n)
{
    if (!(n.endsWith(".wav") || n.endsWith(".WAV"))) return false;
    if (n.length() < 5 || n.startsWith(".")) return false;
    if (n.indexOf('/') != -1 || n.indexOf('\\') != -1 || n.indexOf(' ') != -1) return false;
    if (n.length() > 64 || n.indexOf('"') != -1) return false;   // must survive the #LOOPS listing
    return true;
}

void list(std::vector<String> &names)
{
    names.clear();
    File dir = SD.open(DIR);
    if (!dir || !dir.isDirectory()) return;
    while (true) {
        File f = dir.openNextFile();
        if (!f) break;
        String n = f.name();
        if (!f.isDirectory() && validName(n)) names.push_back(n);
        f.close();
    }
    dir.close();
    for (size_t i = 1; i < names.size(); i++) {           // case-insensitive sort
        String key = names[i]; size_t j = i;
        while (j > 0) {
            String a = names[j - 1], b = key; a.toLowerCase(); b.toLowerCase();
            if (a.compareTo(b) <= 0) break;
            names[j] = names[j - 1]; j--;
        }
        names[j] = key;
    }
}

static void put32(uint8_t *p, uint32_t v) { p[0] = v; p[1] = v >> 8; p[2] = v >> 16; p[3] = v >> 24; }
static void put16(uint8_t *p, uint16_t v) { p[0] = v; p[1] = v >> 8; }
static uint32_t get32(const uint8_t *p) { return p[0] | (p[1] << 8) | (p[2] << 16) | ((uint32_t)p[3] << 24); }
static uint16_t get16(const uint8_t *p) { return p[0] | (p[1] << 8); }

bool save(const String &nameIn, AudioEffectLooper &lp, String &err)
{
    String name = normalizeName(nameIn);
    if (!validName(name)) { err = "loop names must be plain *.wav files without spaces"; return false; }
    if (!lp.enabled()) { err = "looper disabled (no PSRAM)"; return false; }

    // Freeze the looper's command stream first, give the ISR a block to settle,
    // then take the snapshot — no buffer swap can start underneath the copy.
    lp.setBusy(true);
    delay(6);
    uint32_t len = 0;
    const int16_t *data = lp.exportData(len);
    if (!data || len == 0) {
        lp.setBusy(false);
        err = "nothing to save yet (loop empty, recording, or still committing an overdub)";
        return false;
    }

    SD.mkdir(DIR);
    String p = path(name);
    String tmp = String(DIR) + "/.save.tmp";
    SD.remove(tmp.c_str());
    File f = SD.open(tmp.c_str(), FILE_WRITE);
    if (!f) { lp.setBusy(false); err = "cannot create " + name; return false; }

    uint8_t h[44];
    memcpy(h, "RIFF", 4); put32(h + 4, 36 + len * 2); memcpy(h + 8, "WAVE", 4);
    memcpy(h + 12, "fmt ", 4); put32(h + 16, 16); put16(h + 20, 1); put16(h + 22, 1);
    put32(h + 24, 44100); put32(h + 28, 44100 * 2); put16(h + 32, 2); put16(h + 34, 16);
    memcpy(h + 36, "data", 4); put32(h + 40, len * 2);
    bool ok = f.write(h, 44) == 44;

    // copy through RAM in chunks — the SD driver's DMA is happiest with RAM buffers
    uint8_t *buf = (uint8_t *)malloc(CHUNK);
    if (!buf) { f.close(); lp.setBusy(false); err = "out of memory"; return false; }
    uint32_t done = 0;
    while (ok && done < len) {
        uint32_t n = len - done; if (n > CHUNK / 2) n = CHUNK / 2;
        memcpy(buf, data + done, n * 2);
        ok = f.write(buf, n * 2) == n * 2;
        done += n;
    }
    lp.setBusy(false);
    free(buf);
    f.close();
    if (!ok) { SD.remove(tmp.c_str()); err = "SD write failed"; return false; }
    SD.remove(p.c_str());                          // replace the old file only now
    if (!SD.rename(tmp.c_str(), p.c_str())) { SD.remove(tmp.c_str()); err = "SD rename failed"; return false; }
    return true;
}

bool load(const String &nameIn, AudioEffectLooper &lp, String &err)
{
    String name = normalizeName(nameIn);
    if (!validName(name)) { err = "bad loop name"; return false; }
    if (!lp.enabled()) { err = "looper disabled (no PSRAM)"; return false; }
    File f = SD.open(path(name).c_str(), FILE_READ);
    if (!f) { err = "not found"; return false; }

    // ---- parse RIFF/WAVE: fmt + data chunks ----
    uint8_t h[12];
    if (f.read(h, 12) != 12 || memcmp(h, "RIFF", 4) || memcmp(h + 8, "WAVE", 4)) { f.close(); err = "not a WAV file"; return false; }
    uint16_t channels = 0, bits = 0, fmt = 0; uint32_t rate = 0, dataSize = 0;
    bool haveFmt = false, haveData = false;
    while (!haveData) {
        uint8_t ch[8];
        if (f.read(ch, 8) != 8) break;
        uint32_t size = get32(ch + 4);
        if (!memcmp(ch, "fmt ", 4)) {
            uint8_t fm[16];
            if (size < 16 || f.read(fm, 16) != 16) break;
            fmt = get16(fm); channels = get16(fm + 2); rate = get32(fm + 4); bits = get16(fm + 14);
            if (size > 16) f.seek(f.position() + (size - 16) + (size & 1));
            haveFmt = true;
        } else if (!memcmp(ch, "data", 4)) {
            dataSize = size; haveData = true;
        } else {
            f.seek(f.position() + size + (size & 1));
        }
    }
    if (!haveFmt || !haveData) { f.close(); err = "malformed WAV (no fmt/data)"; return false; }
    if (fmt != 1 || bits != 16 || (channels != 1 && channels != 2)) {
        f.close(); err = "need 16-bit PCM, mono or stereo"; return false;
    }
    if (rate != 44100) { f.close(); err = "need 44100 Hz (got " + String(rate) + ")"; return false; }

    uint32_t frames = dataSize / (2 * channels);
    uint32_t avail = (f.size() > f.position()) ? (f.size() - f.position()) / (2 * channels) : 0;
    if (frames > avail) frames = avail;            // streaming/truncated WAVs lie in the header
    if (frames > lp.capacitySamples()) frames = lp.capacitySamples();
    if (frames < 4410) { f.close(); err = "loop too short (min 0.1 s)"; return false; }

    // Everything that can fail has been checked; only now touch the looper.
    uint8_t *buf = (uint8_t *)malloc(CHUNK);
    if (!buf) { f.close(); err = "out of memory"; return false; }
    lp.clearLoop();
    uint32_t t0 = millis();
    while ((lp.hasLoop() || lp.state() != AudioEffectLooper::EMPTY) && millis() - t0 < 300) delay(1);
    delay(10);
    int16_t *dst = lp.importBuffer();
    if (!dst) { free(buf); f.close(); err = "looper busy"; return false; }
    lp.setBusy(true);
    uint32_t done = 0; bool ok = true;
    while (done < frames) {
        uint32_t want = frames - done;
        uint32_t maxFrames = CHUNK / (2 * channels);
        if (want > maxFrames) want = maxFrames;
        size_t bytes = want * 2 * channels;
        if ((size_t)f.read(buf, bytes) != bytes) { ok = false; break; }
        const int16_t *s = (const int16_t *)buf;
        if (channels == 1) {
            memcpy(dst + done, s, bytes);
        } else {
            for (uint32_t i = 0; i < want; i++) dst[done + i] = (int16_t)(((int32_t)s[2 * i] + s[2 * i + 1]) / 2);
        }
        done += want;
    }
    lp.setBusy(false);
    free(buf);
    f.close();
    if (done < 4410) { err = "SD read failed"; return false; }
    if (!ok) err = "short read - loaded what was there";   // informational, still commits
    lp.importCommit(done);
    return true;
}

bool remove(const String &nameIn, String &err)
{
    String name = normalizeName(nameIn);
    if (!validName(name)) { err = "bad loop name"; return false; }
    if (!SD.remove(path(name).c_str())) { err = "not found"; return false; }
    return true;
}

} // namespace LoopFiles
