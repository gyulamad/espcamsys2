// settings_logic.h — the sketch's settings engine, pulled out of the .ino so it
// can be compiled and unit-tested as plain desktop C++ (g++, run under gdb),
// completely independent of the Arduino core / ESP32 SDK. It is the same
// "business logic in a header" arrangement as logic.h / remote_log.h.
//
// What it does: every per-camera setting (Wi-Fi networks, relay address,
// camera id, API key, ...) is stored in the board's flash, NOT compiled in.
// There are no defaults: a freshly flashed board has nothing and asks for
// every setting over the serial port. This file holds
//   - the line format the user types:      KEY1=value1;KEY2=value2;...
//   - validation of every value (nothing is stored unless the WHOLE line is ok)
//   - "which settings are missing?" (with settings that only matter when
//     another one enables them, e.g. LOG_* only when LOG_ENABLED=1)
//   - showing / exporting settings (secrets masked unless asked for)
//   - BootConfigFlow: the start-up conversation (show settings, ask for the
//     missing ones, or offer a 5 s window to change them), written as a
//     non-blocking state machine so tests can run it with a fake clock.
//
// Rules for anything added to this file (same as logic.h):
//   - No Arduino/ESP includes. Hardware (flash storage, the serial port, the
//     clock) is reached only through ISettingsStore / IConsole and the `nowMs`
//     argument of BootConfigFlow::step().
//   - Only standard C++11, so the ESP32 toolchain builds it.
//
// COPIES: this file is deliberately duplicated into every sketch folder that
// uses it (an Arduino sketch can only include files from its own folder).
// run_tests.sh fails if the copies differ — edit one, copy it to the others.
//
// See tests/cpp/test_settings_logic.cpp for the unit tests.

#pragma once

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

namespace esp32cam_settings {

const size_t MAX_LINE_LENGTH    = 1024;  // longest line accepted from the serial port
const size_t MAX_WIFI_NETWORKS  = 16;     // more than this in the WIFI list is refused
const size_t NVS_KEY_MAX_LENGTH = 15;    // flash (NVS) key names can't be longer

// ── Text helpers ────────────────────────────────────────────────────────

inline bool isCtrlChar(char c) {
    unsigned char u = static_cast<unsigned char>(c);
    return u < 0x20 || u == 0x7F;
}

inline std::string trimSpaces(const std::string& s) {
    size_t b = 0, e = s.size();
    while (b < e && (s[b] == ' ' || s[b] == '\t' || s[b] == '\r' || s[b] == '\n')) ++b;
    while (e > b && (s[e - 1] == ' ' || s[e - 1] == '\t' || s[e - 1] == '\r' || s[e - 1] == '\n')) --e;
    return s.substr(b, e - b);
}

inline std::string upperAscii(std::string s) {
    for (size_t i = 0; i < s.size(); ++i) if (s[i] >= 'a' && s[i] <= 'z') s[i] = static_cast<char>(s[i] - 'a' + 'A');
    return s;
}

inline std::string lowerAscii(std::string s) {
    for (size_t i = 0; i < s.size(); ++i) if (s[i] >= 'A' && s[i] <= 'Z') s[i] = static_cast<char>(s[i] - 'A' + 'a');
    return s;
}

// A user's input quoted back in an error message — short, so a typed secret
// that landed in the wrong place doesn't get echoed in full.
inline std::string shortened(const std::string& s, size_t max = 24) {
    if (s.size() <= max) return s;
    return s.substr(0, max) + "...";
}

inline std::string numText(double v) {
    char b[40];
    snprintf(b, sizeof(b), "%g", v);
    return b;
}

// ── Escaping: \;  \:  \\ ────────────────────────────────────────────────
// ';' separates settings and ':' separates the fields of the WIFI list, so a
// literal ';' ':' or '\' inside a value is written \;  \:  \\ . Only needed
// when such a character is really there.

inline std::string escapeText(const std::string& s, bool escapeColon) {
    std::string out;
    for (size_t i = 0; i < s.size(); ++i) {
        char c = s[i];
        if (c == '\\' || c == ';' || (escapeColon && c == ':')) out += '\\';
        out += c;
    }
    return out;
}

// false (with `err` set) for an unknown escape or a lone trailing backslash —
// a typo is reported, never silently accepted.
inline bool unescapeText(const std::string& raw, std::string& out, std::string& err) {
    out.clear();
    for (size_t i = 0; i < raw.size(); ++i) {
        char c = raw[i];
        if (c != '\\') { out += c; continue; }
        if (i + 1 >= raw.size()) {
            err = "ends with a lone \\ (write \\\\ for a literal backslash)";
            return false;
        }
        char n = raw[++i];
        if (n == '\\' || n == ';' || n == ':') {
            out += n;
        } else {
            err = std::string("has an unknown escape \\") + n + " (only \\\\  \\;  \\: exist)";
            return false;
        }
    }
    return true;
}

// Splits on `sep` characters that are not escaped. The pieces keep their
// escapes (unescape them afterwards).
inline bool splitUnescaped(const std::string& s, char sep, std::vector<std::string>& parts, std::string& err) {
    parts.clear();
    std::string cur;
    for (size_t i = 0; i < s.size(); ++i) {
        char c = s[i];
        if (c == '\\') {
            if (i + 1 >= s.size()) {
                err = "ends with a lone \\ (write \\\\ for a literal backslash)";
                return false;
            }
            cur += c;
            cur += s[++i];
            continue;
        }
        if (c == sep) { parts.push_back(cur); cur.clear(); continue; }
        cur += c;
    }
    parts.push_back(cur);
    return true;
}

// ── Number parsing (strict: no spaces, no trailing junk) ────────────────

inline bool parseInt(const std::string& s, long long& out) {
    if (s.empty() || s.size() > 18) return false;
    size_t i = 0;
    bool neg = false;
    if (s[0] == '-') { neg = true; i = 1; }
    if (i >= s.size()) return false;
    long long v = 0;
    for (; i < s.size(); ++i) {
        if (s[i] < '0' || s[i] > '9') return false;
        v = v * 10 + (s[i] - '0');
    }
    out = neg ? -v : v;
    return true;
}

inline bool parseFloat(const std::string& s, double& out) {
    if (s.empty()) return false;
    for (size_t i = 0; i < s.size(); ++i) {
        char c = s[i];
        bool ok = (c >= '0' && c <= '9') || c == '.' || c == '-' || c == '+' || c == 'e' || c == 'E';
        if (!ok) return false;   // also keeps out spaces, "nan", "inf" and hex floats
    }
    char* end = nullptr;
    double d = strtod(s.c_str(), &end);
    if (end == s.c_str() || *end != '\0' || !std::isfinite(d)) return false;
    out = d;
    return true;
}

// ── What can be configured ──────────────────────────────────────────────

enum class Kind : uint8_t {
    Text,       // any non-empty text
    Host,       // hostname or IPv4 address
    Id,         // 1-64 of A-Z a-z 0-9 _ . -      (camera / detector names)
    Secret,     // non-empty, not the "change-me" placeholder; masked when shown
    Int,        // whole number between min and max
    Float,      // number between min and max
    Bool,       // 1/0 (also yes/no, true/false, on/off)
    Level,      // LOW or HIGH
    Pin,        // a usable GPIO number
    PinOrOff,   // a usable GPIO number, or -1 meaning "feature off"
    Wifi        // ssid:password[:ssid:password...]; passwords masked when shown
};

// Some settings only matter when another one switches the feature on.
enum class Cond : uint8_t {
    Always,        // always required
    WhenEquals,    // required only while condKey == condValue
    WhenNotEquals  // required only while condKey != condValue
};

struct KeyDef {
    const char* name;       // also the flash key: at most NVS_KEY_MAX_LENGTH characters
    Kind kind;
    double min;             // Int / Float limits (ignored for other kinds)
    double max;
    Cond cond;
    const char* condKey;    // the controlling setting (nullptr for Always)
    const char* condValue;  // its stored value, e.g. "1"
    const char* help;       // one line shown when the setting is asked for
};

// The values as they WOULD be once a typed line is applied: what the line sets,
// else what is in flash. Used by rules that involve more than one setting.
class IValues {
public:
    virtual ~IValues() {}
    virtual bool get(const std::string& key, std::string& out) const = 0;   // false: not set
};

// A rule over several settings (e.g. "the clear threshold must not exceed the
// detect threshold"). Return true when the rule holds OR when the settings it
// needs aren't all known yet; false with `err` set to refuse the line.
typedef bool (*CrossCheckFn)(const IValues& values, std::string& err);

struct Schema {
    const KeyDef* keys;
    size_t count;
    CrossCheckFn crossCheck;   // nullptr: no such rule
};

inline const KeyDef* findKey(const Schema& schema, const std::string& upperName) {
    for (size_t i = 0; i < schema.count; ++i) {
        if (upperName == schema.keys[i].name) return &schema.keys[i];
    }
    return nullptr;
}

// ── The two things the hardware provides ────────────────────────────────

// Flash storage. Values are stored as text under the setting's own name.
class ISettingsStore {
public:
    virtual ~ISettingsStore() {}
    virtual bool has(const std::string& key) = 0;
    virtual std::string get(const std::string& key) = 0;   // call only when has(key)
    virtual bool set(const std::string& key, const std::string& value) = 0;
    virtual void clearAll() = 0;
};

// The serial port, as the flow sees it.
class IConsole {
public:
    virtual ~IConsole() {}
    virtual int read() = 0;                          // next byte, or -1 when none is waiting
    virtual void println(const std::string& line) = 0;
};

// ── Wi-Fi network list ──────────────────────────────────────────────────

struct WifiNet {
    std::string ssid;
    std::string pass;   // empty = open network
};

// Parses the (still escaped) text "ssid1:pass1:ssid2:pass2:...".
inline bool parseWifiList(const std::string& raw, std::vector<WifiNet>& out, std::string& err) {
    out.clear();
    if (raw.empty()) { err = "must not be empty"; return false; }
    std::vector<std::string> fields;
    if (!splitUnescaped(raw, ':', fields, err)) return false;
    if (fields.size() % 2 != 0) {
        err = "needs ssid:password pairs, but has an odd number of fields (an open network is ssid: with an empty password)";
        return false;
    }
    if (fields.size() / 2 > MAX_WIFI_NETWORKS) {
        err = "has more than " + numText(static_cast<double>(MAX_WIFI_NETWORKS)) + " networks";
        return false;
    }
    for (size_t i = 0; i < fields.size(); i += 2) {
        WifiNet n;
        std::string e;
        if (!unescapeText(fields[i], n.ssid, e) || !unescapeText(fields[i + 1], n.pass, e)) {
            err = "network " + numText(static_cast<double>(i / 2 + 1)) + " " + e;
            return false;
        }
        std::string where = "network " + numText(static_cast<double>(i / 2 + 1));
        for (size_t k = 0; k < n.ssid.size(); ++k) if (isCtrlChar(n.ssid[k])) { err = where + ": the name has a control character"; return false; }
        for (size_t k = 0; k < n.pass.size(); ++k) if (isCtrlChar(n.pass[k])) { err = where + ": the password has a control character"; return false; }
        if (n.ssid.empty() || n.ssid.size() > 32) { err = where + ": the name must be 1 to 32 bytes"; return false; }
        if (!n.pass.empty() && (n.pass.size() < 8 || n.pass.size() > 63)) {
            err = where + ": a password must be 8 to 63 characters (or empty for an open network)";
            return false;
        }
        out.push_back(n);
    }
    return true;
}

inline std::string joinWifiList(const std::vector<WifiNet>& nets) {
    std::string out;
    for (size_t i = 0; i < nets.size(); ++i) {
        if (i) out += ':';
        out += escapeText(nets[i].ssid, true);
        out += ':';
        out += escapeText(nets[i].pass, true);
    }
    return out;
}

// ── Validation of one value ─────────────────────────────────────────────

// The GPIOs a user may pick for an input/output: those on the AI-Thinker
// ESP32-CAM's header that the camera, the PSRAM, the serial port and the boot
// strapping don't already use. (To use another board, change this list.)
inline bool isUsableGpio(long long pin) {
    return pin == 2 || pin == 4 || pin == 13 || pin == 14 || pin == 15;
}

inline bool isNameChar(char c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
           c == '_' || c == '.' || c == '-';
}

// `raw` is what the user typed after the '=' (escapes still in it). On success
// `norm` is the canonical text that gets stored. Messages never include the
// value itself, so secrets don't end up in a log.
inline bool validateValue(const KeyDef& def, const std::string& raw, std::string& norm, std::string& err) {
    if (def.kind == Kind::Wifi) {
        std::vector<WifiNet> nets;
        if (!parseWifiList(raw, nets, err)) return false;
        norm = joinWifiList(nets);
        return true;
    }

    std::string v;
    if (!unescapeText(raw, v, err)) return false;
    for (size_t i = 0; i < v.size(); ++i) {
        if (isCtrlChar(v[i])) { err = "must not contain control characters (tab, newline, ...)"; return false; }
    }

    switch (def.kind) {
        case Kind::Text:
            if (v.empty()) { err = "must not be empty"; return false; }
            norm = v;
            return true;

        case Kind::Host:
            if (v.empty() || v.size() > 253) { err = "must be a hostname or IP address (1 to 253 characters)"; return false; }
            for (size_t i = 0; i < v.size(); ++i) {
                if (!isNameChar(v[i])) { err = "must be a hostname or IP address (letters, digits, . - _ only)"; return false; }
            }
            norm = v;
            return true;

        case Kind::Id:
            if (v.empty() || v.size() > 64) { err = "must be 1 to 64 characters"; return false; }
            for (size_t i = 0; i < v.size(); ++i) {
                if (!isNameChar(v[i])) { err = "may only contain A-Z a-z 0-9 _ . -"; return false; }
            }
            norm = v;
            return true;

        case Kind::Secret:
            if (v.empty() || v.size() > 128) { err = "must be 1 to 128 characters"; return false; }
            if (v == "change-me") { err = "is still the placeholder 'change-me' - use the real value"; return false; }
            norm = v;
            return true;

        case Kind::Int: {
            long long n = 0;
            if (!parseInt(v, n) || static_cast<double>(n) < def.min || static_cast<double>(n) > def.max) {
                err = "must be a whole number from " + numText(def.min) + " to " + numText(def.max);
                return false;
            }
            norm = std::to_string(n);
            return true;
        }

        case Kind::Float: {
            double d = 0;
            if (!parseFloat(v, d) || d < def.min || d > def.max) {
                err = "must be a number from " + numText(def.min) + " to " + numText(def.max);
                return false;
            }
            norm = v;
            return true;
        }

        case Kind::Bool: {
            std::string l = lowerAscii(v);
            if (l == "1" || l == "true" || l == "yes" || l == "on") { norm = "1"; return true; }
            if (l == "0" || l == "false" || l == "no" || l == "off") { norm = "0"; return true; }
            err = "must be 1 or 0 (also yes/no, true/false, on/off)";
            return false;
        }

        case Kind::Level: {
            std::string u = upperAscii(v);
            if (u == "LOW" || u == "0") { norm = "LOW"; return true; }
            if (u == "HIGH" || u == "1") { norm = "HIGH"; return true; }
            err = "must be LOW or HIGH";
            return false;
        }

        case Kind::Pin:
        case Kind::PinOrOff: {
            long long n = 0;
            if (!parseInt(v, n)) { err = "must be a GPIO number"; return false; }
            if (n == -1 && def.kind == Kind::PinOrOff) { norm = "-1"; return true; }
            if (!isUsableGpio(n)) {
                err = "GPIO " + std::to_string(n) + " can't be used (choose 2, 4, 13, 14 or 15" +
                      std::string(def.kind == Kind::PinOrOff ? ", or -1 for off" : "") +
                      "; the other pins are used by the camera, PSRAM, serial port or boot)";
                return false;
            }
            norm = std::to_string(n);
            return true;
        }

        case Kind::Wifi:
            break;   // handled above
    }
    return false;
}

// A value read back from flash must still pass the same checks (it could be
// from an older firmware, or damaged). Stored text is canonical; for everything
// but the WIFI list that means "unescaped", so it is re-escaped before checking.
inline bool validateStored(const KeyDef& def, const std::string& stored, std::string& err) {
    std::string norm;
    return validateValue(def, def.kind == Kind::Wifi ? stored : escapeText(stored, false), norm, err);
}

// ── Parsing a typed line ────────────────────────────────────────────────

struct Pair {
    std::string key;     // upper-case
    std::string value;   // raw (escaped) after parseLine(), canonical after checkLine()
};

struct ParsedLine {
    std::vector<Pair> pairs;
    std::vector<std::string> errors;
};

inline bool isKeyChar(char c) {
    return (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_';
}

// "KEY1=value1;KEY2=value2;..." -> pairs. Splits only on the FIRST '=' of each
// piece (values may contain '='), and only on unescaped ';'. A trailing ';' and
// empty pieces are fine. Values are not trimmed (a password may have spaces).
inline ParsedLine parseLine(const std::string& lineIn) {
    ParsedLine r;
    std::string line = lineIn;
    while (!line.empty() && (line[line.size() - 1] == '\r' || line[line.size() - 1] == '\n')) line.erase(line.size() - 1);

    if (line.size() > MAX_LINE_LENGTH) {
        r.errors.push_back("the line is too long (" + numText(static_cast<double>(line.size())) +
                           " characters, the limit is " + numText(static_cast<double>(MAX_LINE_LENGTH)) + ")");
        return r;
    }

    std::vector<std::string> pieces;
    std::string err;
    if (!splitUnescaped(line, ';', pieces, err)) {
        r.errors.push_back("the line " + err);
        return r;
    }
    for (size_t i = 0; i < pieces.size(); ++i) {
        if (trimSpaces(pieces[i]).empty()) continue;
        size_t eq = pieces[i].find('=');
        if (eq == std::string::npos) {
            r.errors.push_back("'" + shortened(trimSpaces(pieces[i])) + "' is not KEY=value");
            continue;
        }
        std::string key = upperAscii(trimSpaces(pieces[i].substr(0, eq)));
        bool keyOk = !key.empty();
        for (size_t k = 0; k < key.size(); ++k) if (!isKeyChar(key[k])) keyOk = false;
        if (!keyOk) {
            r.errors.push_back("'" + shortened(key) + "' is not a valid setting name");
            continue;
        }
        Pair p;
        p.key = key;
        p.value = pieces[i].substr(eq + 1);
        r.pairs.push_back(p);
    }
    return r;
}

struct CheckedLine {
    std::vector<Pair> pairs;           // canonical values, ready to store (only meaningful when ok())
    std::vector<std::string> errors;
    bool ok() const { return errors.empty(); }
};

// Parses AND validates a whole line. Every problem is reported, and when there
// is any, nothing at all is to be stored (a template with one typo must not
// half-apply).
inline CheckedLine checkLine(const Schema& schema, const std::string& line) {
    CheckedLine out;
    ParsedLine parsed = parseLine(line);
    out.errors = parsed.errors;
    std::vector<std::string> seen;
    for (size_t i = 0; i < parsed.pairs.size(); ++i) {
        const Pair& p = parsed.pairs[i];
        const KeyDef* def = findKey(schema, p.key);
        if (!def) {
            out.errors.push_back("unknown setting " + p.key + " (HELP lists them)");
            continue;
        }
        bool dup = false;
        for (size_t s = 0; s < seen.size(); ++s) if (seen[s] == p.key) dup = true;
        if (dup) { out.errors.push_back(p.key + " is given twice in this line"); continue; }
        seen.push_back(p.key);

        Pair norm;
        norm.key = p.key;
        std::string err;
        if (!validateValue(*def, p.value, norm.value, err)) {
            out.errors.push_back(p.key + " " + err);
            continue;
        }
        out.pairs.push_back(norm);
    }
    return out;
}

// Applies the schema's cross-setting rule to a line that passed checkLine():
// the line's own values take precedence over what is stored, so a rule broken
// by changing one setting can be fixed by changing both in the same line.
class PendingValues : public IValues {
public:
    PendingValues(const std::vector<Pair>& pairs, ISettingsStore& store) : pairs_(pairs), store_(store) {}
    bool get(const std::string& key, std::string& out) const override {
        for (size_t i = 0; i < pairs_.size(); ++i) {
            if (pairs_[i].key == key) { out = pairs_[i].value; return true; }
        }
        if (store_.has(key)) { out = store_.get(key); return true; }
        return false;
    }
private:
    const std::vector<Pair>& pairs_;
    ISettingsStore& store_;
};

inline void checkCrossRules(const Schema& schema, ISettingsStore& store, const std::vector<Pair>& pairs,
                            std::vector<std::string>& errors) {
    if (!schema.crossCheck) return;
    PendingValues values(pairs, store);
    std::string err;
    if (!schema.crossCheck(values, err)) errors.push_back(err);
}

// ── What is missing? ────────────────────────────────────────────────────

// Is `def` needed right now? Settings controlled by another one are needed
// unless that one is set AND says "off"; so on a blank board everything is
// listed, and the user switches a feature off by answering its switch.
inline bool isRequired(const KeyDef& def, ISettingsStore& store) {
    if (def.cond == Cond::Always || !def.condKey) return true;
    if (!store.has(def.condKey)) return true;
    bool equal = store.get(def.condKey) == def.condValue;
    return def.cond == Cond::WhenEquals ? equal : !equal;
}

struct Problem {
    std::string key;
    bool missing;         // false: stored, but the value is no longer valid
    std::string reason;   // for invalid ones
};

inline std::vector<Problem> findProblems(const Schema& schema, ISettingsStore& store) {
    std::vector<Problem> out;
    for (size_t i = 0; i < schema.count; ++i) {
        const KeyDef& def = schema.keys[i];
        if (!isRequired(def, store)) continue;
        Problem p;
        p.key = def.name;
        if (!store.has(def.name)) {
            p.missing = true;
            out.push_back(p);
            continue;
        }
        std::string err;
        if (!validateStored(def, store.get(def.name), err)) {
            p.missing = false;
            p.reason = err;
            out.push_back(p);
        }
    }
    return out;
}

// A stored whole number (call only for a setting that is stored and valid).
inline long long storedInt(ISettingsStore& store, const char* key) {
    long long v = 0;
    parseInt(store.get(key), v);
    return v;
}

// ── Showing settings ────────────────────────────────────────────────────

inline std::string displayValue(const KeyDef& def, const std::string& stored, bool mask) {
    if (!mask) return stored;
    if (def.kind == Kind::Secret) return "********";
    if (def.kind == Kind::Wifi) {
        std::vector<WifiNet> nets;
        std::string err;
        if (!parseWifiList(stored, nets, err)) return "<unreadable>";
        std::string out;
        for (size_t i = 0; i < nets.size(); ++i) {
            if (i) out += ':';
            out += escapeText(nets[i].ssid, true);
            out += ':';
            out += nets[i].pass.empty() ? "(open)" : "****";
        }
        return out;
    }
    return stored;
}

// "KEY=value" for one setting, with a note when it's required-but-unset,
// invalid, or not used (its feature is switched off).
inline std::string renderSetting(const KeyDef& def, ISettingsStore& store, bool mask) {
    std::string line = def.name;
    line += '=';
    bool has = store.has(def.name);
    bool required = isRequired(def, store);
    if (!has) {
        line += "<not set>";
        if (required) line += "   <-- required";
    } else {
        std::string stored = store.get(def.name);
        line += displayValue(def, stored, mask);
        std::string err;
        if (required && !validateStored(def, stored, err)) line += "   <-- INVALID: " + err;
    }
    if (!required) line += "   (not used)";
    return line;
}

inline std::vector<std::string> renderAll(const Schema& schema, ISettingsStore& store, bool mask) {
    std::vector<std::string> out;
    for (size_t i = 0; i < schema.count; ++i) out.push_back(renderSetting(schema.keys[i], store, mask));
    return out;
}

// One line that sets this camera's settings on another board:
// KEY=value;KEY=value;... (unmasked, fully escaped). Empty if nothing is stored.
inline std::string renderExport(const Schema& schema, ISettingsStore& store) {
    std::string out;
    for (size_t i = 0; i < schema.count; ++i) {
        const KeyDef& def = schema.keys[i];
        if (!store.has(def.name)) continue;
        std::string stored = store.get(def.name);
        if (!out.empty()) out += ';';
        out += def.name;
        out += '=';
        out += def.kind == Kind::Wifi ? stored : escapeText(stored, false);
    }
    return out;
}

inline std::string kindText(const KeyDef& def) {
    switch (def.kind) {
        case Kind::Text:     return "text";
        case Kind::Host:     return "hostname or IP address";
        case Kind::Id:       return "1-64 characters of A-Z a-z 0-9 _ . -";
        case Kind::Secret:   return "secret text";
        case Kind::Int:      return "whole number " + numText(def.min) + " to " + numText(def.max);
        case Kind::Float:    return "number " + numText(def.min) + " to " + numText(def.max);
        case Kind::Bool:     return "1 or 0 (also yes/no, true/false, on/off)";
        case Kind::Level:    return "LOW or HIGH";
        case Kind::Pin:      return "GPIO 2, 4, 13, 14 or 15";
        case Kind::PinOrOff: return "GPIO 2, 4, 13, 14 or 15, or -1 = off";
        case Kind::Wifi:     return "ssid:password[:ssid:password...] (open network: ssid:)";
    }
    return "";
}

// "KEY - what it is  [what to type]  (only if OTHER=1)"
inline std::string describeKey(const KeyDef& def) {
    std::string s = def.name;
    s += " - ";
    s += def.help;
    s += "  [" + kindText(def) + "]";
    if (def.cond != Cond::Always && def.condKey) {
        s += std::string("  (only needed when ") + def.condKey +
             (def.cond == Cond::WhenEquals ? " is " : " is not ") + def.condValue + ")";
    }
    return s;
}

// ── Commands (lines without '=') ────────────────────────────────────────

enum class Command : uint8_t { None, Help, Show, ShowKey, Export, Erase, Exit, Unknown };

struct ParsedCommand {
    Command cmd;
    std::string arg;   // SHOW <KEY>: the upper-cased key; Unknown: the text
};

inline ParsedCommand parseCommand(const std::string& line) {
    ParsedCommand pc;
    pc.cmd = Command::None;
    std::string t = trimSpaces(line);
    if (t.empty()) return pc;

    size_t sp = t.find_first_of(" \t");
    std::string word = upperAscii(sp == std::string::npos ? t : t.substr(0, sp));
    std::string rest = sp == std::string::npos ? "" : trimSpaces(t.substr(sp));

    if (word == "HELP" || word == "?")       pc.cmd = Command::Help;
    else if (word == "SHOW" || word == "LIST") {
        pc.cmd = rest.empty() ? Command::Show : Command::ShowKey;
        pc.arg = upperAscii(rest);
    }
    else if (word == "EXPORT")               pc.cmd = Command::Export;
    else if (word == "ERASE")                pc.cmd = Command::Erase;
    else if (word == "EXIT" || word == "QUIT" || word == "DONE") pc.cmd = Command::Exit;
    else { pc.cmd = Command::Unknown; pc.arg = shortened(t); }
    return pc;
}

// ── Getting missing settings from the relay ─────────────────────────────
//
// A firmware that needs one more setting than a board has stored cannot run
// (there are no defaults), and the board used to wait for a USB cable. If the
// settings needed to REACH the relay (Wi-Fi, server, port, API key, own id) are
// stored and valid, the board can ask the relay for the missing ones instead:
// the relay hands out one line of text staged by the operator (see
// nodejs/camera-relay/lib/devicesettings.js) in the same KEY=value;... form as
// the serial console.
//
// Safety rules, because this is a way to change a board from afar:
//   - only settings that are currently MISSING OR INVALID are ever taken from the
//     relay. A setting that is stored and valid is never touched, so a staged line
//     can fill a gap but can not reconfigure a working board.
//   - the settings needed to reach the relay are valid by definition when this
//     runs, so they can never be among those taken.
//   - the line goes through the same validation as typed input (checkLine and the
//     schema's cross-setting rule), all or nothing: a line with one bad value
//     stores nothing.

enum class FetchResult : uint8_t { Failed, NothingStaged, Got };

// The Wi-Fi and HTTP side, as the flow sees it. The real one lives in the sketch
// ("Relay settings link"); the tests drive a scripted fake.
class IRemoteLink {
public:
    virtual ~IRemoteLink() {}
    virtual void startConnecting() = 0;   // begin joining Wi-Fi (returns at once, or quickly)
    virtual bool online() = 0;            // joined; may wait a few seconds for the answer
    // One request to the relay. `needKeys` is "KEY1,KEY2" (what is missing; only
    // for the relay's log). Got: `line` holds the staged text. May block for the
    // request's own timeout.
    virtual FetchResult fetch(const std::string& needKeys, std::string& line) = 0;
};

// True when every one of `prerequisites` is stored and valid — i.e. the board has
// what it needs to reach the relay. An empty list means "can't".
inline bool remoteFillPossible(const Schema& schema, ISettingsStore& store,
                               const std::vector<std::string>& prerequisites) {
    if (prerequisites.empty()) return false;
    for (size_t i = 0; i < prerequisites.size(); ++i) {
        const KeyDef* def = findKey(schema, prerequisites[i]);
        if (!def || !store.has(def->name)) return false;
        std::string err;
        if (!validateStored(*def, store.get(def->name), err)) return false;
    }
    return true;
}

struct RemoteApplyResult {
    size_t stored;                       // settings written to flash
    std::vector<std::string> keys;       // which ones, in the order of the line
    std::vector<std::string> errors;     // why nothing was stored (empty when fine, or when nothing applied)
    std::vector<std::string> ignored;    // names in the line that were left alone (not missing, or unknown)
    RemoteApplyResult() : stored(0) {}
};

// Takes the settings that are missing or invalid out of a staged line, checks
// them as if they had been typed, and stores them — or stores nothing, with the
// reasons in `errors`. Everything else in the line is ignored (and named).
inline RemoteApplyResult applyRemoteLine(const Schema& schema, ISettingsStore& store, const std::string& line) {
    RemoteApplyResult out;
    ParsedLine parsed = parseLine(line);
    if (!parsed.errors.empty()) { out.errors = parsed.errors; return out; }

    std::vector<Problem> problems = findProblems(schema, store);
    std::string usable;
    for (size_t i = 0; i < parsed.pairs.size(); ++i) {
        const Pair& p = parsed.pairs[i];
        bool wanted = false;
        for (size_t j = 0; j < problems.size(); ++j) if (problems[j].key == p.key) wanted = true;
        if (!wanted) { out.ignored.push_back(p.key); continue; }
        if (!usable.empty()) usable += ';';
        usable += p.key + "=" + p.value;     // the value is still in its escaped form, exactly as received
    }
    if (usable.empty()) return out;

    CheckedLine cl = checkLine(schema, usable);
    if (cl.ok()) checkCrossRules(schema, store, cl.pairs, cl.errors);
    if (!cl.ok()) { out.errors = cl.errors; return out; }

    for (size_t i = 0; i < cl.pairs.size(); ++i) {
        if (store.set(cl.pairs[i].key, cl.pairs[i].value)) {
            out.stored++;
            out.keys.push_back(cl.pairs[i].key);
        } else {
            out.errors.push_back("could not write " + cl.pairs[i].key + " to flash");
        }
    }
    return out;
}

// Asks the relay for the missing settings: join Wi-Fi (connectTimeoutMs), then
// ask every pollGapMs for up to windowMs. Never blocks except inside the link's
// own calls; drive it with step(millis()) until it stops returning Running.
//   Filled        settings were stored — restart so they take effect
//   GiveUp        Wi-Fi didn't come up, or nothing usable arrived in time — restart and try again
//   NotPossible   the settings needed to reach the relay are not all there — only the serial console can help
class RemoteFill {
public:
    enum Status { Running, Filled, GiveUp, NotPossible };

    RemoteFill(const Schema& schema, ISettingsStore& store, IRemoteLink& link, IConsole& console,
               const std::vector<std::string>& prerequisites,
               uint32_t connectTimeoutMs, uint32_t windowMs, uint32_t pollGapMs)
        : schema_(schema), store_(store), link_(link), console_(console), prerequisites_(prerequisites),
          connectTimeoutMs_(connectTimeoutMs), windowMs_(windowMs), pollGapMs_(pollGapMs),
          phase_(Begin), result_(Running), deadline_(0), nextPoll_(0) {}

    Status step(uint32_t nowMs) {
        switch (phase_) {
            case Begin:      return begin(nowMs);
            case Connecting: return stepConnecting(nowMs);
            case Polling:    return stepPolling(nowMs);
            case Done:       return result_;
        }
        return result_;
    }

private:
    enum Phase { Begin, Connecting, Polling, Done };

    void say(const std::string& s) { console_.println(s); }
    // Says it unless it is what was said last — a board waiting for the operator asks every
    // few seconds, and the serial log shouldn't scroll with the same line.
    void note(const std::string& s) { if (s != lastNote_) { lastNote_ = s; say(s); } }
    Status finish(Status s) { result_ = s; phase_ = Done; return s; }
    static bool reached(uint32_t nowMs, uint32_t deadline) { return static_cast<int32_t>(nowMs - deadline) >= 0; }
    std::string seconds(uint32_t ms) const { return numText(ms / 1000.0) + " s"; }

    std::string missingKeys() const {
        std::vector<Problem> problems = findProblems(schema_, store_);
        std::string out;
        for (size_t i = 0; i < problems.size(); ++i) { if (i) out += ','; out += problems[i].key; }
        return out;
    }

    Status begin(uint32_t nowMs) {
        if (!remoteFillPossible(schema_, store_, prerequisites_)) {
            say("The relay can't be asked for the missing settings: the Wi-Fi / server / port / key / id settings it needs "
                "are not all stored and valid. Type the missing settings here.");
            return finish(NotPossible);
        }
        say("Asking the relay for the missing settings (joining Wi-Fi first, up to " + seconds(connectTimeoutMs_) + ")...");
        link_.startConnecting();
        deadline_ = nowMs + connectTimeoutMs_;
        phase_ = Connecting;
        return Running;
    }

    Status stepConnecting(uint32_t nowMs) {
        if (link_.online()) {
            say("Wi-Fi connected. Waiting up to " + seconds(windowMs_) + " for the relay to supply the missing settings.");
            phase_ = Polling;
            nextPoll_ = nowMs;
            deadline_ = nowMs + windowMs_;
            return Running;
        }
        if (reached(nowMs, deadline_)) {
            say("Wi-Fi did not connect in " + seconds(connectTimeoutMs_) + ". Restarting to try again.");
            return finish(GiveUp);
        }
        return Running;
    }

    Status stepPolling(uint32_t nowMs) {
        if (reached(nowMs, deadline_)) {
            say("No usable settings arrived from the relay in " + seconds(windowMs_) + ". Restarting to try again.");
            return finish(GiveUp);
        }
        if (!reached(nowMs, nextPoll_)) return Running;

        std::string line;
        FetchResult r = link_.fetch(missingKeys(), line);
        nextPoll_ = nowMs + pollGapMs_;
        if (r == FetchResult::Failed) {
            note("The relay could not be reached - still trying.");
            return Running;
        }
        if (r == FetchResult::NothingStaged) {
            note("The relay has no settings staged for this board yet - still waiting.");
            return Running;
        }

        RemoteApplyResult ar = applyRemoteLine(schema_, store_, line);
        if (!ar.errors.empty()) {
            std::string msg = "The settings from the relay were refused, nothing was stored:";
            for (size_t i = 0; i < ar.errors.size(); ++i) msg += " " + ar.errors[i] + ";";
            note(msg);
            return Running;
        }
        if (ar.stored == 0) {
            note("The relay's settings contain none of the missing ones (" + missingKeys() + ") - still waiting.");
            return Running;
        }

        say("Stored " + numText(static_cast<double>(ar.stored)) + " setting(s) received from the relay:");
        for (size_t i = 0; i < ar.keys.size(); ++i) {
            const KeyDef* def = findKey(schema_, ar.keys[i]);
            if (def) say("  " + renderSetting(*def, store_, true));
        }
        std::string still = missingKeys();
        if (still.empty()) {
            say("All settings are stored. Restarting...");
            return finish(Filled);
        }
        say("Still missing: " + still + ". Waiting for more.");
        lastNote_.clear();
        deadline_ = nowMs + windowMs_;   // progress was made: allow a full window for the rest
        return Running;
    }

    const Schema& schema_;
    ISettingsStore& store_;
    IRemoteLink& link_;
    IConsole& console_;
    std::vector<std::string> prerequisites_;
    uint32_t connectTimeoutMs_;
    uint32_t windowMs_;
    uint32_t pollGapMs_;
    Phase phase_;
    Status result_;
    uint32_t deadline_;
    uint32_t nextPoll_;
    std::string lastNote_;
};

// ── The start-up conversation ───────────────────────────────────────────
//
//   show all settings
//   anything missing/invalid?  yes -> list them, read lines until all are stored, restart
//                                  (if a RemoteFill is attached and nobody types: ask the relay, see above)
//                              no  -> "Change settings? [y/N]", wait windowMs:
//                                       y + Enter -> read lines until an empty line / EXIT
//                                       anything else, or silence -> carry on booting
//
// Call step() repeatedly (with the current millis()) until it stops returning
// Running. It never blocks, so it is driven by a fake clock in the tests.

class BootConfigFlow {
public:
    enum Status { Running, Proceed, Restart };

    BootConfigFlow(const Schema& schema, ISettingsStore& store, IConsole& console, uint32_t windowMs)
        : schema_(schema), store_(store), console_(console), windowMs_(windowMs),
          phase_(Begin), result_(Running), deadline_(0), changed_(false), mustComplete_(false),
          eraseArmed_(false), lastWasCR_(false), overflow_(false),
          remote_(0), remoteDelayMs_(0), editingSince_(0), touched_(false), remoteOver_(false) {}

    Status step(uint32_t nowMs) {
        switch (phase_) {
            case Begin:    begin(nowMs); return Running;
            case Asking:   return stepAsking(nowMs);
            case Editing:  return stepEditing(nowMs);
            case Finished: return result_;
        }
        return result_;
    }

    bool changed() const { return changed_; }

    // Lets a board that is missing settings ask the relay for them. Only used when
    // settings are missing or invalid (never in the "Change settings?" window), and
    // only if nobody types: the first byte from the serial port means a person is
    // there, and then the relay is left alone (and the board doesn't restart under
    // their hands). `startAfterMs` is how long the serial port gets to itself first.
    void attachRemote(RemoteFill* remote, uint32_t startAfterMs) {
        remote_ = remote;
        remoteDelayMs_ = startAfterMs;
    }

private:
    enum Phase { Begin, Asking, Editing, Finished };

    void say(const std::string& s) { console_.println(s); }

    Status finish(Status s) { result_ = s; phase_ = Finished; return s; }

    void begin(uint32_t nowMs) {
        say("");
        say("---- settings ----");
        std::vector<std::string> lines = renderAll(schema_, store_, true);
        for (size_t i = 0; i < lines.size(); ++i) say(lines[i]);
        say("------------------");

        std::vector<Problem> problems = findProblems(schema_, store_);
        if (!problems.empty()) {
            mustComplete_ = true;
            printProblems(problems);
            printEditHelp();
            if (remote_) {
                say("If nobody types within " + numText(remoteDelayMs_ / 1000.0) +
                    " s, the board asks the relay for these (when its Wi-Fi settings are stored).");
            }
            editingSince_ = nowMs;
            phase_ = Editing;
            return;
        }
        say("Change settings? [y/N]  Type y and Enter within " + numText(windowMs_ / 1000.0) +
            " s; otherwise the camera starts normally.");
        deadline_ = nowMs + windowMs_;
        phase_ = Asking;
    }

    void printProblems(const std::vector<Problem>& problems) {
        say("These settings need a value (" + numText(static_cast<double>(problems.size())) + "):");
        for (size_t i = 0; i < problems.size(); ++i) {
            const KeyDef* def = findKey(schema_, problems[i].key);
            std::string line = "  " + (def ? describeKey(*def) : problems[i].key);
            if (!problems[i].missing) line += "   <-- stored value is invalid: " + problems[i].reason;
            say(line);
        }
    }

    void printEditHelp() {
        say("Type settings as KEY=value, several at once separated by ;   e.g.  CAMERA_ID=cam2;HTTP_PORT=8080");
        say("HELP shows all commands and settings.");
    }

    void enterEditing() {
        say("Settings mode. Send KEY=value;KEY=value;...  (HELP for more, empty line or EXIT when done)");
        phase_ = Editing;
    }

    // Feeds one byte; true when a line is complete (then takeLine()).
    bool feedChar(int c) {
        if (c == '\n') {
            if (lastWasCR_) { lastWasCR_ = false; return false; }   // the \n of a \r\n
            return true;
        }
        if (c == '\r') { lastWasCR_ = true; return true; }
        lastWasCR_ = false;
        if (c == 0x08 || c == 0x7F) {                                // backspace (raw terminals)
            if (!line_.empty()) line_.erase(line_.size() - 1);
            return false;
        }
        if (line_.size() >= MAX_LINE_LENGTH) { overflow_ = true; return false; }
        line_ += static_cast<char>(c);
        return false;
    }

    std::string takeLine(bool& overflow) {
        std::string l;
        l.swap(line_);
        overflow = overflow_;
        overflow_ = false;
        return l;
    }

    static bool isYes(const std::string& s) {
        std::string l = lowerAscii(trimSpaces(s));
        return l == "y" || l == "yes";
    }

    Status stepAsking(uint32_t nowMs) {
        int c;
        while ((c = console_.read()) >= 0) {
            if (!feedChar(c)) continue;
            bool overflow = false;
            std::string line = takeLine(overflow);
            if (!overflow && isYes(line)) { enterEditing(); return Running; }
            say("Starting normally.");
            return finish(Proceed);
        }
        if (static_cast<int32_t>(nowMs - deadline_) >= 0) {
            if (isYes(line_)) { line_.clear(); enterEditing(); return Running; }   // typed y, no Enter
            say("No input - starting normally.");
            return finish(Proceed);
        }
        return Running;
    }

    Status stepEditing(uint32_t nowMs) {
        int c;
        while ((c = console_.read()) >= 0) {
            touched_ = true;   // a person is at the serial port: no relay, no restart behind their back
            if (!feedChar(c)) continue;
            bool overflow = false;
            std::string line = takeLine(overflow);
            Status s = handleLine(line, overflow);
            if (s != Running) return finish(s);
        }
        if (remote_ && mustComplete_ && !touched_ && !remoteOver_ &&
            static_cast<int32_t>(nowMs - editingSince_ - remoteDelayMs_) >= 0) {
            RemoteFill::Status rs = remote_->step(nowMs);
            if (rs == RemoteFill::Filled) { changed_ = true; return finish(Restart); }
            if (rs == RemoteFill::GiveUp) return finish(Restart);
            if (rs == RemoteFill::NotPossible) remoteOver_ = true;   // serial is the only way; stay here
        }
        return Running;
    }

    Status handleLine(const std::string& line, bool overflow) {
        if (overflow) {
            eraseArmed_ = false;
            say("ERROR: the line is too long (the limit is " + numText(static_cast<double>(MAX_LINE_LENGTH)) +
                " characters). Nothing was stored.");
            return Running;
        }
        std::string t = trimSpaces(line);
        if (t.empty()) { eraseArmed_ = false; return done(); }
        if (t.find('=') == std::string::npos) return handleCommand(t);

        eraseArmed_ = false;
        CheckedLine cl = checkLine(schema_, line);
        if (cl.ok()) checkCrossRules(schema_, store_, cl.pairs, cl.errors);
        if (!cl.ok()) {
            for (size_t i = 0; i < cl.errors.size(); ++i) say("ERROR: " + cl.errors[i]);
            say("Nothing was stored. Fix the line and send it again (HELP lists the settings).");
            return Running;
        }

        size_t stored = 0;
        for (size_t i = 0; i < cl.pairs.size(); ++i) {
            if (store_.set(cl.pairs[i].key, cl.pairs[i].value)) {
                stored++;
            } else {
                say("ERROR: could not write " + cl.pairs[i].key + " to flash.");
            }
        }
        if (stored > 0) changed_ = true;
        say("Stored " + numText(static_cast<double>(stored)) + " of " +
            numText(static_cast<double>(cl.pairs.size())) + ":");
        for (size_t i = 0; i < cl.pairs.size(); ++i) {
            const KeyDef* def = findKey(schema_, cl.pairs[i].key);
            if (def) say("  " + renderSetting(*def, store_, true));
        }

        std::vector<Problem> problems = findProblems(schema_, store_);
        if (!problems.empty()) {
            printProblems(problems);
            return Running;
        }
        if (mustComplete_) {
            say("All settings are stored. Restarting...");
            return Restart;
        }
        say("Send more changes, or an empty line / EXIT to save and restart.");
        return Running;
    }

    // Empty line / EXIT.
    Status done() {
        std::vector<Problem> problems = findProblems(schema_, store_);
        if (!problems.empty()) {
            say("Not finished yet.");
            printProblems(problems);
            return Running;
        }
        if (changed_) {
            say("Saved. Restarting...");
            return Restart;
        }
        say("No changes. Starting normally.");
        return Proceed;
    }

    Status handleCommand(const std::string& text) {
        ParsedCommand pc = parseCommand(text);
        if (pc.cmd != Command::Erase) eraseArmed_ = false;

        switch (pc.cmd) {
            case Command::None:
                return Running;

            case Command::Help: {
                say("Settings are KEY=value. Send several at once, separated by ;   KEY1=value1;KEY2=value2");
                say("The Wi-Fi networks are one setting:   WIFI=ssid1:password1:ssid2:password2   (open network: ssid:)");
                say("A literal ;  :  or \\ inside a value is written \\;  \\:  \\\\");
                say("Commands: HELP, SHOW, SHOW <KEY> (unmasked), EXPORT (a line for another camera), ERASE, EXIT (or an empty line)");
                say("Settings:");
                for (size_t i = 0; i < schema_.count; ++i) say("  " + describeKey(schema_.keys[i]));
                return Running;
            }

            case Command::Show: {
                std::vector<std::string> lines = renderAll(schema_, store_, true);
                for (size_t i = 0; i < lines.size(); ++i) say(lines[i]);
                return Running;
            }

            case Command::ShowKey: {
                const KeyDef* def = findKey(schema_, pc.arg);
                if (!def) { say("ERROR: unknown setting " + shortened(pc.arg) + " (HELP lists them)"); return Running; }
                say(std::string(def->name) + "=" + (store_.has(def->name) ? store_.get(def->name) : "<not set>"));
                return Running;
            }

            case Command::Export: {
                std::string line = renderExport(schema_, store_);
                say(line.empty() ? "(nothing is stored yet)" : line);
                return Running;
            }

            case Command::Erase: {
                if (!eraseArmed_) {
                    eraseArmed_ = true;
                    say("This deletes ALL settings from flash. Type ERASE again to confirm; anything else cancels.");
                    return Running;
                }
                eraseArmed_ = false;
                store_.clearAll();
                changed_ = true;
                mustComplete_ = true;
                say("All settings erased.");
                printProblems(findProblems(schema_, store_));
                return Running;
            }

            case Command::Exit:
                return done();

            case Command::Unknown:
                say("Unknown command '" + pc.arg + "' - type HELP.");
                return Running;
        }
        return Running;
    }

    const Schema& schema_;
    ISettingsStore& store_;
    IConsole& console_;
    uint32_t windowMs_;
    Phase phase_;
    Status result_;
    uint32_t deadline_;
    bool changed_;
    bool mustComplete_;
    bool eraseArmed_;
    bool lastWasCR_;
    bool overflow_;
    RemoteFill* remote_;
    uint32_t remoteDelayMs_;
    uint32_t editingSince_;
    bool touched_;
    bool remoteOver_;
    std::string line_;
};

}  // namespace esp32cam_settings
