#pragma once
#include <cstdint>
#define AUDIO_BLOCK_SAMPLES 128
#define AUDIO_SAMPLE_RATE_EXACT 44100.0f
struct audio_block_t { int16_t data[AUDIO_BLOCK_SAMPLES] = {}; };
class AudioStream {
public:
  AudioStream(int, audio_block_t **) {}
  virtual void update() = 0;
  audio_block_t *receiveReadOnly(int) { return nullptr; }
  audio_block_t *allocate() { return new audio_block_t; }
  void release(audio_block_t *b) { delete b; }
  void transmit(audio_block_t *) {}
};
