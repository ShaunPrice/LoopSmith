#include "AudioEffectLooper.h"

extern "C" {
    void *extmem_malloc(size_t size);
    void extmem_free(void *ptr);
    extern uint8_t external_psram_size; // MB, probed by the startup code
}

static inline int16_t sat16(int32_t v)
{
    if (v > 32767) return 32767;
    if (v < -32768) return -32768;
    return (int16_t)v;
}

bool AudioEffectLooper::begin()
{
    uint32_t mb = external_psram_size;
    if (mb == 0) return false;

    // Two equal buffers, a small margin left for the allocator.
    uint32_t bytesPer = ((mb * 1048576u) / 2) - 4096;
    bufA = (int16_t *)extmem_malloc(bytesPer);
    bufB = (int16_t *)extmem_malloc(bytesPer);
    if (!bufA || !bufB) {
        if (bufA) extmem_free(bufA);
        if (bufB) extmem_free(bufB);
        bufA = bufB = nullptr;
        return false;
    }
    capacity = bytesPer / sizeof(int16_t);
    cur = bufA;
    alt = bufB;
    timing_.setCapacity(capacity);
    return true;
}

const char *AudioEffectLooper::stateName() const
{
    switch ((State)publicState) {
    case RECORDING:   return "recording";
    case PLAYING:     return "playing";
    case OVERDUBBING: return "overdubbing";
    case STOPPED:     return "stopped";
    case ARMED:       return "armed";
    case COUNT_IN:    return "countin";
    default:          return hasLoop() ? "stopped" : "empty";
    }
}

void AudioEffectLooper::swapBuffers()
{
    int16_t *t = cur;
    cur = alt;
    alt = t;
}

void AudioEffectLooper::applySeamFades()
{
    // The head of the initial recording was already ramped from zero while
    // recording; fading the tail to zero makes the seam continuous.
    if (length < 2 * RAMP) return;
    for (uint32_t k = 0; k < RAMP; k++) {
        uint32_t idx = length - 1 - k;
        cur[idx] = (int16_t)((int32_t)cur[idx] * (int32_t)k / (int32_t)RAMP);
    }
}

void AudioEffectLooper::closeRecording(uint8_t nextState)
{
    length = pos;
    applySeamFades();
    pos = 0;
    playRamp = RAMP;          // playback continues seamlessly, no fade-in
    if (nextState == OVERDUBBING) {
        passRemaining = length;
        rampPos = 0;
    }
    isrState = nextState;
}

const int16_t *AudioEffectLooper::exportData(uint32_t &len) const
{
    uint8_t s = isrPublic_;                 // raw state: a pending commit still swaps buffers
    if (!(s == PLAYING || s == STOPPED) || lengthSamples_ == 0) { len = 0; return nullptr; }
    len = lengthSamples_;
    return cur;
}

void AudioEffectLooper::handleCommand(uint8_t cmd)
{
    if (cmd & CMD_IMPORT) {
        timing_.reset();               // an imported loop supersedes any armed take
        uint32_t n = importLen_;
        if (n > capacity) n = capacity;
        if (n >= 2 * RAMP) {
            length = n;
            pos = 0;
            canUndo_ = false;
            playRamp = 0;
            isrState = STOPPED;
        }
        return;
    }
    if (busy_) {                           // a bulk copy is in progress: hold the command
        __atomic_or_fetch(&pendingCmd, cmd, __ATOMIC_ACQ_REL);
        return;
    }

    if (cmd & CMD_CLEAR) {
        timing_.reset();
        isrState = EMPTY;
        length = 0;
        pos = 0;
        canUndo_ = false;
        return;                            // clear wins over anything queued with it
    }

    if (cmd & CMD_UNDO) {
        if ((isrState == PLAYING || isrState == STOPPED) && canUndo_) {
            swapBuffers(); // undo <-> redo
        } else if (isrState == DUB_FINALIZE || isrState == STOP_COMMIT) {
            // run it as soon as the pending commit lands
            __atomic_or_fetch(&pendingCmd, (uint8_t)CMD_UNDO, __ATOMIC_ACQ_REL);
        }
    }

    if (cmd & CMD_TAP_STOP) {
        switch (isrState) {
        case RECORDING:
            timing_.notifyClosed();        // STOP always acts now, even mid-schedule
            if (pos >= MIN_LOOP) closeRecording(STOPPED);
            else { isrState = EMPTY; length = 0; pos = 0; }
            break;
        case ARMED:
        case COUNT_IN:
            // STOP is the unambiguous "never mind": abandon the armed take.
            timing_.cancel();
            isrState = EMPTY;
            length = 0;
            pos = 0;
            break;
        case PLAYING:
            isrState = STOPPING;
            break;
        case OVERDUBBING:
            // End the dub with its punch-out ramp (one DUB_FINALIZE block),
            // then the re-posted STOP lands us in STOP_COMMIT — the material
            // played so far is kept, never discarded.
            isrState = DUB_FINALIZE;
            rampOut = RAMP;
            __atomic_or_fetch(&pendingCmd, (uint8_t)CMD_TAP_STOP, __ATOMIC_ACQ_REL);
            break;
        case DUB_FINALIZE:
            // musically the dub already ended — finish its commit, keep it
            isrState = STOP_COMMIT;
            commitFade = true;
            break;
        case STOPPED:
            if (length) { pos = 0; playRamp = 0; isrState = PLAYING; }
            break;
        default: // STOPPING, STOP_COMMIT, EMPTY
            break;
        }
    }

    if (cmd & CMD_TAP_LOOP) {
        switch (isrState) {
        case EMPTY: {
            // With sync on the engine schedules the start (count-in / next
            // boundary); otherwise — or with no usable clock — record now.
            uint8_t r = timing_.armRecord();
            if (r == LooperTiming::REQ_ACCEPTED) {
                isrState = (timing_.phase() == LooperTiming::PH_COUNT_IN) ? COUNT_IN : ARMED;
                pos = 0;
                length = 0;
                canUndo_ = false;
            } else if (r == LooperTiming::REQ_IMMEDIATE) {
                startImmediateRecording();
            }
            break;
        }
        case ARMED:
        case COUNT_IN:
            break;                         // already armed; STOP cancels
        case RECORDING: {
            uint8_t r = timing_.requestStopRecord();
            if (r == LooperTiming::REQ_IMMEDIATE && pos >= MIN_LOOP) {
#if LOOPER_CLOSE_TO_OVERDUB
                closeRecording(OVERDUBBING);
#else
                closeRecording(PLAYING);
#endif
            }
            break;
        }
        case PLAYING:
            isrState = OVERDUBBING;
            passRemaining = length;
            rampPos = 0;
            break;
        case OVERDUBBING:
            isrState = DUB_FINALIZE;
            rampOut = RAMP;
            break;
        case DUB_FINALIZE:
        case STOP_COMMIT:
            // Defer: act once the pending commit has landed.
            __atomic_or_fetch(&pendingCmd, (uint8_t)CMD_TAP_LOOP, __ATOMIC_ACQ_REL);
            break;
        case STOPPED:
            if (length) { pos = 0; playRamp = 0; isrState = PLAYING; }
            break;
        default:
            break;
        }
    }
}

void AudioEffectLooper::update()
{
    audio_block_t *in = receiveReadOnly(0);

    if (capacity == 0) {           // no PSRAM — looper disabled
        if (in) release(in);
        return;
    }

    // Staged sync settings and clock events must land BEFORE commands are
    // interpreted: a config change and a record tap posted in the same block
    // (the editor does exactly this) must see the new mode/source/tempo.
    applySyncStaging();

    uint8_t cmd = __atomic_exchange_n(&pendingCmd, 0, __ATOMIC_ACQ_REL);
    if (cmd) handleCommand(cmd);

    // Advance the musical clock and act on what falls inside this block.
    LooperTiming::Action act = timing_.advance(AUDIO_BLOCK_SAMPLES);
    if (act.cancelled && (isrState == ARMED || isrState == COUNT_IN)) {
        isrState = EMPTY;   // clock loss / MIDI Stop / config change while armed
        length = 0;
        pos = 0;
    }
    if (act.startRecordAt >= 0 && (isrState == ARMED || isrState == COUNT_IN)) {
        startImmediateRecording();
        recStart_ = (uint32_t)act.startRecordAt;   // partial first block, sample exact
    }
    bool clickMixed = false;

    switch (isrState) {

    case EMPTY:
    case ARMED:
    case COUNT_IN:
    case STOPPED:
        break;

    case RECORDING: {
        uint32_t from = recStart_;         // an armed start records a partial first block
        recStart_ = 0;
        uint32_t upTo = AUDIO_BLOCK_SAMPLES;
        bool closing = false;
        if (act.stopRecordAt >= 0 && (uint32_t)act.stopRecordAt >= from) {
            upTo = (uint32_t)act.stopRecordAt;   // scheduled boundary close
            closing = true;
        }
        for (uint32_t i = from; i < upTo; i++) {
            int32_t s = in ? in->data[i] : 0;
            if (rampPos < RAMP) {
                s = s * (int32_t)rampPos / (int32_t)RAMP;
                rampPos++;
            }
            cur[pos + (i - from)] = (int16_t)s;
        }
        pos += upTo - from;
        if (closing) {
            closeRecording(PLAYING);
            // Play the rest of this block from the head of the fresh loop, so
            // the first pass's downbeat lands exactly on the grid.
            uint32_t rem = AUDIO_BLOCK_SAMPLES - upTo;
            if (rem && length) {
                uint32_t run = rem < length ? rem : length;
                audio_block_t *out = allocate();
                if (out) {
                    memset(out->data, 0, upTo * sizeof(int16_t));
                    memcpy(out->data + upTo, cur, run * sizeof(int16_t));
                    if (act.clickAt >= 0) startClick((uint32_t)act.clickAt, act.accent);
                    mixClickInto(out->data);
                    clickMixed = true;
                    transmit(out);
                    release(out);
                }
                pos = run < length ? run : 0;
            }
        } else if (pos + AUDIO_BLOCK_SAMPLES > capacity) {
            timing_.notifyClosed();
            closeRecording(PLAYING); // buffer full — close the loop automatically
        }
        break;
    }

    case PLAYING: {
        audio_block_t *out = allocate();
        uint32_t i = 0;
        while (i < AUDIO_BLOCK_SAMPLES) {
            uint32_t run = AUDIO_BLOCK_SAMPLES - i;
            uint32_t toWrap = length - pos;
            if (toWrap < run) run = toWrap;
            if (out) {
                if (playRamp < RAMP) {         // restart fade-in (no clicks)
                    for (uint32_t k = 0; k < run; k++) {
                        int32_t s = cur[pos + k];
                        if (playRamp < RAMP) {
                            s = s * (int32_t)playRamp / (int32_t)RAMP;
                            playRamp++;
                        }
                        out->data[i + k] = (int16_t)s;
                    }
                } else {
                    memcpy(out->data + i, cur + pos, run * sizeof(int16_t));
                }
            }
            i += run;
            pos += run;
            if (pos >= length) pos = 0;
        }
        if (out) { transmit(out); release(out); }
        break;
    }

    case STOP_COMMIT: {
        // The player stopped after ending a dub: finish copying the untouched
        // remainder of the loop into the scratch buffer at high speed (64
        // blocks per update ≈ 1.5 s worst case for a full 95 s loop), then
        // swap and rest in STOPPED. The first block plays a short fade-out.
        if (commitFade) {
            audio_block_t *out = allocate();
            uint32_t i = 0;
            while (i < AUDIO_BLOCK_SAMPLES && passRemaining > 0) {
                uint32_t run = AUDIO_BLOCK_SAMPLES - i;
                uint32_t toWrap = length - pos;
                if (toWrap < run) run = toWrap;
                if (passRemaining < run) run = passRemaining;
                for (uint32_t k = 0; k < run; k++, i++) {
                    int16_t s = cur[pos];
                    alt[pos] = s;
                    if (out) {
                        int32_t g = (int32_t)(AUDIO_BLOCK_SAMPLES - i);
                        out->data[i] = (int16_t)((int32_t)s * g / AUDIO_BLOCK_SAMPLES);
                    }
                    pos++;
                }
                if (pos >= length) pos = 0;
                passRemaining -= run;
            }
            if (out) {
                while (i < AUDIO_BLOCK_SAMPLES) out->data[i++] = 0;
                transmit(out);
                release(out);
            }
            commitFade = false;
        }
        uint32_t budget = COMMIT_CHUNK;
        while (budget > 0 && passRemaining > 0) {
            uint32_t run = budget;
            uint32_t toWrap = length - pos;
            if (toWrap < run) run = toWrap;
            if (passRemaining < run) run = passRemaining;
            memcpy(alt + pos, cur + pos, run * sizeof(int16_t));
            pos += run;
            if (pos >= length) pos = 0;
            passRemaining -= run;
            budget -= run;
        }
        if (passRemaining == 0) {
            swapBuffers();
            canUndo_ = true;
            isrState = STOPPED;
            pos = 0;
        }
        break;
    }

    case STOPPING: {
        // One-block fade to silence, then halt.
        audio_block_t *out = allocate();
        uint32_t i = 0;
        while (i < AUDIO_BLOCK_SAMPLES) {
            uint32_t run = AUDIO_BLOCK_SAMPLES - i;
            uint32_t toWrap = length - pos;
            if (toWrap < run) run = toWrap;
            for (uint32_t k = 0; k < run; k++, i++) {
                if (out) {
                    int32_t g = (int32_t)(AUDIO_BLOCK_SAMPLES - i);
                    out->data[i] = (int16_t)((int32_t)cur[pos + k] * g / AUDIO_BLOCK_SAMPLES);
                }
            }
            pos += run;
            if (pos >= length) pos = 0;
        }
        if (out) { transmit(out); release(out); }
        isrState = STOPPED;
        pos = 0;
        break;
    }

    case OVERDUBBING:
    case DUB_FINALIZE: {
        audio_block_t *out = allocate();
        uint32_t i = 0;
        while (i < AUDIO_BLOCK_SAMPLES) {
            uint32_t run = AUDIO_BLOCK_SAMPLES - i;
            uint32_t toWrap = length - pos;
            if (toWrap < run) run = toWrap;
            if (passRemaining < run) run = passRemaining;

            for (uint32_t k = 0; k < run; k++, i++) {
                int32_t inS = in ? in->data[i] : 0;
                if (isrState == OVERDUBBING) {
                    if (rampPos < RAMP) {           // punch-in ramp
                        inS = inS * (int32_t)rampPos / (int32_t)RAMP;
                        rampPos++;
                    }
                } else {                            // DUB_FINALIZE: punch-out ramp
                    if (rampOut > 0) {
                        inS = inS * (int32_t)rampOut / (int32_t)RAMP;
                        rampOut--;
                    } else {
                        inS = 0;
                    }
                }
                int16_t curS = cur[pos];
                alt[pos] = sat16((int32_t)curS + inS);
                if (out) out->data[i] = curS;
                pos++;
            }
            if (pos >= length) pos = 0;

            passRemaining -= run;
            if (passRemaining == 0) {
                // The scratch buffer now covers the whole loop: commit it.
                swapBuffers();
                canUndo_ = true;
                if (isrState == DUB_FINALIZE) {
                    isrState = PLAYING;
                    // remaining samples of this block play from the committed buffer
                } else {
                    passRemaining = length; // keep dubbing into the next pass
                }
            }
            if (isrState == PLAYING) {
                // finish the block as plain playback
                while (i < AUDIO_BLOCK_SAMPLES) {
                    uint32_t r2 = AUDIO_BLOCK_SAMPLES - i;
                    uint32_t w2 = length - pos;
                    if (w2 < r2) r2 = w2;
                    if (out) memcpy(out->data + i, cur + pos, r2 * sizeof(int16_t));
                    i += r2;
                    pos += r2;
                    if (pos >= length) pos = 0;
                }
                break;
            }
        }
        if (out) { transmit(out); release(out); }
        break;
    }
    }

    if (in) release(in);

    // Metronome click — audible only while no loop audio is playing (once the
    // loop runs, the loop itself is the timing reference).
    if (!clickMixed && clickEligible(isrState)) {
        if (act.clickAt >= 0) startClick((uint32_t)act.clickAt, act.accent);
        if (clickRemain_) emitClickBlock();
    } else if (!clickEligible(isrState)) {
        clickRemain_ = 0;                  // a click tail never bleeds into playback
    }

    isrPublic_ = isrState;
    uint8_t ps = isrState;
    if (ps == DUB_FINALIZE) ps = PLAYING; // the tap-out already happened, musically
    if (ps == STOPPING || ps == STOP_COMMIT) ps = STOPPED;
    publicState = ps;
    lengthSamples_ = length;
    posSamples_ = pos;
    syncPhase_ = (uint8_t)timing_.phase();
    syncBeat_ = timing_.currentBeat();
    syncSpb_ = timing_.samplesPerBeat();
}

void AudioEffectLooper::startImmediateRecording()
{
    isrState = RECORDING;
    pos = 0;
    length = 0;
    rampPos = 0;
    canUndo_ = false;
    recStart_ = 0;
}

// Copy staged sync settings and external clock events into the engine. All
// engine calls happen here, in the ISR — the UI/MIDI threads only bump the
// sequence bytes, so there are no cross-thread races inside LooperTiming.
void AudioEffectLooper::applySyncStaging()
{
    uint8_t s = cfgSeq_;
    if (s != cfgSeqSeen_) {
        cfgSeqSeen_ = s;
        timing_.setMode(cfgMode_);
        timing_.setSource(cfgSource_);
        timing_.setSamplesPerBeat(cfgSpb_);
        timing_.setCountInBars(cfgCountIn_);
        timing_.setRecordBars(cfgBars_);
        timing_.setMetronome(cfgMet_);
    }
    s = extEvtSeq_;
    if (s != extEvtSeqSeen_) {
        extEvtSeqSeen_ = s;
        switch (extEvt_) {
        case 1: timing_.extStart(); break;
        case 2: timing_.extContinue(); break;
        case 3: timing_.extStop(); break;
        default: break;
        }
    }
    s = extBeatSeq_;
    if (s != extBeatSeqSeen_) {
        extBeatSeqSeen_ = s;
        timing_.extBeat(extSpb_);
    }
}

// The click is a short decaying square burst — integer math, no tables, no
// allocation. ~1.57 kHz for the bar accent, ~1.05 kHz for other beats.
void AudioEffectLooper::startClick(uint32_t offset, bool accent)
{
    clickRemain_ = CLICK_LEN;
    clickStart_ = offset < AUDIO_BLOCK_SAMPLES ? offset : 0;
    clickHalf_ = accent ? 14 : 21;
    clickPhase_ = 0;
    clickSign_ = 1;
    clickAmp_ = (int32_t)(accent ? 26000 : 20000) * (int32_t)(uint16_t)cfgMetVol_ / 256;
}

void AudioEffectLooper::mixClickInto(int16_t *data)
{
    uint32_t i = clickStart_;
    clickStart_ = 0;
    for (; i < AUDIO_BLOCK_SAMPLES && clickRemain_; i++, clickRemain_--) {
        int32_t s = clickSign_ * (clickAmp_ * (int32_t)clickRemain_ / (int32_t)CLICK_LEN);
        data[i] = sat16((int32_t)data[i] + s);
        if (++clickPhase_ >= clickHalf_) {
            clickPhase_ = 0;
            clickSign_ = -clickSign_;
        }
    }
}

void AudioEffectLooper::emitClickBlock()
{
    audio_block_t *out = allocate();
    if (!out) {                            // pool empty: drop this slice of the click
        uint32_t n = AUDIO_BLOCK_SAMPLES - clickStart_;
        clickRemain_ = clickRemain_ > n ? clickRemain_ - n : 0;
        clickStart_ = 0;
        return;
    }
    memset(out->data, 0, sizeof(out->data));
    mixClickInto(out->data);
    transmit(out);
    release(out);
}
