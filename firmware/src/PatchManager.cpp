#include "PatchManager.h"
#include "EffectRegistry.h"
#include <new>

void PatchManager::begin()
{
    // codec
    sgtl.enable();
    sgtl.inputSelect(AUDIO_INPUT_LINEIN);
    sgtl.lineInLevel(DEFAULT_LINEIN);
    sgtl.volume(volume_);

    // gains
    inMix.gain(0, 1.0f);      // L
    inMix.gain(1, 1.0f);      // R
    inMix.gain(2, 0.0f);
    inMix.gain(3, 0.0f);
    preGain.gain(1.0f);
    fxIn.gain(1.0f);
    for (int i = 0; i < 4; i++) fxOut.gain(i, 1.0f);
    outMix.gain(0, 1.0f);     // live
    outMix.gain(1, 1.0f);     // loop playback
    outMix.gain(2, 0.0f);
    outMix.gain(3, 0.0f);
    monitorMix_.gain(0, 1.0f);          // everything the pedal makes
    monitorMix_.gain(1, 1.0f);          // diagnostic tone (level set on the tone itself)
    monitorMix_.gain(2, 0.0f);
    monitorMix_.gain(3, 0.0f);
    testTone_.amplitude(0.0f);          // silent until toneStart()
    testTone_.frequency(TONE_FREQ_DEFAULT);
    setBypass(true);          // dry until a preset loads

    outputGate.gain(1.0f);
    recordGate.gain(1.0f);

    // skeleton wiring
    auto C = [this](AudioStream &a, int ap, AudioStream &b, int bp) {
        staticConns_.push_back(new AudioConnection(a, ap, b, bp));
    };
    C(i2sIn, 0, inMix, 0);
    C(i2sIn, 1, inMix, 1);
    C(inMix, 0, preGain, 0);
    C(preGain, 0, fxIn, 0);
    C(preGain, 0, bypassMix, 1);
    C(fxOut, 0, bypassMix, 0);
    C(bypassMix, 0, looper, 0);
    C(bypassMix, 0, outMix, 0);
    C(looper, 0, outMix, 1);
    // Diagnostic tone is audible only on analogue outputs; panic gates both paths.
    C(outMix, 0, monitorMix_, 0);
    C(testTone_, 0, monitorMix_, 1);
    C(monitorMix_, 0, outputGate, 0);
    C(outputGate, 0, i2sOut, 0);
    C(outputGate, 0, i2sOut, 1);
    C(preGain, 0, peakIn_, 0);
    C(outputGate, 0, peakOut_, 0);
#if defined(AUDIO_INTERFACE)
    C(outMix, 0, recordGate, 0);
    C(recordGate, 0, usbOut, 0);
    C(recordGate, 0, usbOut, 1);
    C(usbIn, 0, outMix, 2);           // computer audio into the output mix
    C(usbIn, 1, outMix, 3);
    outMix.gain(2, 0.5f);             // L+R summed to mono at unity overall
    outMix.gain(3, 0.5f);
    C(usbIn, 0, inMix, 2);            // ... or as the instrument source (see setInputSource)
    C(usbIn, 1, inMix, 3);
    inMix.gain(2, 0.0f);
    inMix.gain(3, 0.0f);
#endif
}

void PatchManager::setInputSource(bool usb)
{
    usbSource_ = usb;
#if defined(AUDIO_INTERFACE)
    if (usb) {
        inMix.gain(0, 0.0f);                       // line in muted
        inMix.gain(1, 0.0f);
        inMix.gain(2, 0.5f * hostVol_);            // USB L+R -> mono -> FX chain
        inMix.gain(3, 0.5f * hostVol_);
        outMix.gain(2, 0.0f);                      // no dry USB monitor (it's the instrument now)
        outMix.gain(3, 0.0f);
        return;
    }
    inMix.gain(2, 0.0f);
    inMix.gain(3, 0.0f);
    outMix.gain(2, 0.5f * usbInLevel_ * hostVol_);
    outMix.gain(3, 0.5f * usbInLevel_ * hostVol_);
#endif
    inMix.gain(0, monoL_);
    inMix.gain(1, monoR_);
}

void PatchManager::pollUsbVolume()
{
#if defined(AUDIO_INTERFACE)
    if (AudioInputUSB::features.change) {
        AudioInputUSB::features.change = 0;
        hostVol_ = usbIn.volume();               // 0 when muted, else 0..1
        setInputSource(usbSource_);              // re-apply gains for the active routing
    }
#endif
}

void PatchManager::setBypass(bool on)
{
    bypass_ = on;
    bypassMix.gain(0, on ? 0.0f : 1.0f);
    bypassMix.gain(1, on ? 1.0f : 0.0f);
}

void PatchManager::setVolume(float v)
{
    if (v < 0) v = 0;
    if (v > 1) v = 1;
    volume_ = v;
    sgtl.volume(v);
}

int PatchManager::dynamicStreams() const
{
    int n = 0;
    for (auto &c : cache_) if (c.inUse) n++;
    return n;
}

float PatchManager::peakIn()
{
    if (peakIn_.available()) lastPeakIn_ = peakIn_.read();
    else lastPeakIn_ *= 0.7f;
    return lastPeakIn_;
}

float PatchManager::peakOut()
{
    if (peakOut_.available()) lastPeakOut_ = peakOut_.read();
    else lastPeakOut_ *= 0.7f;
    return lastPeakOut_;
}

// --------------------------------------------------------------------------
// Diagnostic test tone (see config.h TONE_* for the clamps)
// --------------------------------------------------------------------------

bool PatchManager::toneStart(uint32_t ms, float freq, float level)
{
    if (ms < TONE_MS_MIN) ms = TONE_MS_MIN;
    if (ms > TONE_MS_MAX) ms = TONE_MS_MAX;
    if (!(freq >= TONE_FREQ_MIN && freq <= TONE_FREQ_MAX)) freq = TONE_FREQ_DEFAULT;
    if (!(level > 0.0f)) level = TONE_LEVEL_DEFAULT;
    if (level > TONE_LEVEL_MAX) level = TONE_LEVEL_MAX;
    testTone_.frequency(freq);
    testTone_.amplitude(level);
    toneOn_ = true;
    toneOffAt_ = millis() + ms;
    return true;
}

void PatchManager::toneStop()
{
    testTone_.amplitude(0.0f);
    toneOn_ = false;
}

void PatchManager::pollTone()
{
    if (toneOn_ && (int32_t)(millis() - toneOffAt_) >= 0) toneStop();
}

// --------------------------------------------------------------------------
// MIDI voices
// --------------------------------------------------------------------------

bool PatchManager::bindVoice(const String &name, const String &type, AudioStream *s,
                             const std::vector<PatchArg> &args, String &why)
{
    VoiceKind kind;
    if      (type == "AudioSynthKarplusStrong")     kind = VK_KARPLUS;
    else if (type == "AudioSynthSimpleDrum")        kind = VK_DRUM;
    else if (type == "AudioSynthWaveform")          kind = VK_WAVEFORM;
    else if (type == "AudioSynthWaveformSine")      kind = VK_SINE;
    else if (type == "AudioSynthWaveformModulated") kind = VK_MODULATED;
    else if (type == "AudioSynthWaveformPWM")       kind = VK_PWM;
    else if (type == "AudioEffectEnvelope")         kind = VK_ENV;
    else if (type == "AudioFilterStateVariable")    kind = VK_SVF;     // cutoff tracks the note
    else if (type == "AudioSynthToneSweep")         kind = VK_SWEEP;
    else if (type == "AudioPlaySdWav")              kind = VK_SDWAV;
    else { why = type + " cannot be a MIDI voice"; return false; }

    if (args.size() < 2 || args.size() > 3 || !args[0].isNumber || args[1].isNumber) {
        why = name + ".midi() expects (channel, group[, note])";
        return false;
    }
    int channel = (int)args[0].num;
    if (channel < 0 || channel > 16) { why = name + ".midi(): channel must be 0..16"; return false; }
    int note = -1;
    if (args.size() == 3) {
        if (!args[2].isNumber || args[2].num < 0 || args[2].num > 127) { why = name + ".midi(): note must be 0..127"; return false; }
        note = (int)args[2].num;
    }
    VoiceUnit *unit = nullptr;
    for (auto &u : voices_) {
        if (u.channel == channel && u.group.equals(args[1].token)) { unit = &u; break; }
    }
    if (!unit) {
        VoiceUnit u;
        u.channel = (uint8_t)channel;
        u.group = args[1].token;
        u.note = (int16_t)note;
        voices_.push_back(u);
        unit = &voices_.back();
    } else if (note >= 0) {
        unit->note = (int16_t)note;
    }
    if (kind == VK_ENV) {
        // a cached envelope left sustaining by an earlier teardown must fade out
        auto *env = static_cast<AudioEffectEnvelope *>(s);
        if (env->isActive()) env->noteOff();
    }
    unit->members.push_back({s, kind, VoiceExtra()});
    return true;
}

PatchManager::VoiceExtra &PatchManager::extraFor(AudioStream *s)
{
    for (auto &e : extras_) if (e.s == s) return e;
    VoiceExtra e; e.s = s;
    extras_.push_back(e);
    return extras_.back();
}

void PatchManager::applyExtras()
{
    for (auto &u : voices_)
        for (auto &m : u.members)
            for (auto &e : extras_)
                if (e.s == m.s) { m.x = e; break; }
    extras_.clear();
}

void PatchManager::triggerUnit(VoiceUnit &u, float freq, float vel, int note)
{
    noteTriggers_++;       // a voice really fired — diagnostics evidence
    for (auto &m : u.members) {
        const float f   = freq * m.x.ratio;
        const float amp = m.x.base * (1.0f - m.x.velSens + m.x.velSens * vel);   // velocity-scaled level
        const bool  vs  = m.x.velSens > 0.0f;
        switch (m.kind) {
        case VK_KARPLUS:   static_cast<AudioSynthKarplusStrong *>(m.s)->noteOn(f, vel); break;
        case VK_DRUM:      static_cast<AudioSynthSimpleDrum *>(m.s)->noteOn(); break;
        case VK_WAVEFORM: { auto *o = static_cast<AudioSynthWaveform *>(m.s); o->frequency(f); if (vs) o->amplitude(amp); break; }
        case VK_SINE:     { auto *o = static_cast<AudioSynthWaveformSine *>(m.s); o->frequency(f); if (vs) o->amplitude(amp); break; }
        case VK_MODULATED:{ auto *o = static_cast<AudioSynthWaveformModulated *>(m.s); o->frequency(f); if (vs) o->amplitude(amp); break; }
        case VK_PWM:      { auto *o = static_cast<AudioSynthWaveformPWM *>(m.s); o->frequency(f); if (vs) o->amplitude(amp); break; }
        case VK_ENV:       static_cast<AudioEffectEnvelope *>(m.s)->noteOn(); break;
        case VK_SVF:       static_cast<AudioFilterStateVariable *>(m.s)->frequency(f); break;
        case VK_SWEEP:     // a note-allocated sweep starts at the note; a pinned pad uses its own "from"
            static_cast<AudioSynthToneSweep *>(m.s)->play(m.x.swAmp * (vs ? (1.0f - m.x.velSens + m.x.velSens * vel) : 1.0f),
                                                          (int)(u.note < 0 ? f : m.x.swFrom), (int)m.x.swTo, m.x.swMs / 1000.0f);
            break;
        case VK_SDWAV:     if (m.x.file.length()) static_cast<AudioPlaySdWav *>(m.s)->play(m.x.file.c_str()); break;
        }
    }
    u.playing = (int16_t)note;
    u.stamp = ++voiceClock_;
}

void PatchManager::noteOn(uint8_t channel, uint8_t note, float velocity)
{
    if (voices_.empty()) return;
    float freq = 440.0f * powf(2.0f, ((int)note - 69) / 12.0f);
    auto onChannel = [&](const VoiceUnit &u) { return u.channel == 0 || u.channel == channel; };

    // 1. note-pinned units (drum pads) fire together and don't take part in allocation
    bool hit = false;
    for (auto &u : voices_) {
        if (onChannel(u) && u.note == note) { triggerUnit(u, freq, velocity, note); hit = true; }
    }
    if (hit) return;

    // 2. retrigger the unit already holding this note, else the oldest free
    //    unit, else steal the oldest playing one
    VoiceUnit *pick = nullptr;
    for (auto &u : voices_) if (onChannel(u) && u.note < 0 && u.playing == note) { pick = &u; break; }
    if (!pick) for (auto &u : voices_) if (onChannel(u) && u.note < 0 && u.playing < 0 && (!pick || u.stamp < pick->stamp)) pick = &u;
    if (!pick) for (auto &u : voices_) if (onChannel(u) && u.note < 0 && (!pick || u.stamp < pick->stamp)) pick = &u;
    if (pick) triggerUnit(*pick, freq, velocity, note);
}

void PatchManager::noteOff(uint8_t channel, uint8_t note)
{
    for (auto &u : voices_) {
        if (!(u.channel == 0 || u.channel == channel) || u.playing != note) continue;
        for (auto &m : u.members) {
            if (m.kind == VK_ENV) static_cast<AudioEffectEnvelope *>(m.s)->noteOff();
            // plucked strings ring out; drums and bare oscillators have nothing to release
        }
        u.playing = -1;
    }
}

void PatchManager::allNotesOff()
{
    AudioNoInterrupts();
    releaseVoices();
    AudioInterrupts();
}

void PatchManager::releaseVoices()
{
    // Envelopes keep their state across a rebuild (streams are cached), so a
    // note held through a preset change would sustain forever: release them.
    for (auto &u : voices_) {
        for (auto &m : u.members)
            if (m.kind == VK_ENV) static_cast<AudioEffectEnvelope *>(m.s)->noteOff();
        u.playing = -1;
    }
}

void PatchManager::unloadPatch()
{
    AudioNoInterrupts();
    releaseVoices();
    voices_.clear();
    extras_.clear();
    drainDelays();
    for (auto *c : dynConns_) {
        c->disconnect();
        delete c;
    }
    dynConns_.clear();
    for (auto &c : cache_) c.inUse = false;
    AudioInterrupts();
    setBypass(true);
    // The previous patch is gone (this is also the dry-bypass fallback after a
    // rare mid-apply failure): say so, instead of letting a client keep an
    // out-of-date "confirmed running" claim alive.
    patchRev_++;
    patchFpHash_ = 0;
    patchFpLen_ = 0;
    title_ = "";
}

bool PatchManager::loadPatch(const char *text, size_t len, String &err, String &warnings)
{
    PatchDoc doc;
    if (!doc.parse(text, len)) {
        err = "line " + String(doc.errorLine) + ": " + doc.error;
        return false;
    }

    // ---- pass 1: symbols -------------------------------------------------
    struct Decl { String name; String type; const EffectInfo *info; };
    std::vector<Decl> decls;
    std::vector<String> aliasIn, aliasOut, ignored;

    auto inList = [](const std::vector<String> &v, const String &n) {
        for (auto &s : v) if (s.equals(n)) return true;
        return false;
    };
    auto isDeclared = [&](const String &n) {
        if (n == "fxin" || n == "fxout") return true;
        if (inList(aliasIn, n) || inList(aliasOut, n) || inList(ignored, n)) return true;
        for (auto &d : decls) if (d.name.equals(n)) return true;
        return false;
    };

    for (auto &st : doc.stmts) {
        if (st.kind != PatchStmt::DECL) continue;
        if (isDeclared(st.name)) {
            err = "line " + String(st.line) + ": duplicate name '" + st.name + "'";
            return false;
        }
        if (st.type.startsWith("AudioInput")) {          // alias to fxin
            aliasIn.push_back(st.name);
        } else if (st.type.startsWith("AudioOutput")) {  // alias to fxout
            aliasOut.push_back(st.name);
        } else if (st.type.startsWith("AudioControl")) { // firmware owns the codec
            warnings += "line " + String(st.line) + ": ignoring " + st.type + "\n";
            ignored.push_back(st.name);
        } else {
            const EffectInfo *info = effectRegistryFind(st.type);
            if (!info) {
                err = "line " + String(st.line) + ": unsupported type '" + st.type + "'";
                return false;
            }
            decls.push_back({st.name, st.type, info});
        }
    }
    if ((int)decls.size() > PATCH_MAX_STREAMS) {
        err = "too many objects (max " + String(PATCH_MAX_STREAMS) + ")";
        return false;
    }

    auto findDecl = [&](const String &n) -> Decl * {
        for (auto &d : decls) if (d.name.equals(n)) return &d;
        return nullptr;
    };

    // ---- pass 2: validate connections ------------------------------------
    struct PendingConn { AudioStream *src; int sp; AudioStream *dst; int dp; };
    int connCount = 0;
    std::vector<String> usedInputs; // "name#port" one-driver-per-input check

    for (auto &st : doc.stmts) {
        if (st.kind != PatchStmt::CONN) continue;
        connCount++;
        if (connCount > PATCH_MAX_CONNS) {
            err = "too many connections";
            return false;
        }
        // sources
        String s = st.src, d = st.dst;
        if (inList(aliasIn, s)) s = "fxin";
        if (inList(aliasOut, s)) {
            err = "line " + String(st.line) + ": '" + st.src + "' (output) cannot be a source";
            return false;
        }
        if (inList(aliasOut, d)) d = "fxout";
        if (inList(aliasIn, d)) {
            err = "line " + String(st.line) + ": '" + st.dst + "' (input) cannot be a destination";
            return false;
        }
        if (s == "fxout") { err = "line " + String(st.line) + ": fxout cannot be a source"; return false; }
        if (d == "fxin")  { err = "line " + String(st.line) + ": fxin cannot be a destination"; return false; }

        if (s != "fxin") {
            Decl *sd = findDecl(s);
            if (!sd) {
                if (inList(ignored, s)) { continue; }   // connection to an ignored control
                err = "line " + String(st.line) + ": unknown source '" + st.src + "'";
                return false;
            }
            if (st.srcPort >= sd->info->numOutputs) {
                err = "line " + String(st.line) + ": " + s + " has no output " + String(st.srcPort);
                return false;
            }
        }
        int dp = st.dstPort;
        if (d == "fxout") {
            if (dp > 3) { warnings += "line " + String(st.line) + ": fxout input clamped to 3\n"; dp = 3; }
        } else {
            Decl *dd = findDecl(d);
            if (!dd) {
                if (inList(ignored, d)) { continue; }
                err = "line " + String(st.line) + ": unknown destination '" + st.dst + "'";
                return false;
            }
            if (dp >= dd->info->numInputs) {
                err = "line " + String(st.line) + ": " + d + " has no input " + String(dp);
                return false;
            }
        }
        String key = d + "#" + String(dp);
        if (inList(usedInputs, key)) {
            err = "line " + String(st.line) + ": two connections drive " + d + " input " + String(dp) +
                  " (use an AudioMixer4 to sum)";
            return false;
        }
        usedInputs.push_back(key);
    }

    // ---- pass 3a: pre-allocate everything that can fail --------------------
    // Streams and connection objects are created BEFORE the old graph is torn
    // down, so an out-of-memory failure leaves the previous patch playing.
    for (auto &d : decls) {
        Cached *hit = nullptr;
        for (auto &c : cache_) {
            if (c.name.equals(d.name) && c.type.equals(d.type)) { hit = &c; break; }
        }
        if (!hit) {
            AudioNoInterrupts();          // the AudioStream ctor links the update list
            AudioStream *s = d.info->create();
            AudioInterrupts();
            if (!s) {
                err = "out of memory creating " + d.type;
                return false;
            }
            cache_.push_back({d.name, d.type, s, d.info, false});
        }
    }

    std::vector<AudioConnection *> fresh;
    for (auto &st : doc.stmts) {
        if (st.kind != PatchStmt::CONN) continue;
        if (inList(ignored, st.src) || inList(ignored, st.dst)) continue;
        AudioConnection *c = new (std::nothrow) AudioConnection();
        if (!c) {
            for (auto *p : fresh) delete p;   // still unconnected: safe to delete
            err = "out of memory";
            return false;
        }
        fresh.push_back(c);
    }

    // ---- pass 3b: swap graphs inside the audio lock ------------------------
    AudioNoInterrupts();

    drainDelays();

    for (auto *c : dynConns_) { c->disconnect(); delete c; }
    dynConns_.clear();
    for (auto &c : cache_) c.inUse = false;
    releaseVoices();
    voices_.clear();

    // reserved endpoints start every preset from known defaults
    fxIn.gain(1.0f);
    for (int i = 0; i < 4; i++) fxOut.gain(i, 1.0f);

    for (auto &d : decls) {
        for (auto &c : cache_) {
            if (!c.inUse && c.name.equals(d.name) && c.type.equals(d.type)) {
                c.inUse = true;
                break;
            }
        }
    }

    auto liveStream = [&](const String &n) -> AudioStream * {
        for (auto &c : cache_) {
            if (c.inUse && c.name.equals(n)) return c.stream;
        }
        return nullptr;
    };

    bool wetPath = false;
    size_t freshIdx = 0;
    for (auto &st : doc.stmts) {
        if (st.kind != PatchStmt::CONN) continue;
        if (inList(ignored, st.src) || inList(ignored, st.dst)) continue;
        String s = st.src, d = st.dst;
        if (inList(aliasIn, s)) s = "fxin";
        if (inList(aliasOut, d)) d = "fxout";

        AudioStream *src; int sp = st.srcPort;
        AudioStream *dst; int dp = st.dstPort;
        if (s == "fxin") { src = &fxIn; sp = 0; }
        else src = liveStream(s);
        if (d == "fxout") { dst = &fxOut; if (dp > 3) dp = 3; wetPath = true; }
        else dst = liveStream(d);
        if (!src || !dst) continue; // validated earlier; belt and braces

        AudioConnection *c = fresh[freshIdx++];
        c->connect(*src, sp, *dst, dp);
        dynConns_.push_back(c);
    }
    while (freshIdx < fresh.size()) delete fresh[freshIdx++]; // unconnected spares

    // ---- pass 4: setters ---------------------------------------------------
    bool hardFail = false;
    for (auto &st : doc.stmts) {
        if (st.kind != PatchStmt::SETTER) continue;
        if (st.name == "fxin" || inList(aliasIn, st.name)) continue;
        if (inList(ignored, st.name)) continue;

        if (st.name == "fxout" || inList(aliasOut, st.name)) {
            // allow fxout.gain(ch, v)
            if (st.method == "gain" && st.args.size() == 2 &&
                st.args[0].isNumber && st.args[1].isNumber) {
                int ch = (int)st.args[0].num;
                if (ch >= 0 && ch <= 3) fxOut.gain(ch, st.args[1].num);
            }
            continue;
        }

        Cached *target = nullptr;
        for (auto &c : cache_) {
            if (c.inUse && c.name.equals(st.name)) { target = &c; break; }
        }
        if (!target) {
            warnings += "line " + String(st.line) + ": unknown object '" + st.name + "'\n";
            continue;
        }
        if (st.method == "midi") {                 // PatchScript extension: voice binding
            String why;
            if (!bindVoice(target->name, target->type, target->stream, st.args, why))
                warnings += "line " + String(st.line) + ": " + why + "\n";
            continue;
        }
        // ---- voice extensions (see docs/PATCHSCRIPT.md "Instruments") ----
        const size_t na = st.args.size();
        if (st.method == "midiRatio") {
            if (na == 1 && st.args[0].isNumber) extraFor(target->stream).ratio = constrain(st.args[0].num, 0.01f, 64.0f);
            else warnings += "line " + String(st.line) + ": midiRatio(x) expects one number\n";
            continue;
        }
        if (st.method == "midiVelocity") {
            if (na == 1 && st.args[0].isNumber) extraFor(target->stream).velSens = constrain(st.args[0].num, 0.0f, 1.0f);
            else warnings += "line " + String(st.line) + ": midiVelocity(s) expects 0..1\n";
            continue;
        }
        if (st.method == "sweep") {
            if (na == 4 && st.args[0].isNumber && st.args[1].isNumber && st.args[2].isNumber && st.args[3].isNumber) {
                VoiceExtra &e = extraFor(target->stream);
                e.swAmp = constrain(st.args[0].num, 0.0f, 1.0f); e.swFrom = constrain(st.args[1].num, 20.0f, 20000.0f);
                e.swTo = constrain(st.args[2].num, 20.0f, 20000.0f); e.swMs = constrain(st.args[3].num, 10.0f, 5000.0f);
            } else warnings += "line " + String(st.line) + ": sweep(amp, fromHz, toHz, ms)\n";
            continue;
        }
        if (st.method == "file") {
            if (na == 1 && !st.args[0].isNumber && st.args[0].token.length() && st.args[0].token.indexOf('/') < 0 &&
                st.args[0].token.indexOf('.') < 0)
                extraFor(target->stream).file = String("/samples/") + st.args[0].token + ".wav";
            else warnings += "line " + String(st.line) + ": file(name) - a bare name, /samples/<name>.wav\n";
            continue;
        }
        if ((st.method == "amplitude" && na >= 1 && st.args[0].isNumber) ||
            (st.method == "begin" && na == 3 && st.args[0].isNumber))
            extraFor(target->stream).base = st.args[0].num;      // remembered for velocity scaling
        ApplyResult r = target->info->apply(target->stream, st.method,
                                            st.args.data(), (int)st.args.size());
        if (r == APPLY_UNKNOWN_METHOD)
            warnings += "line " + String(st.line) + ": " + target->type + " has no method '" + st.method + "'\n";
        else if (r == APPLY_BAD_ARGS)
            warnings += "line " + String(st.line) + ": bad arguments for " + st.name + "." + st.method + "()\n";
        else if (r == APPLY_ALLOC_FAILED) {
            err = "line " + String(st.line) + ": out of memory for " + st.name + "." + st.method + "()";
            hardFail = true;
            break;
        }
    }

    applyExtras();
    AudioInterrupts();

    if (hardFail) {
        // rare mid-apply failure: the safe landing is silence + dry bypass
        unloadPatch();
        return false;
    }

    title_ = doc.title;
    setBypass(!wetPath);   // engage the chain if it reaches fxout, else stay dry
    patchRev_++;           // a new patch is confirmed running (see patchRev())
    {                      // exact identity of what is now running (see patchFp())
        uint32_t h = 2166136261u;
        for (size_t i = 0; i < len; i++) { h ^= (uint8_t)text[i]; h *= 16777619u; }
        patchFpHash_ = h;
        patchFpLen_ = (uint32_t)len;
    }
    return true;
}

// Parked or about-to-be-rewired AudioEffectDelay instances pin audio blocks in
// their internal queue (a fully disconnected stream goes inactive and never
// releases them). Disabling every tap sets its block budget to zero and two
// manual update() pumps hand the queued blocks back to the pool.
// Call only with audio interrupts disabled.
void PatchManager::drainDelays()
{
    for (auto &c : cache_) {
        if (c.type.equals("AudioEffectDelay")) {
            auto *d = static_cast<AudioEffectDelay *>(c.stream);
            for (int ch = 0; ch < 8; ch++) d->disable(ch);
            d->update();
            d->update();
        }
    }
}

// --------------------------------------------------------------------------
// settings.txt — one directive per line: key(args) — see the README
// --------------------------------------------------------------------------

void PatchManager::applySettingsText(const char *text, size_t len, String &warnings)
{
    String line;
    int lineNo = 1;
    for (size_t i = 0; i <= len; i++) {
        char c = (i < len) ? text[i] : '\n';
        if (c == '\r') continue;
        if (c != '\n') { line += c; continue; }

        String work = line;
        line = "";
        int ci = work.indexOf("//");
        if (ci != -1) work = work.substring(0, ci);
        work.trim();
        lineNo++;
        if (work.length() == 0) continue;
        if (work.endsWith(";")) work = work.substring(0, work.length() - 1);

        int p1 = work.indexOf('(');
        int p2 = work.lastIndexOf(')');
        if (p1 == -1 || p2 < p1) {
            warnings += "settings line " + String(lineNo - 1) + ": expected key(value)\n";
            continue;
        }
        String key = work.substring(0, p1);
        String arg = work.substring(p1 + 1, p2);
        key.trim();
        arg.trim();

        int comma = arg.indexOf(',');
        String arg2 = "";
        if (comma != -1) {
            arg2 = arg.substring(comma + 1);
            arg = arg.substring(0, comma);
            arg.trim();
            arg2.trim();
        }
        float f = arg.toFloat();

        if (key == "input") {
            if (arg == "MIC") { sgtl.inputSelect(AUDIO_INPUT_MIC); sgtl.micGain(DEFAULT_MICGAIN); setInputSource(false); }
            else if (arg == "USB") setInputSource(true);
            else { sgtl.inputSelect(AUDIO_INPUT_LINEIN); setInputSource(false); }
        }
        else if (key == "lineInLevel")  sgtl.lineInLevel((int)f);
        else if (key == "lineOutLevel") sgtl.lineOutLevel((int)f);
        else if (key == "micGain")      sgtl.micGain((int)f);
        else if (key == "volume")       setVolume(f);
        else if (key == "inputGain")    preGain.gain(f);
        else if (key == "dryLevel")     outMix.gain(0, f);
        else if (key == "loopLevel")    outMix.gain(1, f);
        else if (key == "usbInLevel") { usbInLevel_ = f; setInputSource(usbSource_); }
        else if (key == "monoSum") {
            monoL_ = f;
            monoR_ = arg2.length() ? arg2.toFloat() : f;
            if (!usbSource_) { inMix.gain(0, monoL_); inMix.gain(1, monoR_); }
        }
        else warnings += "settings: unknown key '" + key + "'\n";
    }
}
