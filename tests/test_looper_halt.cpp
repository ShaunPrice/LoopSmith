#include <cassert>
#include <cstdlib>
#include "AudioEffectLooper.h"
extern "C" {
uint8_t external_psram_size = 16;
void *extmem_malloc(size_t size) { return malloc(size); }
void extmem_free(void *ptr) { free(ptr); }
}
int main() {
  AudioEffectLooper lp;
  assert(lp.begin());
  lp.halt(); lp.update(); assert(lp.state() == AudioEffectLooper::EMPTY);
  lp.tapLoop();
  for (int i=0;i<40;++i) lp.update();
  assert(lp.state() == AudioEffectLooper::RECORDING);
  lp.halt(); lp.update(); const auto length=lp.lengthSamples();
  assert(length>0 && lp.state()==AudioEffectLooper::STOPPED);
  for(int i=0;i<5;++i) { lp.halt(); lp.update(); }
  assert(lp.state()==AudioEffectLooper::STOPPED && lp.lengthSamples()==length);
  lp.tapStop(); lp.update(); assert(lp.state()==AudioEffectLooper::PLAYING);
  lp.tapLoop(); lp.update(); assert(lp.state()==AudioEffectLooper::OVERDUBBING);
  lp.halt(); for(int i=0;i<70;++i) lp.update();
  assert(lp.state()==AudioEffectLooper::STOPPED && lp.lengthSamples()==length);
  lp.tapLoop(); lp.halt(); lp.update();
  assert(lp.state()==AudioEffectLooper::STOPPED);
}
