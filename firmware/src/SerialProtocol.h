// SerialProtocol — USB command console for humans and the Studio editor.
// See docs/PROTOCOL.md. Machine-readable lines start with '#'.

#pragma once

#include <Arduino.h>
#include "Pedal.h"

class SerialProtocol {
public:
    void begin(Pedal *pedal) { pedal_ = pedal; }
    void poll();

private:
    void handleLine(char *line);
    void emitStatus();
    void emitPong();
    void emitPresets();
    void emitEventsIfChanged();
    bool receiveCounted(char **data, size_t len);   // after #SEND
    static void jsonEscapeInto(String &out, const String &s);

    Pedal   *pedal_ = nullptr;
    char     line_[160];
    size_t   lineLen_ = 0;
    bool     discarding_ = false;   // swallowing the tail of an overlong line
    bool     monitor_ = false;
    uint32_t lastMonitor_ = 0;

    // change tracking for #EVT
    String  lastLoopState_;
    String  lastPreset_;
    int     lastBypass_ = -1;
    int     lastTone_ = -1;     // so the auto-stopped test tone announces itself
};
