// Host-test shim standing in for the Teensy Audio Library's AudioStream.
//
// The block plumbing is replaced with three globals a test can poke: one
// injected input block per update() and one captured output block. Everything
// else (block size, sample rate, the protected AudioStream API the looper
// uses) matches the Teensy 4.x audio core, so AudioEffectLooper.cpp compiles
// and runs unchanged.
#pragma once

#include <stdint.h>
#include <string.h>

#define AUDIO_BLOCK_SAMPLES 128
#define AUDIO_SAMPLE_RATE_EXACT 44100.0f

struct audio_block_t {
    int16_t data[AUDIO_BLOCK_SAMPLES];
};

inline audio_block_t shimIn;               // what the next update() receives
inline bool shimHaveIn = false;
inline audio_block_t shimOut;              // the last block transmit()ed
inline bool shimTransmitted = false;

class AudioStream {
public:
    AudioStream(unsigned char, audio_block_t **) {}
    virtual ~AudioStream() {}
    virtual void update() = 0;

protected:
    audio_block_t *receiveReadOnly(unsigned int = 0)
    {
        static audio_block_t copy;
        if (!shimHaveIn) return nullptr;
        copy = shimIn;
        return &copy;
    }
    // Like the hardware pool, allocated blocks are NOT zeroed.
    audio_block_t *allocate()
    {
        static audio_block_t pool[4];
        static unsigned idx = 0;
        return &pool[idx++ % 4];
    }
    void transmit(audio_block_t *b, unsigned char = 0)
    {
        shimOut = *b;
        shimTransmitted = true;
    }
    void release(audio_block_t *) {}
};
