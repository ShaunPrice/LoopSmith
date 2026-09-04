// EffectRegistry — maps PatchScript type names to Audio-library objects and
// applies setter statements to them. Mirrors docs/effects-schema.json; keep the
// two in sync when adding effects.

#pragma once

#include <Arduino.h>
#include <AudioStream.h>
#include "PatchScript.h"

enum ApplyResult : uint8_t {
    APPLY_OK = 0,
    APPLY_UNKNOWN_METHOD,   // warn + skip line, preset still loads
    APPLY_BAD_ARGS,         // warn + skip line
    APPLY_ALLOC_FAILED      // hard error
};

struct EffectInfo {
    const char *typeName;
    uint8_t numInputs;
    uint8_t numOutputs;
    AudioStream *(*create)();
    ApplyResult (*apply)(AudioStream *s, const String &method,
                         const PatchArg *args, int argc);
};

// nullptr if the type is not supported.
const EffectInfo *effectRegistryFind(const String &typeName);

// Free the delay-line memory tracked for a stream (used only if streams are
// ever destroyed; the patch manager currently caches streams forever).
void effectRegistryReleaseBuffers(AudioStream *s);
