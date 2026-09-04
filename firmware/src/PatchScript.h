// PatchScript — parser for the preset text format (see docs/PATCHSCRIPT.md).
//
// The format is a subset of the code exported by the Teensy Audio System Design
// Tool, plus C++-style setter calls:
//
//   // name: Ambient Swell
//   AudioEffectFreeverb verb1;                       // declaration
//   AudioConnection c1(fxin, 0, verb1, 0);           // connection
//   verb1.roomsize(0.78);                            // setter
//
// This file only turns text into statements — it does not touch the audio graph.

#pragma once

#include <Arduino.h>
#include <vector>

struct PatchArg {
    bool  isNumber = false;
    float num = 0;
    String token;      // identifier/token argument (e.g. WAVEFORM_SINE) when !isNumber
};

struct PatchStmt {
    enum Kind : uint8_t { DECL, CONN, SETTER };
    Kind   kind;
    int    line = 0;

    // DECL: type + name.  SETTER: name + method + args.
    String type;
    String name;
    String method;
    std::vector<PatchArg> args;

    // CONN
    String src, dst;
    int    srcPort = 0, dstPort = 0;
};

struct PatchDoc {
    String title;                 // from "// name: ..." (may be empty)
    std::vector<PatchStmt> stmts;

    String error;                 // non-empty => parse failed
    int    errorLine = 0;

    // Parse `len` bytes of text. Returns false and sets error/errorLine on failure.
    bool parse(const char *text, size_t len);

private:
    bool parseLine(String line, int lineNo);
    bool fail(int lineNo, const String &msg) {
        error = msg;
        errorLine = lineNo;
        return false;
    }
};
