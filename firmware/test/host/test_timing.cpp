// Host-side unit tests for the musical looping timing logic.
//
// LooperTiming and MidiClockIn are portable (no Arduino), so the actual
// engine code that runs inside the audio ISR is compiled here unchanged and
// driven with a deterministic fake clock: advance() is fed 128-sample blocks
// and every event's absolute sample time is recorded; MidiClockIn is fed
// hand-written microsecond timestamps.
//
// Run: firmware/test/host/run.sh

#include "../../src/LooperTiming.h"
#include "../../src/MidiClockIn.h"

#include <cstdint>
#include <cstdio>
#include <vector>

static int failures = 0, checks = 0;
#define CHECK(cond) do { checks++; if (!(cond)) { \
    failures++; std::printf("FAIL %s:%d  %s\n", __FILE__, __LINE__, #cond); } } while (0)
#define CHECK_EQ(a, b) do { checks++; long long _a = (long long)(a), _b = (long long)(b); \
    if (_a != _b) { failures++; std::printf("FAIL %s:%d  %s == %s  (%lld != %lld)\n", \
        __FILE__, __LINE__, #a, #b, _a, _b); } } while (0)

static const uint32_t BLK = 128;          // AUDIO_BLOCK_SAMPLES on the Teensy

// Drives the engine block by block and records event times on an absolute
// sample clock, exactly as the looper's update() would see them.
struct Run {
    LooperTiming &t;
    uint64_t now = 0;
    std::vector<uint64_t> clicks;
    std::vector<bool> accents;
    long long startAt = -1, stopAt = -1;
    bool cancelled = false;

    explicit Run(LooperTiming &tt) : t(tt) {}

    LooperTiming::Action step()
    {
        LooperTiming::Action a = t.advance(BLK);
        if (a.clickAt >= 0) { clicks.push_back(now + (uint32_t)a.clickAt); accents.push_back(a.accent); }
        if (a.startRecordAt >= 0) startAt = (long long)(now + (uint32_t)a.startRecordAt);
        if (a.stopRecordAt >= 0) stopAt = (long long)(now + (uint32_t)a.stopRecordAt);
        if (a.cancelled) cancelled = true;
        now += BLK;
        return a;
    }

    void run(uint32_t blocks) { for (uint32_t i = 0; i < blocks; i++) step(); }

    // Run until pred() or the block budget runs out; returns true if pred hit.
    template <class F> bool until(F pred, uint32_t maxBlocks = 200000)
    {
        for (uint32_t i = 0; i < maxBlocks; i++) { step(); if (pred()) return true; }
        return false;
    }
};

// Simulates a DAW's clock at the engine boundary: a beat event lands at the
// start of the block whose first sample is the beat (spb kept a multiple of
// BLK so expectations are exact).
struct ExtDriver {
    Run &r;
    uint32_t spb;
    uint64_t nextBeat;
    ExtDriver(Run &rr, uint32_t s, uint64_t firstBeat) : r(rr), spb(s), nextBeat(firstBeat) {}
    void pump(uint32_t blocks)
    {
        for (uint32_t i = 0; i < blocks; i++) {
            if (r.now == nextBeat) { r.t.extBeat(spb); nextBeat += spb; }
            r.step();
        }
    }
};

// ---------------------------------------------------------------- LooperTiming

static void test_manual_legacy()
{
    LooperTiming t;                       // mode defaults to MODE_OFF
    t.setCapacity(4000000);
    CHECK_EQ(t.armRecord(), LooperTiming::REQ_IMMEDIATE);
    CHECK_EQ(t.requestStopRecord(), LooperTiming::REQ_IMMEDIATE);
    Run r(t);
    r.run(1000);
    CHECK_EQ(r.clicks.size(), 0);
    CHECK_EQ(r.startAt, -1);
    CHECK_EQ(r.stopAt, -1);
    CHECK_EQ(t.phase(), LooperTiming::PH_IDLE);
}

static void test_internal_immediate_start()
{
    LooperTiming t;
    t.setMode(LooperTiming::MODE_BAR);
    t.setSamplesPerBeat(22050);           // 120 BPM
    t.setCountInBars(0);
    t.setCapacity(4000000);
    Run r(t);
    r.run(7);                             // arbitrary idle time before the tap
    uint64_t tap = r.now;
    CHECK_EQ(t.armRecord(), LooperTiming::REQ_ACCEPTED);
    r.step();
    CHECK_EQ(r.startAt, (long long)tap);  // starts at the very next block boundary
    CHECK_EQ(t.phase(), LooperTiming::PH_RECORDING);
}

static void test_internal_count_in_exact()
{
    LooperTiming t;
    t.setMode(LooperTiming::MODE_BAR);
    t.setSamplesPerBeat(22050);
    t.setBeatsPerBar(4);
    t.setCountInBars(1);
    t.setCapacity(8000000);
    Run r(t);
    r.run(13);
    uint64_t tap = r.now;
    CHECK_EQ(t.armRecord(), LooperTiming::REQ_ACCEPTED);
    CHECK_EQ(t.phase(), LooperTiming::PH_COUNT_IN);
    CHECK(r.until([&] { return r.startAt >= 0; }, 2000));
    // count-in is exactly one bar: 4 * 22050 samples after the tap
    CHECK_EQ(r.startAt - (long long)tap, 4 * 22050);
    // clicks on every count-in beat, the first one accented, plus the downbeat
    CHECK(r.clicks.size() >= 4);
    for (int i = 0; i < 4; i++) {
        CHECK_EQ(r.clicks[i] - tap, (uint64_t)i * 22050);
        CHECK_EQ(r.accents[i], i == 0);
    }
}

static void test_internal_two_bar_count_in()
{
    LooperTiming t;
    t.setMode(LooperTiming::MODE_BEAT);
    t.setSamplesPerBeat(29400);           // 90 BPM
    t.setBeatsPerBar(4);
    t.setCountInBars(2);
    t.setCapacity(8000000);
    Run r(t);
    uint64_t tap = r.now;
    CHECK_EQ(t.armRecord(), LooperTiming::REQ_ACCEPTED);
    CHECK(r.until([&] { return r.startAt >= 0; }, 4000));
    CHECK_EQ(r.startAt - (long long)tap, 2 * 4 * 29400);
    CHECK_EQ(r.clicks.size(), 8 + 1);     // 8 count-in clicks + the downbeat click
}

static void test_internal_fixed_bars_exact()
{
    LooperTiming t;
    t.setMode(LooperTiming::MODE_BAR);
    t.setSamplesPerBeat(22050);
    t.setBeatsPerBar(4);
    t.setCountInBars(0);
    t.setRecordBars(2);
    t.setCapacity(8000000);
    Run r(t);
    CHECK_EQ(t.armRecord(), LooperTiming::REQ_ACCEPTED);
    CHECK(r.until([&] { return r.stopAt >= 0; }, 4000));
    CHECK(r.startAt >= 0);
    // the loop closes after exactly 2 bars of samples
    CHECK_EQ(r.stopAt - r.startAt, 2 * 4 * 22050);
    CHECK_EQ(t.phase(), LooperTiming::PH_IDLE);
}

static void test_internal_quantised_manual_stop()
{
    LooperTiming t;
    t.setMode(LooperTiming::MODE_BAR);
    t.setSamplesPerBeat(22050);
    t.setBeatsPerBar(4);
    t.setCountInBars(0);
    t.setRecordBars(0);                   // free length
    t.setCapacity(8000000);
    Run r(t);
    CHECK_EQ(t.armRecord(), LooperTiming::REQ_ACCEPTED);
    r.step();                             // recording starts
    CHECK(r.startAt >= 0);
    r.run(1000);                          // ~2.9 s into bar 2
    uint64_t reqAt = r.now;
    CHECK_EQ(t.requestStopRecord(), LooperTiming::REQ_ACCEPTED);
    CHECK_EQ(t.requestStopRecord(), LooperTiming::REQ_IGNORED);   // double tap: no-op
    CHECK(r.until([&] { return r.stopAt >= 0; }, 4000));
    uint64_t len = (uint64_t)(r.stopAt - r.startAt);
    uint64_t bar = 4 * 22050;
    CHECK_EQ(len % bar, 0);               // a whole number of bars...
    CHECK(len >= reqAt - (uint64_t)r.startAt);            // ...at or after the tap
    CHECK(len < (reqAt - (uint64_t)r.startAt) + bar + 1); // ...and within one bar of it
}

static void test_internal_beat_mode_stop()
{
    LooperTiming t;
    t.setMode(LooperTiming::MODE_BEAT);
    t.setSamplesPerBeat(22050);
    t.setCountInBars(0);
    t.setCapacity(8000000);
    Run r(t);
    t.armRecord();
    r.step();
    r.run(300);                           // mid-beat 2
    t.requestStopRecord();
    CHECK(r.until([&] { return r.stopAt >= 0; }, 1000));
    CHECK_EQ((r.stopAt - r.startAt) % 22050, 0);          // whole beats
    CHECK_EQ(r.stopAt - r.startAt, 2 * 22050);
}

static void test_capacity_bounds()
{
    // fixed length longer than the buffer: the schedule clamps to capacity
    LooperTiming t;
    t.setMode(LooperTiming::MODE_BAR);
    t.setSamplesPerBeat(22050);
    t.setBeatsPerBar(4);
    t.setCountInBars(0);
    t.setRecordBars(64);
    t.setCapacity(200000);                // ~4.5 s — far less than 64 bars
    Run r(t);
    t.armRecord();
    CHECK(r.until([&] { return r.stopAt >= 0; }, 10000));
    CHECK_EQ(r.stopAt - r.startAt, 200000);

    // quantised manual stop past the end of the buffer clamps the same way
    LooperTiming t2;
    t2.setMode(LooperTiming::MODE_BAR);
    t2.setSamplesPerBeat(22050);
    t2.setBeatsPerBar(4);
    t2.setCountInBars(0);
    t2.setCapacity(90000);                // just over one bar
    Run r2(t2);
    t2.armRecord();
    r2.step();
    r2.run(700);                          // ~89.6k samples in — past the only bar line that fits
    t2.requestStopRecord();               // next bar would be 176400 > capacity
    CHECK(r2.until([&] { return r2.stopAt >= 0; }, 1000));
    CHECK_EQ(r2.stopAt - r2.startAt, 90000);
}

static void test_cancel_and_config_change()
{
    LooperTiming t;
    t.setMode(LooperTiming::MODE_BAR);
    t.setSamplesPerBeat(22050);
    t.setCountInBars(1);
    t.setCapacity(8000000);
    Run r(t);
    t.armRecord();
    r.run(100);
    t.cancel();                           // tap STOP during the count-in
    r.step();
    CHECK(r.cancelled);
    CHECK_EQ(t.phase(), LooperTiming::PH_IDLE);
    CHECK_EQ(r.startAt, -1);

    // a mode change while armed abandons the arm too
    Run r2(t);
    t.armRecord();
    r2.run(10);
    t.setMode(LooperTiming::MODE_OFF);
    r2.step();
    CHECK(r2.cancelled);
    CHECK_EQ(r2.startAt, -1);
}

static void test_external_arm_next_beat_and_bar()
{
    const uint32_t SPB = 22016;           // ~120 BPM, a multiple of the block size
    LooperTiming t;
    t.setMode(LooperTiming::MODE_BEAT);
    t.setSource(LooperTiming::SRC_MIDI);
    t.setCountInBars(0);
    t.setSamplesPerBeat(SPB);
    t.setCapacity(8000000);
    Run r(t);
    ExtDriver clk(r, SPB, 0);
    t.extStart();
    clk.pump(SPB / BLK * 2 + 40);         // two beats plus a bit
    uint64_t armAt = r.now;               // mid-beat
    CHECK_EQ(t.armRecord(), LooperTiming::REQ_ACCEPTED);
    while (r.startAt < 0) clk.pump(1);
    // recording starts exactly on the next external beat
    CHECK_EQ((uint64_t)r.startAt % SPB, 0);
    CHECK((uint64_t)r.startAt > armAt);
    CHECK((uint64_t)r.startAt - armAt <= SPB);

    // bar mode: the start waits for the next bar line (beat 0, 4, 8, ...)
    LooperTiming t2;
    t2.setMode(LooperTiming::MODE_BAR);
    t2.setSource(LooperTiming::SRC_MIDI);
    t2.setBeatsPerBar(4);
    t2.setCountInBars(0);
    t2.setSamplesPerBeat(SPB);
    t2.setCapacity(8000000);
    Run r2(t2);
    ExtDriver clk2(r2, SPB, 0);
    t2.extStart();
    clk2.pump(SPB / BLK + 40);            // one beat and a bit: mid-bar
    CHECK_EQ(t2.armRecord(), LooperTiming::REQ_ACCEPTED);
    while (r2.startAt < 0) clk2.pump(1);
    CHECK_EQ((uint64_t)r2.startAt % (4 * (uint64_t)SPB), 0);   // a bar line
    CHECK_EQ((uint64_t)r2.startAt, 4 * (uint64_t)SPB);         // the next one
}

static void test_external_count_in()
{
    const uint32_t SPB = 22016;
    LooperTiming t;
    t.setMode(LooperTiming::MODE_BAR);
    t.setSource(LooperTiming::SRC_MIDI);
    t.setBeatsPerBar(4);
    t.setCountInBars(1);
    t.setSamplesPerBeat(SPB);
    t.setCapacity(8000000);
    Run r(t);
    ExtDriver clk(r, SPB, 0);
    t.extStart();
    clk.pump(SPB / BLK + 40);             // mid-bar 1
    CHECK_EQ(t.armRecord(), LooperTiming::REQ_ACCEPTED);
    while (r.startAt < 0) clk.pump(1);
    // aligns to the bar line at 4*SPB, counts one bar, records from 8*SPB
    CHECK_EQ((uint64_t)r.startAt, 8 * (uint64_t)SPB);
}

static void test_external_fixed_bars_and_clock_loss()
{
    const uint32_t SPB = 22016;
    LooperTiming t;
    t.setMode(LooperTiming::MODE_BAR);
    t.setSource(LooperTiming::SRC_MIDI);
    t.setBeatsPerBar(4);
    t.setCountInBars(0);
    t.setRecordBars(2);
    t.setSamplesPerBeat(SPB);
    t.setCapacity(8000000);
    Run r(t);
    ExtDriver clk(r, SPB, 0);
    t.extStart();
    clk.pump(10);
    t.armRecord();
    while (r.startAt < 0) clk.pump(1);
    // the clock dies one beat into the take; MIDI Stop follows (as a DAW does)
    clk.pump(SPB / BLK + 4);
    t.extStop();
    // ...but the fixed 2-bar take still closes, on the flywheel, at the right length
    CHECK(r.until([&] { return r.stopAt >= 0; }, 20000));
    CHECK_EQ(r.stopAt - r.startAt, 2 * 4 * (long long)SPB);
    CHECK_EQ(t.phase(), LooperTiming::PH_IDLE);
}

static void test_external_stop_cancels_arm()
{
    const uint32_t SPB = 22016;
    LooperTiming t;
    t.setMode(LooperTiming::MODE_BAR);
    t.setSource(LooperTiming::SRC_MIDI);
    t.setCountInBars(1);
    t.setSamplesPerBeat(SPB);
    t.setCapacity(8000000);
    Run r(t);
    ExtDriver clk(r, SPB, 0);
    t.extStart();
    clk.pump(20);
    CHECK_EQ(t.armRecord(), LooperTiming::REQ_ACCEPTED);
    clk.pump(20);
    t.extStop();                          // MIDI Stop / clock lost while counting in
    r.step();
    CHECK(r.cancelled);
    CHECK_EQ(t.phase(), LooperTiming::PH_IDLE);
    CHECK_EQ(r.startAt, -1);              // recording never started

    // with no clock running any more, further taps are refused (never a
    // surprise unsynchronised take)
    CHECK_EQ(t.armRecord(), LooperTiming::REQ_REFUSED);
}

static void test_external_no_clock_refused()
{
    // sync to MIDI clock was requested but no Start ever arrived: taps must be
    // refused outright, not degrade into an unsynchronised recording
    LooperTiming t;
    t.setMode(LooperTiming::MODE_BAR);
    t.setSource(LooperTiming::SRC_MIDI);
    t.setSamplesPerBeat(22016);
    t.setCapacity(8000000);
    CHECK_EQ(t.armRecord(), LooperTiming::REQ_REFUSED);
    CHECK_EQ(t.phase(), LooperTiming::PH_IDLE);
    Run r(t);
    r.run(50);
    CHECK_EQ(r.startAt, -1);

    // ...and again after the clock ran and then was lost (timeout path calls
    // extStop, same as a MIDI Stop)
    t.extStart();
    t.extBeat(22016);
    r.run(10);
    t.extStop();
    CHECK_EQ(t.armRecord(), LooperTiming::REQ_REFUSED);

    // a new Start makes arming work again
    t.extStart();
    CHECK_EQ(t.armRecord(), LooperTiming::REQ_ACCEPTED);
}

static void test_internal_established_grid_arm()
{
    // met "on": the metronome grid runs while idle; arming rides it — the
    // take starts on the grid's next boundary and the click never shifts
    const uint32_t SPB = 22050;
    LooperTiming t;
    t.setMode(LooperTiming::MODE_BEAT);
    t.setMetronome(LooperTiming::MET_ON);
    t.setSamplesPerBeat(SPB);
    t.setCountInBars(0);
    t.setCapacity(8000000);
    Run r(t);
    r.run(400);                           // grid establishes at r.now == 0; ~2 beats pass
    CHECK(r.clicks.size() >= 2);
    uint64_t armAt = r.now;               // mid-beat 3
    CHECK_EQ(t.armRecord(), LooperTiming::REQ_ACCEPTED);
    CHECK(r.until([&] { return r.startAt >= 0; }, 2000));
    CHECK((uint64_t)r.startAt > armAt);   // NOT immediate: waits for the boundary
    CHECK_EQ((uint64_t)r.startAt % SPB, 0);
    CHECK_EQ((uint64_t)r.startAt, 3 * (uint64_t)SPB);     // the next grid beat
    for (size_t i = 0; i < r.clicks.size(); i++)          // clicks never shifted
        CHECK_EQ(r.clicks[i] % SPB, 0);

    // bar mode: same, but the start waits for the grid's next bar line
    LooperTiming t2;
    t2.setMode(LooperTiming::MODE_BAR);
    t2.setMetronome(LooperTiming::MET_ON);
    t2.setBeatsPerBar(4);
    t2.setSamplesPerBeat(SPB);
    t2.setCountInBars(0);
    t2.setCapacity(8000000);
    Run r2(t2);
    r2.run(400);                          // mid-bar 1
    CHECK_EQ(t2.armRecord(), LooperTiming::REQ_ACCEPTED);
    CHECK(r2.until([&] { return r2.startAt >= 0; }, 4000));
    CHECK_EQ((uint64_t)r2.startAt, 4 * (uint64_t)SPB);    // the next bar line

    // count-in on an established grid: align to the next bar line, count one
    // bar, record from the bar line after it
    LooperTiming t3;
    t3.setMode(LooperTiming::MODE_BAR);
    t3.setMetronome(LooperTiming::MET_ON);
    t3.setBeatsPerBar(4);
    t3.setSamplesPerBeat(SPB);
    t3.setCountInBars(1);
    t3.setCapacity(8000000);
    Run r3(t3);
    r3.run(400);
    CHECK_EQ(t3.armRecord(), LooperTiming::REQ_ACCEPTED);
    CHECK(r3.until([&] { return r3.startAt >= 0; }, 8000));
    CHECK_EQ((uint64_t)r3.startAt, 8 * (uint64_t)SPB);    // bar 2 line + 1 bar

    // cancelling an arm must not stop the idle metronome
    LooperTiming t4;
    t4.setMode(LooperTiming::MODE_BEAT);
    t4.setMetronome(LooperTiming::MET_ON);
    t4.setSamplesPerBeat(SPB);
    t4.setCountInBars(0);
    t4.setCapacity(8000000);
    Run r4(t4);
    r4.run(10);
    t4.armRecord();
    t4.cancel();
    size_t before = r4.clicks.size();
    r4.run(SPB / 128 + 2);                // one more beat's worth
    CHECK(r4.clicks.size() > before);     // still clicking, unshifted
    CHECK_EQ(r4.clicks.back() % SPB, 0);
}

static void test_external_beat_dedupe()
{
    // a tick that arrives a couple of blocks after the flywheel already fired
    // the beat must not fire it twice
    const uint32_t SPB = 22016;
    LooperTiming t;
    t.setMode(LooperTiming::MODE_BAR);
    t.setSource(LooperTiming::SRC_MIDI);
    t.setMetronome(LooperTiming::MET_ON);   // click on every grid beat
    t.setCountInBars(0);
    t.setSamplesPerBeat(SPB);
    t.setCapacity(8000000);
    Run r(t);
    t.extStart();
    t.extBeat(SPB);                       // downbeat
    r.step();
    uint32_t blocksPerBeat = SPB / BLK;
    r.run(blocksPerBeat - 1);             // flywheel fires beat 2 on time...
    r.run(2);
    t.extBeat(SPB);                       // ...and the real tick shows up late
    r.step();
    r.run(4);
    CHECK_EQ(r.clicks.size(), 2);         // beat 1 + beat 2, no duplicate
}

// ----------------------------------------------------------------- MidiClockIn

static void test_midiclock_tempo_and_beats()
{
    MidiClockIn c;
    const uint32_t TICK = 20833;          // 120 BPM
    uint32_t now = 1000;
    c.onStart(now);
    CHECK(c.running());
    int beats = 0;
    for (int i = 0; i < 96; i++) {        // four beats of ticks
        bool b = c.onTick(now);
        if (b) { CHECK_EQ(i % 24, 0); beats++; }
        now += TICK;
    }
    CHECK_EQ(beats, 4);
    uint32_t spb = c.samplesPerBeat();
    CHECK(spb >= 22045 && spb <= 22055);  // ~22050 at 44.1 kHz

    // a single garbled timestamp must not fling the tempo
    c.onTick(now); now += 100;            // 100 us gap: impossible, ignored
    c.onTick(now); now += TICK;
    spb = c.samplesPerBeat();
    CHECK(spb >= 21500 && spb <= 22600);
}

static void test_midiclock_stop_continue()
{
    MidiClockIn c;
    const uint32_t TICK = 20833;
    uint32_t now = 0;
    c.onStart(now);
    for (int i = 0; i < 30; i++) { c.onTick(now); now += TICK; }   // 6 ticks into beat 2
    c.onStop();
    CHECK(!c.running());
    CHECK(!c.onTick(now));                // ticks while stopped are ignored
    now += 1000000;
    c.onContinue(now);
    CHECK(c.running());
    // the tick count resumes: the next beat lands 18 ticks in
    int firstBeatTick = -1;
    for (int i = 0; i < 24; i++) {
        if (c.onTick(now) && firstBeatTick < 0) firstBeatTick = i;
        now += TICK;
    }
    CHECK_EQ(firstBeatTick, 18);
}

static void test_midiclock_timeout()
{
    MidiClockIn c;
    uint32_t now = 0;
    c.onStart(now);
    for (int i = 0; i < 24; i++) { c.onTick(now); now += 20833; }
    CHECK(!c.checkTimeout(now + 400000));           // still within the window
    CHECK(c.checkTimeout(now + 600000));            // gone: reported exactly once
    CHECK(!c.checkTimeout(now + 700000));
    CHECK_EQ(c.state(), MidiClockIn::CLK_LOST);
    c.onStart(now + 800000);                        // a new Start recovers
    CHECK(c.running());
}

int main()
{
    test_manual_legacy();
    test_internal_immediate_start();
    test_internal_count_in_exact();
    test_internal_two_bar_count_in();
    test_internal_fixed_bars_exact();
    test_internal_quantised_manual_stop();
    test_internal_beat_mode_stop();
    test_capacity_bounds();
    test_cancel_and_config_change();
    test_external_arm_next_beat_and_bar();
    test_external_count_in();
    test_external_fixed_bars_and_clock_loss();
    test_external_stop_cancels_arm();
    test_external_no_clock_refused();
    test_internal_established_grid_arm();
    test_external_beat_dedupe();
    test_midiclock_tempo_and_beats();
    test_midiclock_stop_continue();
    test_midiclock_timeout();

    std::printf("%d checks, %d failure%s\n", checks, failures, failures == 1 ? "" : "s");
    return failures ? 1 : 0;
}
