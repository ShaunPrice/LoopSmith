#include "PatchScript.h"

static bool isIdentChar(char c)
{
    return isalnum((unsigned char)c) || c == '_';
}

static bool isIdentifier(const String &s)
{
    if (s.length() == 0) return false;
    if (isdigit((unsigned char)s[0])) return false;
    for (unsigned int i = 0; i < s.length(); i++) {
        if (!isIdentChar(s[i])) return false;
    }
    return true;
}

// Split "a, 0.5, WAVEFORM_SINE" into trimmed pieces. Returns false on empty piece.
static bool splitArgs(const String &s, std::vector<String> &out)
{
    out.clear();
    if (s.length() == 0) return true; // no args at all
    int start = 0;
    for (int i = 0; i <= (int)s.length(); i++) {
        if (i == (int)s.length() || s[i] == ',') {
            String piece = s.substring(start, i);
            piece.trim();
            if (piece.length() == 0) return false;
            out.push_back(piece);
            start = i + 1;
        }
    }
    return true;
}

static PatchArg makeArg(const String &piece)
{
    PatchArg a;
    // numeric? allow leading -, digits, dot, e/E
    bool numeric = true;
    for (unsigned int i = 0; i < piece.length(); i++) {
        char c = piece[i];
        if (!(isdigit((unsigned char)c) || c == '-' || c == '+' || c == '.' ||
              c == 'e' || c == 'E')) {
            numeric = false;
            break;
        }
    }
    if (numeric && piece.length() > 0 &&
        (isdigit((unsigned char)piece[0]) || piece[0] == '-' || piece[0] == '+' || piece[0] == '.')) {
        a.isNumber = true;
        a.num = piece.toFloat();
    } else {
        a.isNumber = false;
        a.token = piece;
    }
    return a;
}

bool PatchDoc::parse(const char *text, size_t len)
{
    title = "";
    stmts.clear();
    error = "";
    errorLine = 0;

    String line;
    line.reserve(160);
    int lineNo = 1;

    for (size_t i = 0; i <= len; i++) {
        char c = (i < len) ? text[i] : '\n';
        if (c == '\r') continue;
        if (c != '\n') {
            line += c;
            continue;
        }

        // --- handle one full line ---
        String work = line;
        line = "";

        // Design-tool exports start with '#include <Audio.h>' etc — treat all
        // preprocessor lines as comments so a raw export pastes in unmodified.
        String probe = work;
        probe.trim();
        if (probe.startsWith("#")) {
            lineNo++;
            continue;
        }

        // metadata comments before stripping
        int cIdx = work.indexOf("//");
        if (cIdx != -1) {
            String comment = work.substring(cIdx + 2);
            comment.trim();
            if (comment.startsWith("name:") && title.length() == 0) {
                title = comment.substring(5);
                title.trim();
            }
            work = work.substring(0, cIdx);
        }
        work.trim();
        if (work.length() > 0) {
            if (!parseLine(work, lineNo)) return false;
        }
        lineNo++;
    }
    return true;
}

bool PatchDoc::parseLine(String s, int lineNo)
{
    // Every statement ends with ';' — tolerate a missing one.
    if (s.endsWith(";")) {
        s = s.substring(0, s.length() - 1);
        s.trim();
    }
    if (s.length() == 0) return true;

    int paren = s.indexOf('(');

    if (paren == -1) {
        // Declaration: "<Type> <name>"
        int sp = s.indexOf(' ');
        int tab = s.indexOf('\t');
        if (tab != -1 && (sp == -1 || tab < sp)) sp = tab;
        if (sp == -1) return fail(lineNo, "expected a declaration, connection or setter");
        String type = s.substring(0, sp);
        String name = s.substring(sp + 1);
        type.trim();
        name.trim();
        if (!isIdentifier(type) || !isIdentifier(name))
            return fail(lineNo, "bad declaration");
        PatchStmt st;
        st.kind = PatchStmt::DECL;
        st.line = lineNo;
        st.type = type;
        st.name = name;
        stmts.push_back(st);
        return true;
    }

    int closeParen = s.lastIndexOf(')');
    if (closeParen == -1 || closeParen < paren)
        return fail(lineNo, "unbalanced parentheses");
    String head = s.substring(0, paren);
    String inner = s.substring(paren + 1, closeParen);
    head.trim();
    inner.trim();

    std::vector<String> pieces;
    if (!splitArgs(inner, pieces)) return fail(lineNo, "bad argument list");

    int dot = head.indexOf('.');
    if (dot != -1) {
        // Setter: "<name>.<method>(args)"
        String name = head.substring(0, dot);
        String method = head.substring(dot + 1);
        name.trim();
        method.trim();
        if (!isIdentifier(name) || !isIdentifier(method))
            return fail(lineNo, "bad setter");
        PatchStmt st;
        st.kind = PatchStmt::SETTER;
        st.line = lineNo;
        st.name = name;
        st.method = method;
        for (auto &p : pieces) st.args.push_back(makeArg(p));
        stmts.push_back(st);
        return true;
    }

    // Connection: "AudioConnection <id>(src, [srcPort,] dst[, dstPort])"
    int sp = head.indexOf(' ');
    int tab = head.indexOf('\t');
    if (tab != -1 && (sp == -1 || tab < sp)) sp = tab;
    String type = (sp == -1) ? head : head.substring(0, sp);
    type.trim();
    if (type != "AudioConnection")
        return fail(lineNo, "unknown statement (only declarations, AudioConnection and setters are allowed)");

    PatchStmt st;
    st.kind = PatchStmt::CONN;
    st.line = lineNo;
    if (pieces.size() == 2) {
        st.src = pieces[0];
        st.dst = pieces[1];
        st.srcPort = 0;
        st.dstPort = 0;
    } else if (pieces.size() == 4) {
        st.src = pieces[0];
        st.dst = pieces[2];
        st.srcPort = (int)pieces[1].toInt();
        st.dstPort = (int)pieces[3].toInt();
    } else {
        return fail(lineNo, "AudioConnection needs 2 or 4 arguments");
    }
    if (!isIdentifier(st.src) || !isIdentifier(st.dst))
        return fail(lineNo, "bad connection endpoints");
    if (st.srcPort < 0 || st.srcPort > 15 || st.dstPort < 0 || st.dstPort > 15)
        return fail(lineNo, "connection port out of range");
    stmts.push_back(st);
    return true;
}
