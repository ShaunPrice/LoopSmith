#include "SerialProtocol.h"
#include "config.h"
#include "LoopFiles.h"
#include <Audio.h>

extern "C" uint8_t external_psram_size;

void SerialProtocol::jsonEscapeInto(String &out, const String &s)
{
    const unsigned int MAXLEN = 96;   // keeps #STATUS inside its buffer
    for (unsigned int i = 0; i < s.length() && i < MAXLEN; i++) {
        char c = s[i];
        if (c == '"' || c == '\\') out += '_';
        else if ((uint8_t)c >= 0x20) out += c;
    }
}

void SerialProtocol::poll()
{
    while (Serial.available()) {
        char c = (char)Serial.read();
        if (c == '\r') continue;
        if (c == '\n') {
            if (discarding_) {          // end of an overlong line: swallow it whole
                discarding_ = false;
                lineLen_ = 0;
                continue;
            }
            line_[lineLen_] = 0;
            lineLen_ = 0;
            handleLine(line_);
        } else if (discarding_) {
            // eat the rest of the oversized line
        } else if (lineLen_ < sizeof(line_) - 1) {
            line_[lineLen_++] = c;
        } else {
            discarding_ = true;
            lineLen_ = 0;
            Serial.println("#ERR line too long");
        }
    }

    emitEventsIfChanged();

    if (monitor_ && millis() - lastMonitor_ >= 250) {
        lastMonitor_ = millis();
        emitStatus();
    }
}

bool SerialProtocol::receiveCounted(char **data, size_t len)
{
    char *buf = (char *)malloc(len + 1);
    if (!buf) {
        Serial.println("#ERR out of memory");
        return false;
    }
    Serial.println("#SEND");
    size_t got = 0;
    uint32_t deadline = millis() + 5000;
    while (got < len && (int32_t)(deadline - millis()) > 0) {
        pedal_->patch.pollTone();   // the test tone must stop on time even mid-transfer
        int avail = Serial.available();
        if (avail > 0) {
            size_t want = len - got;
            if ((size_t)avail < want) want = avail;
            got += Serial.readBytes(buf + got, want);
        }
    }
    if (got != len) {
        free(buf);
        Serial.println("#ERR timeout");
        return false;
    }
    buf[len] = 0;
    *data = buf;
    return true;
}

// Write all of `n` bytes, retrying through host stalls (the USB CDC driver
// returns short after a 120 ms TX timeout). Gives up after `deadlineMs`.
static bool writeAll(const uint8_t *buf, size_t n, uint32_t deadlineMs)
{
    size_t off = 0;
    uint32_t t0 = millis();
    while (off < n) {
        size_t w = Serial.write(buf + off, n - off);
        off += w;
        if (off < n) {
            if (millis() - t0 > deadlineMs) return false;
            delay(1);
        }
    }
    return true;
}

void SerialProtocol::emitPong()
{
    Serial.printf("#PONG {\"fw\":\"%s\",\"proto\":%d,\"psram_mb\":%u,\"sd\":%s,\"flash\":%s}\n",
                  FIRMWARE_VERSION, PROTOCOL_VERSION, (unsigned)external_psram_size,
                  pedal_->store.sdPresent() ? "true" : "false",
                  pedal_->store.flashPresent() ? "true" : "false");
}

void SerialProtocol::emitPresets()
{
    String out = "#PRESETS {\"current\":";
    out += String(pedal_->presetIndex);
    out += ",\"presets\":[";
    const auto &names = pedal_->store.presets();
    for (size_t i = 0; i < names.size(); i++) {
        if (i) out += ',';
        out += '"';
        jsonEscapeInto(out, names[i]);
        out += '"';
    }
    out += "]}";
    Serial.println(out);
}

void SerialProtocol::emitStatus()
{
    AudioEffectLooper &lp = pedal_->patch.looper;

    String name, title;
    jsonEscapeInto(name, pedal_->presetName());
    jsonEscapeInto(title, pedal_->patch.patchTitle());

    char buf[896];
    snprintf(buf, sizeof(buf),
        "#STATUS {\"cpu\":%.1f,\"cpu_max\":%.1f,\"mem\":%d,\"mem_max\":%d,"
        "\"peak_in\":%.3f,\"peak_out\":%.3f,"
        "\"loop\":{\"state\":\"%s\",\"len_s\":%.2f,\"pos_s\":%.2f,\"can_undo\":%s,\"seconds_max\":%.1f},"
        "\"preset\":{\"index\":%d,\"count\":%d,\"name\":\"%s\",\"title\":\"%s\"},"
        "\"bypass\":%s,\"volume\":%.2f,\"source\":\"%s\",\"psram_mb\":%u,\"sd\":%s,\"flash\":%s,"
        "\"rev\":%lu,\"fp\":\"%s\",\"tone\":%s,\"midi\":{\"rx\":%lu,\"trig\":%lu,\"voices\":%d}}",
        AudioProcessorUsage(), AudioProcessorUsageMax(),
        AudioMemoryUsage(), AudioMemoryUsageMax(),
        pedal_->patch.peakIn(), pedal_->patch.peakOut(),
        lp.stateName(), lp.lengthSeconds(), lp.positionSeconds(),
        lp.canUndo() ? "true" : "false", lp.maxSeconds(),
        pedal_->presetIndex, (int)pedal_->store.presets().size(),
        name.c_str(), title.c_str(),
        pedal_->patch.bypassed() ? "true" : "false",
        pedal_->patch.volume(), pedal_->patch.usbSource() ? "usb" : "line",
        (unsigned)external_psram_size,
        pedal_->store.sdPresent() ? "true" : "false",
        pedal_->store.flashPresent() ? "true" : "false",
        (unsigned long)pedal_->patch.patchRev(),
        pedal_->patch.patchFp().c_str(),
        pedal_->patch.toneActive() ? "true" : "false",
        (unsigned long)pedal_->midiRxNotes,
        (unsigned long)pedal_->patch.noteTriggers(),
        pedal_->patch.voiceCount());
    Serial.println(buf);
}

void SerialProtocol::emitEventsIfChanged()
{
    String s = pedal_->patch.looper.stateName();
    if (s != lastLoopState_) {
        lastLoopState_ = s;
        Serial.printf("#EVT {\"loop\":\"%s\"}\n", s.c_str());
    }
    String p = pedal_->presetName();
    if (p != lastPreset_) {
        lastPreset_ = p;
        String esc;
        jsonEscapeInto(esc, p);
        Serial.printf("#EVT {\"preset\":\"%s\"}\n", esc.c_str());
    }
    int b = pedal_->patch.bypassed() ? 1 : 0;
    if (b != lastBypass_) {
        lastBypass_ = b;
        Serial.printf("#EVT {\"bypass\":%s}\n", b ? "true" : "false");
    }
    int t = pedal_->patch.toneActive() ? 1 : 0;
    if (t != lastTone_) {
        lastTone_ = t;
        Serial.printf("#EVT {\"tone\":%s}\n", t ? "true" : "false");
    }
}

void SerialProtocol::handleLine(char *line)
{
    // split into up to 5 tokens
    char *argv[5] = {nullptr, nullptr, nullptr, nullptr, nullptr};
    int argc = 0;
    for (char *p = line; *p && argc < 5;) {
        while (*p == ' ') *p++ = 0;
        if (!*p) break;
        argv[argc++] = p;
        // the last token may contain spaces only for filenames we disallow anyway
        while (*p && *p != ' ') p++;
    }
    if (argc == 0) return;
    String cmd = argv[0];
    // End diagnostics before operations that may block on media or transfers.
    if (cmd == "get" || cmd == "put" || cmd == "apply" || cmd == "loop" ||
        cmd == "load" || cmd == "next" || cmd == "prev" || cmd == "rm" || cmd == "list")
        pedal_->patch.toneStop();

    if (cmd == "ping")   { emitPong(); return; }
    if (cmd == "status") { emitStatus(); return; }
    if (cmd == "list")   { emitPresets(); return; }

    if (cmd == "monitor") {
        monitor_ = (argc > 1 && String(argv[1]) == "on");
        Serial.println("#OK monitor");
        return;
    }

    if (cmd == "load") {
        if (argc < 2) { Serial.println("#ERR load needs an index or name"); return; }
        String err, arg = argv[1];
        bool isNum = true;
        for (unsigned int i = 0; i < arg.length(); i++)
            if (!isdigit((unsigned char)arg[i])) { isNum = false; break; }
        bool ok = isNum ? pedal_->loadPresetByIndex(arg.toInt(), err)
                        : pedal_->loadPresetByName(arg, err);
        if (ok) Serial.printf("#OK load %s rev=%lu fp=%s\n", pedal_->presetName().c_str(),
                              (unsigned long)pedal_->patch.patchRev(),
                              pedal_->patch.patchFp().c_str());
        else    Serial.printf("#ERR %s\n", err.c_str());
        return;
    }

    if (cmd == "next" || cmd == "prev") {
        String err;
        if (pedal_->stepPreset(cmd == "next" ? +1 : -1, err))
            Serial.printf("#OK load %s rev=%lu fp=%s\n", pedal_->presetName().c_str(),
                          (unsigned long)pedal_->patch.patchRev(),
                          pedal_->patch.patchFp().c_str());
        else
            Serial.printf("#ERR %s\n", err.c_str());
        return;
    }

    if (cmd == "get") {
        if (argc < 2) { Serial.println("#ERR get needs a name"); return; }
        char *data; size_t len;
        if (!pedal_->store.readPreset(argv[1], &data, &len)) {
            Serial.println("#ERR not found");
            return;
        }
        Serial.printf("#FILE %s %u\n", argv[1], (unsigned)len);
        Serial.write((const uint8_t *)data, len);
        Serial.print("\n#END\n");
        free(data);
        return;
    }

    if (cmd == "put" || cmd == "apply") {
        bool isPut = (cmd == "put");
        const char *lenArg = isPut ? argv[2] : argv[1];
        const char *name   = isPut ? argv[1] : nullptr;
        if ((isPut && argc < 3) || (!isPut && argc < 2)) {
            Serial.println("#ERR missing arguments");
            return;
        }
        long len = String(lenArg).toInt();
        if (len <= 0 || len > PRESET_MAX_BYTES) {
            Serial.println("#ERR bad length");
            return;
        }
        char *data;
        if (!receiveCounted(&data, (size_t)len)) return;

        if (isPut) {
            String err;
            String loaded = pedal_->presetName();   // list indices shift on write
            if (pedal_->store.writePreset(name, data, len, err)) {
                if (loaded.length()) pedal_->refreshIndexFor(loaded);
                Serial.println("#OK put");
            } else {
                Serial.printf("#ERR %s\n", err.c_str());
            }
        } else {
            String err, warn;
            if (pedal_->patch.loadPatch(data, len, err, warn)) {
                pedal_->presetIndex = -1;  // live patch, not a stored preset
                if (warn.length()) {
                    warn.replace("\n", "; ");
                    Serial.printf("#OK apply rev=%lu fp=%s (warnings: %s)\n",
                                  (unsigned long)pedal_->patch.patchRev(),
                                  pedal_->patch.patchFp().c_str(), warn.c_str());
                } else {
                    Serial.printf("#OK apply rev=%lu fp=%s\n",
                                  (unsigned long)pedal_->patch.patchRev(),
                                  pedal_->patch.patchFp().c_str());
                }
            } else {
                Serial.printf("#ERR %s\n", err.c_str());
            }
        }
        free(data);
        return;
    }

    if (cmd == "rm") {
        if (argc < 2) { Serial.println("#ERR rm needs a name"); return; }
        String err;
        String loaded = pedal_->presetName();       // list indices shift on remove
        if (pedal_->store.removePreset(argv[1], err)) {
            if (loaded.length()) pedal_->refreshIndexFor(loaded);
            Serial.println("#OK rm");
        } else {
            Serial.printf("#ERR %s\n", err.c_str());
        }
        return;
    }

    if (cmd == "bypass") {
        String a = argc > 1 ? argv[1] : "toggle";
        bool on = (a == "on") ? true : (a == "off") ? false : !pedal_->patch.bypassed();
        pedal_->patch.setBypass(on);
        pedal_->persistLater();
        Serial.printf("#OK bypass %s\n", on ? "on" : "off");
        return;
    }

    if (cmd == "vol") {
        if (argc < 2) { Serial.println("#ERR vol needs 0..1"); return; }
        pedal_->patch.setVolume(String(argv[1]).toFloat());
        pedal_->persistLater();
        Serial.printf("#OK vol %.2f\n", pedal_->patch.volume());
        return;
    }

    if (cmd == "switches") {
        String out = "#SWITCHES {\"switches\":[";
        for (int i = 0; i < NUM_SWITCHES; i++) {
            const SwitchConfig &c = pedal_->switches[i];
            if (i) out += ',';
            out += "{\"tap\":\""; out += ACTION_NAMES[c.tap]; out += "\",\"hold\":\""; out += ACTION_NAMES[c.hold];
            out += "\",\"note\":"; out += String((int)c.note); out += "}";
        }
        out += "],\"actions\":[";
        for (int i = 0; i < ACT_COUNT; i++) { if (i) out += ','; out += '"'; out += ACTION_NAMES[i]; out += '"'; }
        out += "]}";
        Serial.println(out);
        return;
    }

    if (cmd == "switch") {
        if (argc < 4) { Serial.println("#ERR switch <1-6> <tap> <hold> [note]"); return; }
        int idx = String(argv[1]).toInt() - 1;
        int tap = actionFromName(argv[2]), hold = actionFromName(argv[3]);
        int note = argc > 4 ? String(argv[4]).toInt() : pedal_->switches[(idx >= 0 && idx < NUM_SWITCHES) ? idx : 0].note;
        if (tap < 0 || hold < 0) { Serial.println("#ERR unknown action (see `switches`)"); return; }
        if (!pedal_->setSwitch(idx, tap, hold, note)) { Serial.println("#ERR switch number 1..6"); return; }
        Serial.println("#OK switch");
        return;
    }

    if (cmd == "loops") {
        std::vector<String> names;
        bool sd = pedal_->store.sdUsable();
        if (sd) LoopFiles::list(names);
        String out = "#LOOPS {\"sd\":"; out += sd ? "true" : "false"; out += ",\"loops\":[";
        for (size_t i = 0; i < names.size(); i++) { if (i) out += ','; out += '"'; jsonEscapeInto(out, names[i]); out += '"'; }
        out += "],\"seconds_max\":"; out += String(pedal_->patch.looper.maxSeconds(), 1); out += "}";
        Serial.println(out);
        return;
    }

    if (cmd == "loop") {
        String sub = argc > 1 ? argv[1] : "";
        if (!pedal_->store.sdUsable()) { Serial.println("#ERR no SD card (loops need the card)"); return; }
        if (argc < 3) { Serial.println("#ERR loop save|load|rm|get|put <name> [len]"); return; }
        String name = LoopFiles::normalizeName(argv[2]), err;
        AudioEffectLooper &lp = pedal_->patch.looper;
        if (sub == "save") {
            if (LoopFiles::save(name, lp, err)) Serial.printf("#OK loop save %s %.2f\n", name.c_str(), lp.lengthSeconds());
            else Serial.printf("#ERR %s\n", err.c_str());
        } else if (sub == "load") {
            if (LoopFiles::load(name, lp, err)) {
                delay(10);
                Serial.printf("#OK loop load %s %.2f\n", name.c_str(), lp.lengthSeconds());
            } else Serial.printf("#ERR %s\n", err.c_str());
        } else if (sub == "rm") {
            if (LoopFiles::remove(name, err)) Serial.println("#OK loop rm");
            else Serial.printf("#ERR %s\n", err.c_str());
        } else if (sub == "get") {
            if (!LoopFiles::validName(name)) { Serial.println("#ERR bad loop name"); return; }
            File f = SD.open(LoopFiles::path(name).c_str(), FILE_READ);
            if (!f) { Serial.println("#ERR not found"); return; }
            uint32_t len = f.size();
            Serial.printf("#FILE %s %u\n", name.c_str(), (unsigned)len);
            uint8_t *buf = (uint8_t *)malloc(4096);
            uint32_t left = len;
            bool hostGone = false;
            if (buf) {
                while (left && !hostGone) {
                    pedal_->patch.pollTone();          // keep the tone's auto-stop on time
                    int n = f.read(buf, left > 4096 ? 4096 : left);
                    if (n <= 0) break;                 // read error: pad below
                    hostGone = !writeAll(buf, n, 8000);
                    left -= n;
                }
                // keep the byte count exact so the client never mis-frames #END
                memset(buf, 0, 4096);
                while (left && !hostGone) { size_t n = left > 4096 ? 4096 : left; hostGone = !writeAll(buf, n, 8000); left -= n; }
                free(buf);
            }
            f.close();
            if (!hostGone) { const char *end = "\n#END\n"; writeAll((const uint8_t *)end, 6, 8000); }
        } else if (sub == "put") {
            if (!LoopFiles::validName(name)) { Serial.println("#ERR bad loop name"); return; }
            long len = argc > 3 ? String(argv[3]).toInt() : 0;
            if (len <= 44 || len > 8400000) { Serial.println("#ERR bad length (max 8 MB)"); return; }
            SD.mkdir(LoopFiles::DIR);
            String p = LoopFiles::path(name);
            String tmp = String(LoopFiles::DIR) + "/.put.tmp";     // the old file survives a failed upload
            SD.remove(tmp.c_str());
            File f = SD.open(tmp.c_str(), FILE_WRITE);
            if (!f) { Serial.println("#ERR cannot create file"); return; }
            uint8_t *buf = (uint8_t *)malloc(4096);
            if (!buf) { f.close(); Serial.println("#ERR out of memory"); return; }
            Serial.println("#SEND");
            long got = 0; bool writeFail = false, timedOut = false;
            uint32_t last = millis();
            while (got < len) {
                pedal_->patch.pollTone();              // keep the tone's auto-stop on time
                int avail = Serial.available();
                if (avail <= 0) {
                    if (millis() - last > 10000) { timedOut = true; break; }   // 10 s idle timeout
                    continue;
                }
                size_t want = len - got; if (want > 4096) want = 4096;
                int n = Serial.readBytes((char *)buf, want);
                if (n <= 0) continue;
                got += n; last = millis();
                if (!writeFail && f.write(buf, n) != (size_t)n) writeFail = true;   // keep draining
            }
            free(buf);
            f.close();
            if (timedOut || writeFail) {
                SD.remove(tmp.c_str());
                Serial.println(timedOut ? "#ERR timeout" : "#ERR SD write failed");
                return;
            }
            SD.remove(p.c_str());
            if (!SD.rename(tmp.c_str(), p.c_str())) { SD.remove(tmp.c_str()); Serial.println("#ERR SD rename failed"); return; }
            Serial.println("#OK loop put");
        } else {
            Serial.println("#ERR loop save|load|rm|get|put <name> [len]");
        }
        return;
    }

    if (cmd == "note") {
        // note on <num> <vel> [ch]   |   note off <num> [ch]
        String a = argc > 1 ? argv[1] : "";
        if (argc < 3 || (a != "on" && a != "off")) { Serial.println("#ERR note on <num> <vel> [ch] | note off <num> [ch]"); return; }
        int num = String(argv[2]).toInt();
        if (num < 0 || num > 127) { Serial.println("#ERR note 0..127"); return; }
        if (a == "on") {
            int vel = argc > 3 ? String(argv[3]).toInt() : 100;
            int ch  = argc > 4 ? String(argv[4]).toInt() : 1;
            if (vel <= 0) { pedal_->patch.noteOff(ch, num); pedal_->midiOut(ch, num, 0, false); }
            else { pedal_->patch.noteOn(ch, num, (vel > 127 ? 127 : vel) / 127.0f); pedal_->midiOut(ch, num, vel > 127 ? 127 : vel, true); }
        } else {
            int ch = argc > 3 ? String(argv[3]).toInt() : 1;
            pedal_->patch.noteOff(ch, num); pedal_->midiOut(ch, num, 0, false);
        }
        Serial.println("#OK note");
        return;
    }

    if (cmd == "tone") {
        // tone [ms] [freq] [level] — quiet diagnostic sine into the analogue
        // output stage only (the running patch, loop and USB audio are all
        // untouched); stops by itself. `tone off` stops it early.
        // Clamped: 100–5000 ms, 40–5000 Hz, level ≤ 0.05.
        String a = argc > 1 ? argv[1] : "";
        if (a == "off" || a == "stop") {
            pedal_->patch.toneStop();
            Serial.println("#OK tone off");
            return;
        }
        long  ms    = a.length() ? String(argv[1]).toInt() : TONE_MS_DEFAULT;
        float freq  = argc > 2 ? String(argv[2]).toFloat() : TONE_FREQ_DEFAULT;
        float level = argc > 3 ? String(argv[3]).toFloat() : TONE_LEVEL_DEFAULT;
        if (a.length() && ms <= 0) { Serial.println("#ERR tone [ms] [freq] [level] | tone off"); return; }
        if (ms < TONE_MS_MIN) ms = TONE_MS_MIN;
        if (ms > TONE_MS_MAX) ms = TONE_MS_MAX;
        pedal_->patch.toneStart((uint32_t)ms, freq, level);
        Serial.printf("#OK tone %ld\n", ms);
        return;
    }

    if (cmd == "source") {
        String a = argc > 1 ? argv[1] : "";
        if (a == "usb")       pedal_->patch.setInputSource(true);
        else if (a == "line") pedal_->patch.setInputSource(false);
        else { Serial.println("#ERR source usb|line"); return; }
        Serial.printf("#OK source %s\n", a.c_str());
        return;
    }

    if (cmd == "looper") {
        String a = argc > 1 ? argv[1] : "";
        AudioEffectLooper &lp = pedal_->patch.looper;
        if      (a == "tap")   lp.tapLoop();
        else if (a == "stop")  lp.tapStop();
        else if (a == "undo")  lp.undo();
        else if (a == "clear") lp.clearLoop();
        else { Serial.println("#ERR looper tap|stop|undo|clear"); return; }
        Serial.println("#OK looper");
        return;
    }

    if (cmd == "help") {
        Serial.println("LoopSmith " FIRMWARE_VERSION);
        Serial.println("  ping | status | monitor on/off | list");
        Serial.println("  load <n|name> | next | prev | get <name>");
        Serial.println("  put <name> <len> | apply <len> | rm <name>");
        Serial.println("  bypass on/off/toggle | vol <0..1> | source line|usb");
        Serial.println("  looper tap|stop|undo|clear | note on <n> <vel> [ch] | note off <n> [ch]");
        Serial.println("  switches | switch <1-6> <tap> <hold> [note]");
        Serial.println("  loops | loop save|load|rm|get|put <name.wav> [len]");
        Serial.println("  tone [ms] [freq] [level] | tone off   (quiet self-stopping test tone, analogue out only)");
        return;
    }

    Serial.println("#ERR unknown command");
}
