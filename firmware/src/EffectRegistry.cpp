#include "EffectRegistry.h"
#include <Audio.h>
#include <math.h>
#include <new>

// ---------------------------------------------------------------------------
// Delay-line bookkeeping. Chorus / flange / granular need caller-supplied
// sample buffers; PatchScript hides that, so we allocate here and remember the
// allocation per stream so a re-begin() can reuse or grow it.
// ---------------------------------------------------------------------------

struct DelayLineSlot {
    AudioStream *owner = nullptr;
    int16_t *buf = nullptr;
    uint32_t samples = 0;
};

static const int MAX_DELAY_LINES = 16;
static DelayLineSlot delayLines[MAX_DELAY_LINES];

static int16_t *getDelayLine(AudioStream *owner, uint32_t samples)
{
    DelayLineSlot *freeSlot = nullptr;
    for (auto &s : delayLines) {
        if (s.owner == owner) {
            if (s.samples >= samples) return s.buf;
            // grow: allocate + zero the new buffer BEFORE touching the old one,
            // so failure leaves the effect's existing pointer valid
            int16_t *nbuf = (int16_t *)malloc(samples * sizeof(int16_t));
            if (!nbuf) return nullptr;
            memset(nbuf, 0, samples * sizeof(int16_t));
            free(s.buf);
            s.buf = nbuf;
            s.samples = samples;
            return s.buf;
        }
        if (!s.owner && !freeSlot) freeSlot = &s;
    }
    if (!freeSlot) return nullptr;
    freeSlot->buf = (int16_t *)malloc(samples * sizeof(int16_t));
    if (!freeSlot->buf) return nullptr;
    memset(freeSlot->buf, 0, samples * sizeof(int16_t));
    freeSlot->owner = owner;
    freeSlot->samples = samples;
    return freeSlot->buf;
}

void effectRegistryReleaseBuffers(AudioStream *s)
{
    for (auto &slot : delayLines) {
        if (slot.owner == s) {
            free(slot.buf);
            slot.buf = nullptr;
            slot.samples = 0;
            slot.owner = nullptr;
        }
    }
}

// ---------------------------------------------------------------------------
// argument helpers
// ---------------------------------------------------------------------------

static bool nums(const PatchArg *args, int argc, int need, float *out)
{
    if (argc != need) return false;
    for (int i = 0; i < need; i++) {
        if (!args[i].isNumber) return false;
        out[i] = args[i].num;
    }
    return true;
}

static bool waveformToken(const PatchArg &a, short &out)
{
    if (a.isNumber) { out = (short)a.num; return true; }
    const struct { const char *n; short v; } tbl[] = {
        {"WAVEFORM_SINE", WAVEFORM_SINE},
        {"WAVEFORM_SAWTOOTH", WAVEFORM_SAWTOOTH},
        {"WAVEFORM_SQUARE", WAVEFORM_SQUARE},
        {"WAVEFORM_TRIANGLE", WAVEFORM_TRIANGLE},
        {"WAVEFORM_ARBITRARY", WAVEFORM_ARBITRARY},
        {"WAVEFORM_PULSE", WAVEFORM_PULSE},
        {"WAVEFORM_SAWTOOTH_REVERSE", WAVEFORM_SAWTOOTH_REVERSE},
        {"WAVEFORM_SAMPLE_HOLD", WAVEFORM_SAMPLE_HOLD},
        {"WAVEFORM_TRIANGLE_VARIABLE", WAVEFORM_TRIANGLE_VARIABLE},
    };
    for (auto &e : tbl) {
        if (a.token.equals(e.n)) { out = e.v; return true; }
    }
    return false;
}

static float clampf(float v, float lo, float hi)
{
    return v < lo ? lo : (v > hi ? hi : v);
}

// ---------------------------------------------------------------------------
// per-type apply functions
// ---------------------------------------------------------------------------

static ApplyResult applyAmplifier(AudioStream *s, const String &m, const PatchArg *a, int n)
{
    auto *o = static_cast<AudioAmplifier *>(s);
    float v[1];
    if (m == "gain") {
        if (!nums(a, n, 1, v)) return APPLY_BAD_ARGS;
        o->gain(v[0]);
        return APPLY_OK;
    }
    return APPLY_UNKNOWN_METHOD;
}

static ApplyResult applyMixer4(AudioStream *s, const String &m, const PatchArg *a, int n)
{
    auto *o = static_cast<AudioMixer4 *>(s);
    float v[2];
    if (m == "gain") {
        if (!nums(a, n, 2, v)) return APPLY_BAD_ARGS;
        int ch = (int)v[0];
        if (ch < 0 || ch > 3) return APPLY_BAD_ARGS;
        o->gain(ch, v[1]);
        return APPLY_OK;
    }
    return APPLY_UNKNOWN_METHOD;
}

template <class T>
static ApplyResult applyFreeverb(AudioStream *s, const String &m, const PatchArg *a, int n)
{
    auto *o = static_cast<T *>(s);
    float v[1];
    if (m == "roomsize") {
        if (!nums(a, n, 1, v)) return APPLY_BAD_ARGS;
        o->roomsize(clampf(v[0], 0.0f, 1.0f));
        return APPLY_OK;
    }
    if (m == "damping") {
        if (!nums(a, n, 1, v)) return APPLY_BAD_ARGS;
        o->damping(clampf(v[0], 0.0f, 1.0f));
        return APPLY_OK;
    }
    return APPLY_UNKNOWN_METHOD;
}

static const uint32_t CHORUS_SAMPLES = 16 * AUDIO_BLOCK_SAMPLES;

static ApplyResult applyChorus(AudioStream *s, const String &m, const PatchArg *a, int n)
{
    auto *o = static_cast<AudioEffectChorus *>(s);
    float v[1];
    if (m == "begin" || m == "voices") {
        if (!nums(a, n, 1, v)) return APPLY_BAD_ARGS;
        int voices = (int)clampf(v[0], 1, 8);
        if (m == "begin") {
            int16_t *dl = getDelayLine(s, CHORUS_SAMPLES);
            if (!dl) return APPLY_ALLOC_FAILED;
            o->begin(dl, CHORUS_SAMPLES, voices);
        } else {
            o->voices(voices);
        }
        return APPLY_OK;
    }
    return APPLY_UNKNOWN_METHOD;
}

static const uint32_t FLANGE_SAMPLES = 12 * AUDIO_BLOCK_SAMPLES;
// The library halves the buffer it is given (delay_length = d_length/2), so
// offset + depth must fit inside FLANGE_SAMPLES / 2.
static const int FLANGE_USABLE = FLANGE_SAMPLES / 2;

static ApplyResult applyFlange(AudioStream *s, const String &m, const PatchArg *a, int n)
{
    auto *o = static_cast<AudioEffectFlange *>(s);
    float v[3];
    if (m == "begin") {
        if (!nums(a, n, 3, v)) return APPLY_BAD_ARGS;
        int offset = (int)clampf(v[0], 1, FLANGE_USABLE - 2);
        int depth  = (int)clampf(v[1], 1, FLANGE_USABLE - offset - 1);
        int16_t *dl = getDelayLine(s, FLANGE_SAMPLES);
        if (!dl) return APPLY_ALLOC_FAILED;
        if (!o->begin(dl, FLANGE_SAMPLES, offset, depth, v[2])) return APPLY_BAD_ARGS;
        return APPLY_OK;
    }
    return APPLY_UNKNOWN_METHOD;
}

static ApplyResult applyDelay(AudioStream *s, const String &m, const PatchArg *a, int n)
{
    auto *o = static_cast<AudioEffectDelay *>(s);
    float v[2];
    if (m == "delay") {
        if (!nums(a, n, 2, v)) return APPLY_BAD_ARGS;
        int ch = (int)v[0];
        if (ch < 0 || ch > 7) return APPLY_BAD_ARGS;
        o->delay(ch, clampf(v[1], 0.0f, 1000.0f));
        return APPLY_OK;
    }
    if (m == "disable") {
        if (!nums(a, n, 1, v)) return APPLY_BAD_ARGS;
        int ch = (int)v[0];
        if (ch < 0 || ch > 7) return APPLY_BAD_ARGS;
        o->disable(ch);
        return APPLY_OK;
    }
    return APPLY_UNKNOWN_METHOD;
}

static ApplyResult applyBitcrusher(AudioStream *s, const String &m, const PatchArg *a, int n)
{
    auto *o = static_cast<AudioEffectBitcrusher *>(s);
    float v[1];
    if (m == "bits") {
        if (!nums(a, n, 1, v)) return APPLY_BAD_ARGS;
        o->bits((uint8_t)clampf(v[0], 1, 16));
        return APPLY_OK;
    }
    if (m == "sampleRate") {
        if (!nums(a, n, 1, v)) return APPLY_BAD_ARGS;
        o->sampleRate(clampf(v[0], 1.0f, 44100.0f));
        return APPLY_OK;
    }
    return APPLY_UNKNOWN_METHOD;
}

static ApplyResult applyWaveshaper(AudioStream *s, const String &m, const PatchArg *a, int n)
{
    auto *o = static_cast<AudioEffectWaveshaper *>(s);
    float v[1];
    if (m == "drive") {
        if (!nums(a, n, 1, v)) return APPLY_BAD_ARGS;
        float drive = clampf(v[0], 1.0f, 10.0f);
        // smooth symmetric tanh curve; the library copies this into its own table
        static const int N = 257;
        float curve[N];
        float norm = tanhf(drive);
        for (int i = 0; i < N; i++) {
            float t = (i / (float)(N - 1)) * 2.0f - 1.0f;
            curve[i] = tanhf(drive * t) / norm;
        }
        o->shape(curve, N);
        return APPLY_OK;
    }
    return APPLY_UNKNOWN_METHOD;
}

static ApplyResult applyGranular(AudioStream *s, const String &m, const PatchArg *a, int n)
{
    auto *o = static_cast<AudioEffectGranular *>(s);
    float v[1];
    float msToSamples = AUDIO_SAMPLE_RATE_EXACT / 1000.0f;
    if (m == "begin") {
        if (!nums(a, n, 1, v)) return APPLY_BAD_ARGS;
        uint32_t samples = (uint32_t)(clampf(v[0], 20.0f, 700.0f) * msToSamples);
        int16_t *dl = getDelayLine(s, samples);
        if (!dl) return APPLY_ALLOC_FAILED;
        o->begin(dl, samples);
        return APPLY_OK;
    }
    if (m == "beginPitchShift" || m == "beginFreeze") {
        if (!nums(a, n, 1, v)) return APPLY_BAD_ARGS;
        float grain = clampf(v[0], 20.0f, 700.0f);
        if (m == "beginPitchShift") o->beginPitchShift(grain);
        else o->beginFreeze(grain);
        return APPLY_OK;
    }
    if (m == "setSpeed") {
        if (!nums(a, n, 1, v)) return APPLY_BAD_ARGS;
        o->setSpeed(clampf(v[0], 0.125f, 8.0f));
        return APPLY_OK;
    }
    if (m == "stop") {
        if (n != 0) return APPLY_BAD_ARGS;
        o->stop();
        return APPLY_OK;
    }
    return APPLY_UNKNOWN_METHOD;
}

static ApplyResult applyEnvelope(AudioStream *s, const String &m, const PatchArg *a, int n)
{
    auto *o = static_cast<AudioEffectEnvelope *>(s);
    float v[1];
    if (m == "noteOn")  { if (n != 0) return APPLY_BAD_ARGS; o->noteOn();  return APPLY_OK; }
    if (m == "noteOff") { if (n != 0) return APPLY_BAD_ARGS; o->noteOff(); return APPLY_OK; }
    if (!nums(a, n, 1, v)) return APPLY_BAD_ARGS;
    if (m == "attack")  { o->attack(v[0]);  return APPLY_OK; }
    if (m == "hold")    { o->hold(v[0]);    return APPLY_OK; }
    if (m == "decay")   { o->decay(v[0]);   return APPLY_OK; }
    if (m == "sustain") { o->sustain(clampf(v[0], 0, 1)); return APPLY_OK; }
    if (m == "release") { o->release(v[0]); return APPLY_OK; }
    return APPLY_UNKNOWN_METHOD;
}

static ApplyResult applyNone(AudioStream *, const String &, const PatchArg *, int)
{
    return APPLY_UNKNOWN_METHOD;
}

static ApplyResult applyCombine(AudioStream *s, const String &m, const PatchArg *a, int n)
{
    auto *o = static_cast<AudioEffectDigitalCombine *>(s);
    if (m == "setCombineMode") {
        if (n != 1) return APPLY_BAD_ARGS;
        int mode = -1;
        if (a[0].isNumber) mode = (int)a[0].num;
        else if (a[0].token == "OR") mode = AudioEffectDigitalCombine::OR;
        else if (a[0].token == "XOR") mode = AudioEffectDigitalCombine::XOR;
        else if (a[0].token == "AND") mode = AudioEffectDigitalCombine::AND;
        else if (a[0].token == "MODULO") mode = AudioEffectDigitalCombine::MODULO;
        if (mode < 0 || mode > 3) return APPLY_BAD_ARGS;
        o->setCombineMode(mode);
        return APPLY_OK;
    }
    return APPLY_UNKNOWN_METHOD;
}

static ApplyResult applyBiquad(AudioStream *s, const String &m, const PatchArg *a, int n)
{
    auto *o = static_cast<AudioFilterBiquad *>(s);
    float v[4];
    bool three = nums(a, n, 3, v);
    bool four  = !three && nums(a, n, 4, v);
    if (m == "setLowpass" || m == "setHighpass" || m == "setBandpass" || m == "setNotch") {
        if (!three) return APPLY_BAD_ARGS;
        int stage = (int)v[0];
        if (stage < 0 || stage > 3) return APPLY_BAD_ARGS;
        float f = clampf(v[1], 1.0f, 20000.0f);
        float q = clampf(v[2], 0.02f, 20.0f);
        if (m == "setLowpass")  o->setLowpass(stage, f, q);
        if (m == "setHighpass") o->setHighpass(stage, f, q);
        if (m == "setBandpass") o->setBandpass(stage, f, q);
        if (m == "setNotch")    o->setNotch(stage, f, q);
        return APPLY_OK;
    }
    if (m == "setLowShelf" || m == "setHighShelf") {
        if (!four) return APPLY_BAD_ARGS;
        int stage = (int)v[0];
        if (stage < 0 || stage > 3) return APPLY_BAD_ARGS;
        float f = clampf(v[1], 1.0f, 20000.0f);
        float g = clampf(v[2], -24.0f, 24.0f);
        float slope = clampf(v[3], 0.01f, 1.0f);
        if (m == "setLowShelf") o->setLowShelf(stage, f, g, slope);
        else o->setHighShelf(stage, f, g, slope);
        return APPLY_OK;
    }
    return APPLY_UNKNOWN_METHOD;
}

static ApplyResult applyStateVariable(AudioStream *s, const String &m, const PatchArg *a, int n)
{
    auto *o = static_cast<AudioFilterStateVariable *>(s);
    float v[1];
    if (!nums(a, n, 1, v)) return APPLY_BAD_ARGS;
    if (m == "frequency")     { o->frequency(clampf(v[0], 1.0f, 10000.0f)); return APPLY_OK; }
    if (m == "resonance")     { o->resonance(clampf(v[0], 0.7f, 5.0f));     return APPLY_OK; }
    if (m == "octaveControl") { o->octaveControl(clampf(v[0], 0.0f, 7.0f)); return APPLY_OK; }
    return APPLY_UNKNOWN_METHOD;
}

static ApplyResult applyLadder(AudioStream *s, const String &m, const PatchArg *a, int n)
{
    auto *o = static_cast<AudioFilterLadder *>(s);
    float v[1];
    if (!nums(a, n, 1, v)) return APPLY_BAD_ARGS;
    if (m == "frequency")     { o->frequency(clampf(v[0], 1.0f, 20000.0f)); return APPLY_OK; }
    if (m == "resonance")     { o->resonance(clampf(v[0], 0.0f, 1.8f));     return APPLY_OK; }
    if (m == "octaveControl") { o->octaveControl(clampf(v[0], 0.0f, 7.0f)); return APPLY_OK; }
    if (m == "inputDrive")    { o->inputDrive(clampf(v[0], 0.0f, 4.0f));    return APPLY_OK; }
    return APPLY_UNKNOWN_METHOD;
}

static ApplyResult applyWaveform(AudioStream *s, const String &m, const PatchArg *a, int n)
{
    auto *o = static_cast<AudioSynthWaveform *>(s);
    float v[2];
    if (m == "begin") {
        if (n != 3 || !a[0].isNumber || !a[1].isNumber) return APPLY_BAD_ARGS;
        short shape;
        if (!waveformToken(a[2], shape)) return APPLY_BAD_ARGS;
        o->begin(clampf(a[0].num, 0, 1), a[1].num, shape);
        return APPLY_OK;
    }
    if (!nums(a, n, 1, v)) return APPLY_BAD_ARGS;
    if (m == "amplitude")  { o->amplitude(clampf(v[0], 0, 1)); return APPLY_OK; }
    if (m == "frequency")  { o->frequency(v[0]);               return APPLY_OK; }
    if (m == "pulseWidth") { o->pulseWidth(clampf(v[0], 0, 1)); return APPLY_OK; }
    return APPLY_UNKNOWN_METHOD;
}

static ApplyResult applySine(AudioStream *s, const String &m, const PatchArg *a, int n)
{
    auto *o = static_cast<AudioSynthWaveformSine *>(s);
    float v[1];
    if (!nums(a, n, 1, v)) return APPLY_BAD_ARGS;
    if (m == "frequency") { o->frequency(v[0]); return APPLY_OK; }
    if (m == "amplitude") { o->amplitude(clampf(v[0], 0, 1)); return APPLY_OK; }
    return APPLY_UNKNOWN_METHOD;
}

static ApplyResult applyDc(AudioStream *s, const String &m, const PatchArg *a, int n)
{
    auto *o = static_cast<AudioSynthWaveformDc *>(s);
    float v[2];
    if (m == "amplitude") {
        if (nums(a, n, 1, v)) { o->amplitude(clampf(v[0], -1, 1)); return APPLY_OK; }
        if (nums(a, n, 2, v)) { o->amplitude(clampf(v[0], -1, 1), v[1]); return APPLY_OK; }
        return APPLY_BAD_ARGS;
    }
    return APPLY_UNKNOWN_METHOD;
}

static ApplyResult applyKarplus(AudioStream *s, const String &m, const PatchArg *a, int n)
{
    auto *o = static_cast<AudioSynthKarplusStrong *>(s);
    float v[2];
    if (m == "noteOn") {
        if (!nums(a, n, 2, v)) return APPLY_BAD_ARGS;
        o->noteOn(clampf(v[0], 20.0f, 5000.0f), clampf(v[1], 0.0f, 1.0f));
        return APPLY_OK;
    }
    if (m == "noteOff") {
        if (n != 0) return APPLY_BAD_ARGS;
        o->noteOff(0.5f);
        return APPLY_OK;
    }
    return APPLY_UNKNOWN_METHOD;
}

static ApplyResult applyDrum(AudioStream *s, const String &m, const PatchArg *a, int n)
{
    auto *o = static_cast<AudioSynthSimpleDrum *>(s);
    float v[1];
    if (m == "noteOn") { if (n != 0) return APPLY_BAD_ARGS; o->noteOn(); return APPLY_OK; }
    if (!nums(a, n, 1, v)) return APPLY_BAD_ARGS;
    if (m == "frequency") { o->frequency(clampf(v[0], 20.0f, 2000.0f)); return APPLY_OK; }
    if (m == "length")    { o->length((int32_t)clampf(v[0], 10.0f, 2000.0f)); return APPLY_OK; }
    if (m == "secondMix") { o->secondMix(clampf(v[0], 0.0f, 1.0f)); return APPLY_OK; }
    if (m == "pitchMod")  { o->pitchMod(clampf(v[0], 0.0f, 1.0f)); return APPLY_OK; }
    return APPLY_UNKNOWN_METHOD;
}

static ApplyResult applyModulated(AudioStream *s, const String &m, const PatchArg *a, int n)
{
    auto *o = static_cast<AudioSynthWaveformModulated *>(s);
    float v[1];
    if (m == "begin") {
        if (n != 3 || !a[0].isNumber || !a[1].isNumber) return APPLY_BAD_ARGS;
        short shape;
        if (!waveformToken(a[2], shape)) return APPLY_BAD_ARGS;
        o->begin(clampf(a[0].num, 0, 1), a[1].num, shape);
        return APPLY_OK;
    }
    if (!nums(a, n, 1, v)) return APPLY_BAD_ARGS;
    if (m == "amplitude")           { o->amplitude(clampf(v[0], 0, 1)); return APPLY_OK; }
    if (m == "frequency")           { o->frequency(v[0]); return APPLY_OK; }
    if (m == "frequencyModulation") { o->frequencyModulation(clampf(v[0], 0, 12)); return APPLY_OK; }
    if (m == "phaseModulation")     { o->phaseModulation(clampf(v[0], 0, 9000)); return APPLY_OK; }
    return APPLY_UNKNOWN_METHOD;
}

static ApplyResult applyPwm(AudioStream *s, const String &m, const PatchArg *a, int n)
{
    auto *o = static_cast<AudioSynthWaveformPWM *>(s);
    float v[1];
    if (!nums(a, n, 1, v)) return APPLY_BAD_ARGS;
    if (m == "amplitude") { o->amplitude(clampf(v[0], 0, 1)); return APPLY_OK; }
    if (m == "frequency") { o->frequency(v[0]); return APPLY_OK; }
    return APPLY_UNKNOWN_METHOD;
}

static ApplyResult applySweep(AudioStream *s, const String &m, const PatchArg *a, int n)
{
    auto *o = static_cast<AudioSynthToneSweep *>(s);
    float v[4];
    if (m == "play") {                       // immediate: play(amp, fromHz, toHz, ms)
        if (!nums(a, n, 4, v)) return APPLY_BAD_ARGS;
        o->play(clampf(v[0], 0, 1), (int)clampf(v[1], 20, 20000), (int)clampf(v[2], 20, 20000), clampf(v[3], 10, 5000) / 1000.0f);
        return APPLY_OK;
    }
    return APPLY_UNKNOWN_METHOD;             // sweep() is a voice extension handled by PatchManager
}

static ApplyResult applySdWav(AudioStream *s, const String &m, const PatchArg *a, int n)
{
    auto *o = static_cast<AudioPlaySdWav *>(s);
    if (m == "stop") { if (n != 0) return APPLY_BAD_ARGS; o->stop(); return APPLY_OK; }
    return APPLY_UNKNOWN_METHOD;             // file() is a voice extension handled by PatchManager
}

template <class T>
static ApplyResult applyNoise(AudioStream *s, const String &m, const PatchArg *a, int n)
{
    auto *o = static_cast<T *>(s);
    float v[1];
    if (m == "amplitude") {
        if (!nums(a, n, 1, v)) return APPLY_BAD_ARGS;
        o->amplitude(clampf(v[0], 0, 1));
        return APPLY_OK;
    }
    return APPLY_UNKNOWN_METHOD;
}

// ---------------------------------------------------------------------------
// the registry
// ---------------------------------------------------------------------------

template <class T>
static AudioStream *make() { return new (std::nothrow) T(); }

// Chorus / flange / granular leave their delay-line pointers UNINITIALIZED
// until begin() — running the audio ISR on one that a preset forgot to begin()
// reads wild pointers. So these factories begin() with safe defaults at
// creation; preset setters re-begin with their own values.
static AudioStream *makeChorus()
{
    auto *o = new (std::nothrow) AudioEffectChorus();
    if (!o) return nullptr;
    int16_t *dl = getDelayLine(o, CHORUS_SAMPLES);
    if (!dl) return nullptr;   // (o stays parked & inactive — never run unbegun)
    o->begin(dl, CHORUS_SAMPLES, 2);
    return o;
}

static AudioStream *makeFlange()
{
    auto *o = new (std::nothrow) AudioEffectFlange();
    if (!o) return nullptr;
    int16_t *dl = getDelayLine(o, FLANGE_SAMPLES);
    if (!dl) return nullptr;
    o->begin(dl, FLANGE_SAMPLES, FLANGE_USABLE / 2, FLANGE_USABLE / 4, 0.5f);
    return o;
}

static AudioStream *makeGranular()
{
    auto *o = new (std::nothrow) AudioEffectGranular();
    if (!o) return nullptr;
    uint32_t samples = (uint32_t)(200.0f * AUDIO_SAMPLE_RATE_EXACT / 1000.0f);
    int16_t *dl = getDelayLine(o, samples);
    if (!dl) return nullptr;
    o->begin(dl, samples);
    return o;
}

static const EffectInfo registry[] = {
    {"AudioAmplifier",            1, 1, make<AudioAmplifier>,            applyAmplifier},
    {"AudioMixer4",               4, 1, make<AudioMixer4>,               applyMixer4},
    {"AudioEffectFreeverb",       1, 1, make<AudioEffectFreeverb>,       applyFreeverb<AudioEffectFreeverb>},
    {"AudioEffectFreeverbStereo", 1, 2, make<AudioEffectFreeverbStereo>, applyFreeverb<AudioEffectFreeverbStereo>},
    {"AudioEffectChorus",         1, 1, makeChorus,                      applyChorus},
    {"AudioEffectFlange",         1, 1, makeFlange,                      applyFlange},
    {"AudioEffectDelay",          1, 8, make<AudioEffectDelay>,          applyDelay},
    {"AudioEffectBitcrusher",     1, 1, make<AudioEffectBitcrusher>,     applyBitcrusher},
    {"AudioEffectWaveshaper",     1, 1, make<AudioEffectWaveshaper>,     applyWaveshaper},
    {"AudioEffectGranular",       1, 1, makeGranular,                    applyGranular},
    {"AudioEffectEnvelope",       1, 1, make<AudioEffectEnvelope>,       applyEnvelope},
    {"AudioEffectMultiply",       2, 1, make<AudioEffectMultiply>,       applyNone},
    {"AudioEffectRectifier",      1, 1, make<AudioEffectRectifier>,      applyNone},
    {"AudioEffectWaveFolder",     2, 1, make<AudioEffectWaveFolder>,     applyNone},
    {"AudioEffectDigitalCombine", 2, 1, make<AudioEffectDigitalCombine>, applyCombine},
    {"AudioFilterBiquad",         1, 1, make<AudioFilterBiquad>,         applyBiquad},
    {"AudioFilterStateVariable",  2, 3, make<AudioFilterStateVariable>,  applyStateVariable},
    {"AudioFilterLadder",         3, 1, make<AudioFilterLadder>,         applyLadder},
    {"AudioSynthWaveform",        0, 1, make<AudioSynthWaveform>,        applyWaveform},
    {"AudioSynthWaveformSine",    0, 1, make<AudioSynthWaveformSine>,    applySine},
    {"AudioSynthWaveformDc",      0, 1, make<AudioSynthWaveformDc>,      applyDc},
    {"AudioSynthNoiseWhite",      0, 1, make<AudioSynthNoiseWhite>,      applyNoise<AudioSynthNoiseWhite>},
    {"AudioSynthNoisePink",       0, 1, make<AudioSynthNoisePink>,       applyNoise<AudioSynthNoisePink>},
    // instruments (playable via midi() binding — see PatchManager)
    {"AudioSynthKarplusStrong",   0, 1, make<AudioSynthKarplusStrong>,   applyKarplus},
    {"AudioSynthSimpleDrum",      0, 1, make<AudioSynthSimpleDrum>,      applyDrum},
    {"AudioSynthWaveformModulated", 2, 1, make<AudioSynthWaveformModulated>, applyModulated},
    {"AudioSynthWaveformPWM",     1, 1, make<AudioSynthWaveformPWM>,     applyPwm},
    {"AudioSynthToneSweep",       0, 1, make<AudioSynthToneSweep>,       applySweep},
    {"AudioPlaySdWav",            0, 2, make<AudioPlaySdWav>,            applySdWav},
};

const EffectInfo *effectRegistryFind(const String &typeName)
{
    for (auto &e : registry) {
        if (typeName.equals(e.typeName)) return &e;
    }
    return nullptr;
}
