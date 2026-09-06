// Host-side tests for AudioEffectLooper itself — the real ISR code, compiled
// unchanged against the shims in shim/ (a fake AudioStream whose block
// plumbing the test drives, and malloc standing in for EXTMEM). These verify
// the *looper's* recorded sample lengths and state transitions, not just the
// timing engine's expectations: same-block config+arm ordering, exact
// count-in and fixed-bar loop lengths, quantised closes, cancellation, the
// MIDI-no-clock refusal, and that sync can never destroy an existing loop.
//
// Run: firmware/test/host/run.sh

#include <AudioStream.h>                  // the shim (via -Ishim)
#include "../../src/AudioEffectLooper.h"

#include <cstdint>
#include <cstdio>
#include <cstdlib>

// EXTMEM stand-ins: "2 MB PSRAM" → 522 240 samples (~11.8 s) of loop capacity.
extern "C" {
uint8_t external_psram_size = 2;
void *extmem_malloc(size_t n) { return malloc(n); }
void extmem_free(void *p) { free(p); }
}

static int failures = 0, checks = 0;
#define CHECK(cond) do { checks++; if (!(cond)) { \
    failures++; std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); } } while (0)
#define CHECK_EQ(a, b) do { checks++; long long _a = (long long)(a), _b = (long long)(b); \
    if (_a != _b) { failures++; std::printf("FAIL %s:%d  %s == %s  (%lld != %lld)\n", \
        __FILE__, __LINE__, #a, #b, _a, _b); } } while (0)

// Drives the looper exactly as the audio interrupt would: one input block per
// update(), 128 samples at a time.
struct Rig {
    AudioEffectLooper lp;
    Rig()
    {
        if (!lp.begin()) { std::printf("FATAL: looper begin() failed\n"); std::exit(2); }
    }
    void step(int16_t fill = 1000)
    {
        for (int i = 0; i < AUDIO_BLOCK_SAMPLES; i++) shimIn.data[i] = fill;
        shimHaveIn = true;
        shimTransmitted = false;
        lp.update();
    }
    void run(int blocks) { while (blocks--) step(); }
    bool untilState(AudioEffectLooper::State s, int maxBlocks)
    {
        for (int i = 0; i < maxBlocks; i++) { step(); if (lp.state() == s) return true; }
        return false;
    }
};

static void test_legacy_manual_lengths()
{
    Rig r;
    r.lp.tapLoop();
    r.step();
    CHECK_EQ(r.lp.state(), AudioEffectLooper::RECORDING);   // no sync: records right now
    r.run(399);                                             // 400 blocks recorded
    r.lp.tapLoop();
    r.step();
    CHECK_EQ(r.lp.state(), AudioEffectLooper::PLAYING);
    CHECK_EQ(r.lp.lengthSamples(), 400u * AUDIO_BLOCK_SAMPLES);   // closed where tapped
}

static void test_same_block_config_and_arm()
{
    // The editor posts `sync mode bar` and `looper tap` back to back; both can
    // land before the same audio block. The tap must see the NEW config —
    // staged settings apply before commands are interpreted.
    Rig r;
    r.lp.syncSetMode(LooperTiming::MODE_BAR);
    r.lp.syncSetSamplesPerBeat(22050);
    r.lp.syncSetCountIn(1);
    r.lp.tapLoop();
    r.step();
    CHECK_EQ(r.lp.state(), AudioEffectLooper::COUNT_IN);    // not an immediate RECORDING
}

static void test_countin_and_fixed_bars_exact_length()
{
    Rig r;
    r.lp.syncSetMode(LooperTiming::MODE_BAR);
    r.lp.syncSetSamplesPerBeat(22050);                      // 120 BPM
    r.lp.syncSetCountIn(1);
    r.lp.syncSetBars(2);
    r.lp.tapLoop();
    r.step();
    CHECK_EQ(r.lp.state(), AudioEffectLooper::COUNT_IN);
    CHECK(r.untilState(AudioEffectLooper::RECORDING, 800)); // one bar of count-in ≈ 689 blocks
    CHECK(r.untilState(AudioEffectLooper::PLAYING, 3000));  // the take closes itself
    CHECK_EQ(r.lp.lengthSamples(), 2u * 4u * 22050u);       // exactly 2 bars of samples
}

static void test_quantised_manual_close_length()
{
    Rig r;
    r.lp.syncSetMode(LooperTiming::MODE_BEAT);
    r.lp.syncSetSamplesPerBeat(22050);
    r.lp.syncSetCountIn(0);
    r.lp.syncSetBars(0);                                    // free length
    r.lp.tapLoop();
    r.step();
    CHECK_EQ(r.lp.state(), AudioEffectLooper::RECORDING);   // fresh grid: tap = downbeat
    r.run(299);                                             // 300 blocks = 38 400 samples in
    r.lp.tapLoop();                                         // close on the next beat
    CHECK(r.untilState(AudioEffectLooper::PLAYING, 100));
    CHECK_EQ(r.lp.lengthSamples(), 2u * 22050u);            // rounded up to whole beats
}

static void test_stop_cancels_armed_take()
{
    Rig r;
    r.lp.syncSetMode(LooperTiming::MODE_BAR);
    r.lp.syncSetSamplesPerBeat(22050);
    r.lp.syncSetCountIn(2);
    r.lp.tapLoop();
    r.step();
    CHECK_EQ(r.lp.state(), AudioEffectLooper::COUNT_IN);
    r.run(50);
    r.lp.tapStop();                                         // the unambiguous cancel
    r.step();
    CHECK_EQ(r.lp.state(), AudioEffectLooper::EMPTY);
    CHECK(!r.lp.hasLoop());                                 // nothing recorded, nothing kept
}

static void test_midi_no_clock_refused_and_loop_safe()
{
    // First lay down a loop the manual way.
    Rig r;
    r.lp.tapLoop(); r.step();
    r.run(399);
    r.lp.tapLoop(); r.step();
    CHECK_EQ(r.lp.state(), AudioEffectLooper::PLAYING);
    uint32_t len = r.lp.lengthSamples();

    // Asking for MIDI sync must not change what taps mean on a live loop —
    // and must never clear it.
    r.lp.syncSetMode(LooperTiming::MODE_BAR);
    r.lp.syncSetSource(LooperTiming::SRC_MIDI);
    r.lp.syncSetCountIn(0);
    r.lp.tapLoop(); r.step();
    CHECK_EQ(r.lp.state(), AudioEffectLooper::OVERDUBBING);
    r.lp.tapStop();                                         // finalize the dub and stop
    CHECK(r.untilState(AudioEffectLooper::STOPPED, 800));
    CHECK_EQ(r.lp.lengthSamples(), len);                    // the loop survived it all

    // Cleared and re-armed with no clock running: the tap is refused outright
    // (no surprise unsynchronised take), the looper simply stays empty.
    r.lp.clearLoop(); r.step();
    CHECK_EQ(r.lp.state(), AudioEffectLooper::EMPTY);
    r.lp.tapLoop();
    r.run(10);
    CHECK_EQ(r.lp.state(), AudioEffectLooper::EMPTY);

    // A running clock makes the same tap arm; losing it cancels the arm.
    // (Arm mid-bar — a tap in the same block as the Start's downbeat would
    // legitimately begin recording right there.)
    r.lp.syncExtStart();
    r.lp.syncExtBeat(22016);
    r.step();
    r.run(5);
    r.lp.tapLoop();
    r.step();
    CHECK_EQ(r.lp.state(), AudioEffectLooper::ARMED);
    r.lp.syncExtStop();                                     // MIDI Stop / clock lost
    r.step();
    CHECK_EQ(r.lp.state(), AudioEffectLooper::EMPTY);
}

int main()
{
    test_legacy_manual_lengths();
    test_same_block_config_and_arm();
    test_countin_and_fixed_bars_exact_length();
    test_quantised_manual_close_length();
    test_stop_cancels_armed_take();
    test_midi_no_clock_refused_and_loop_safe();

    std::printf("%d checks, %d failure%s\n", checks, failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
