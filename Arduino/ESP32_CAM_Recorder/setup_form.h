// setup_form.h — the board's own setup web page, as pure C++ (F-21). It is what a phone sees
// after joining the board's setup WiFi: a form generated from the settings table, and the three
// requests it answers (GET /, POST /save, POST /exit). No Arduino/ESP includes: the HTTP server
// (setup_mode.h) only hands over "method, path, body" and sends back the HttpReply, so every
// decision here is unit-tested on a desktop (tests/cpp/test_setup_form*.cpp).
//
// What it must get right, because anybody who knows the master password can reach it:
//   - nothing is stored unless the WHOLE form is valid. Validation is the settings engine's own
//     (checkLine, applyChangeLine: all-or-nothing, cross-setting rules, the board must still be
//     complete afterwards) — there is no second set of rules here.
//   - a per-session CSRF token guards every POST (another web page open on the phone must not be
//     able to reconfigure the board), compared in constant time; a board without a usable token
//     refuses every POST.
//   - everything echoed into the page is HTML-escaped; secrets (API key, master password, WiFi
//     passwords) are never put into the page at all — only "set" / "not set".
//   - the request is parsed strictly and its size is capped (4 KB).
//   - the master password rule: the board may not leave setup while its master password is
//     absent or still the built-in default (the default is public).
//   - SETUP_MODE=0 is written LAST, in the same all-or-nothing line, so a power cut half way
//     leaves the board still in setup mode instead of half configured and "done".
//
// Form fields (all names are ASCII, see parseUrlEncoded):
//   csrf                      hidden, the session token
//   v.<KEY>                   one per setting (blank = leave unchanged; a secret is only sent
//                             when the user types a new one)
//   w.ssid.N / w.pass.N / w.open.N   row N of the WIFI list (N = 1..MAX_WIFI_NETWORKS)
//   v.SETUP_PASSWORD, v.SETUP_PASSWORD.confirm   the master password, typed twice
//
// Not here (other work packages): the AP, DNS and HTTP server (setup_mode.h, S5) and the session
// state machine that restarts the board after saved()/exited() (setup_session.h, S4: SetupForm
// implements its ISetupOutcome). The default master password, the WPA2 password rule, the key
// names and the AP address come from setup_logic.h (S2); FormConfig only carries what varies.
//
// COPIES: deliberately duplicated into every sketch folder (an Arduino sketch can only include
// files from its own folder); run_tests.sh fails if the copies differ.

#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <utility>
#include <vector>

#include "settings_logic.h"
#include "setup_logic.h"     // S2: key names, the default master password, the WPA2 rule, the AP address
#include "setup_session.h"   // S4: ISetupOutcome (what the session asks the form: saved / exited)

namespace esp32cam_setup {

using namespace esp32cam_settings;

static const char* const KEY_WIFI = "WIFI";

const size_t MAX_BODY_BYTES      = 4096;   // a POST body larger than this is refused (413)
const size_t MAX_FORM_FIELDS     = 96;     // 16 WiFi rows x 3 + the settings + token + password fields
const size_t MAX_FIELD_NAME      = 40;
const size_t MIN_TOKEN_LENGTH    = 16;     // a shorter CSRF token is treated as "no token": every POST is refused
const size_t MIN_WIFI_ROWS       = 3;      // blank rows offered when the board has few networks

// ── Reply ───────────────────────────────────────────────────────────────

// What the HTTP server sends back. The headers (security headers, Location, Allow) are decided
// here, where they are tested, not in the hardware glue.
struct HttpReply {
    int status;
    std::string contentType;
    std::string body;
    std::vector<std::pair<std::string, std::string> > headers;
    HttpReply() : status(500), contentType("text/plain; charset=utf-8") {}
};

// What the form needs to know that is not in the settings table.
struct FormConfig {
    std::string title;                          // shown in the page, e.g. the setup SSID
    std::vector<std::string> prerequisites;     // the settings that let the board reach the relay (remoteFillPossible):
                                                // while they are not all there the board is "blank" and /exit is not offered
};

// ── Text helpers ────────────────────────────────────────────────────────

inline int hexDigitValue(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

// application/x-www-form-urlencoded text -> plain text. Strict: a '%' not followed by two hex
// digits, a raw control character, or a decoded NUL (%00) is an error (a NUL would cut the value
// short wherever it meets C-string code), never silently "fixed". Messages never contain the text.
inline bool urlDecode(const std::string& in, std::string& out, std::string& err) {
    out.clear();
    for (size_t i = 0; i < in.size(); ++i) {
        char c = in[i];
        if (c == '+') { out += ' '; continue; }
        if (c == '%') {
            int hi = i + 1 < in.size() ? hexDigitValue(in[i + 1]) : -1;
            int lo = i + 2 < in.size() ? hexDigitValue(in[i + 2]) : -1;
            if (hi < 0 || lo < 0) { err = "a %-escape is cut off or not hexadecimal"; out.clear(); return false; }
            char decoded = static_cast<char>(hi * 16 + lo);
            if (decoded == '\0') { err = "the request contains a NUL byte"; out.clear(); return false; }
            out += decoded;
            i += 2;
            continue;
        }
        if (isCtrlChar(c)) { err = "the request contains a raw control character"; out.clear(); return false; }
        out += c;
    }
    return true;
}

struct FormField {
    std::string name;
    std::string value;
};

inline bool isFieldNameChar(char c) {
    return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') ||
           c == '_' || c == '.' || c == '-';
}

// "a=1&b=2" -> fields. Refuses (with a message that never repeats the content): a body over
// MAX_BODY_BYTES, more than MAX_FORM_FIELDS fields, a piece without '=', a name that is empty,
// too long or not [A-Za-z0-9_.-], a name given twice (which of the two counts is ambiguous, and
// an ambiguity is how requests get smuggled), and anything urlDecode refuses. Empty pieces
// ("a=1&&b=2", a trailing '&') are skipped.
inline bool parseUrlEncoded(const std::string& body, std::vector<FormField>& out, std::string& err) {
    out.clear();
    if (body.size() > MAX_BODY_BYTES) { err = "the request is too large"; return false; }
    size_t pos = 0;
    while (pos <= body.size()) {
        size_t amp = body.find('&', pos);
        if (amp == std::string::npos) amp = body.size();
        std::string piece = body.substr(pos, amp - pos);
        pos = amp + 1;
        if (piece.empty()) continue;

        size_t eq = piece.find('=');
        if (eq == std::string::npos) { err = "a form field has no '='"; out.clear(); return false; }
        FormField f;
        std::string e;
        if (!urlDecode(piece.substr(0, eq), f.name, e) || !urlDecode(piece.substr(eq + 1), f.value, e)) {
            err = e;
            out.clear();
            return false;
        }
        bool nameOk = !f.name.empty() && f.name.size() <= MAX_FIELD_NAME;
        for (size_t k = 0; k < f.name.size(); ++k) if (!isFieldNameChar(f.name[k])) nameOk = false;
        if (!nameOk) { err = "a form field has an invalid name"; out.clear(); return false; }
        for (size_t k = 0; k < out.size(); ++k) {
            if (out[k].name == f.name) { err = "a form field is given twice"; out.clear(); return false; }
        }
        if (out.size() >= MAX_FORM_FIELDS) { err = "the request has too many fields"; out.clear(); return false; }
        out.push_back(f);
    }
    return true;
}

inline const std::string* findField(const std::vector<FormField>& fields, const std::string& name) {
    for (size_t i = 0; i < fields.size(); ++i) if (fields[i].name == name) return &fields[i].value;
    return nullptr;
}

// For text placed into HTML (element text or a double- or single-quoted attribute). Control
// characters can't occur in a validated value but flash can hold anything, so they become spaces.
inline std::string htmlEscape(const std::string& s) {
    std::string out;
    out.reserve(s.size() + 8);
    for (size_t i = 0; i < s.size(); ++i) {
        char c = s[i];
        switch (c) {
            case '&':  out += "&amp;";  break;
            case '<':  out += "&lt;";   break;
            case '>':  out += "&gt;";   break;
            case '"':  out += "&quot;"; break;
            case '\'': out += "&#39;";  break;
            default:
                out += isCtrlChar(c) ? ' ' : c;
        }
    }
    return out;
}

// Same result whatever the first difference is, so response timing says nothing about how many
// leading characters of the token were right.
inline bool constantTimeEquals(const std::string& a, const std::string& b) {
    size_t n = a.size() > b.size() ? a.size() : b.size();
    unsigned char diff = static_cast<unsigned char>(a.size() != b.size());
    for (size_t i = 0; i < n; ++i) {
        unsigned char x = i < a.size() ? static_cast<unsigned char>(a[i]) : 0;
        unsigned char y = i < b.size() ? static_cast<unsigned char>(b[i]) : 0;
        diff = static_cast<unsigned char>(diff | (x ^ y));
    }
    return diff == 0;
}

// ── The master password rule ────────────────────────────────────────────

// "" when `password` may be the master password, else why not (the message never contains it).
// The rule itself is S2's (validSetupPassword: what WPA2 accepts; isDefaultSetupPassword: the
// public default); this only turns "no" into a sentence.
inline std::string masterPasswordProblem(const std::string& password) {
    if (!validSetupPassword(password)) {
        return "must be 8 to 63 plain characters (letters, digits, spaces, punctuation; no accents) - it is the setup WiFi's WPA2 password";
    }
    if (isDefaultSetupPassword(password)) return "is still the built-in default password, which everybody knows - choose your own";
    return "";
}

// True when the board already holds a master password of its own that the rule accepts.
inline bool hasOwnMasterPassword(const Schema& schema, ISettingsStore& store) {
    const KeyDef* def = findKey(schema, SETUP_PASSWORD_KEY);
    if (!def || !store.has(SETUP_PASSWORD_KEY)) return false;
    std::string stored = store.get(SETUP_PASSWORD_KEY), err;
    return validateStored(*def, stored, err) && masterPasswordProblem(stored).empty();
}

// ── Building the settings line from a submitted form ────────────────────

inline std::string fieldOf(const std::string& key)           { return "v." + key; }
inline std::string rowField(const char* part, size_t row)    { return std::string("w.") + part + "." + std::to_string(static_cast<unsigned long long>(row)); }

// Structured values may be pasted with stray spaces; free text, secrets and WiFi names may
// legitimately start or end with one, so those are left exactly as typed.
inline bool trimsWhitespace(Kind k) {
    return k != Kind::Text && k != Kind::Secret && k != Kind::Wifi;
}

inline void addPair(std::string& line, const std::string& key, const std::string& rawEscaped) {
    if (!line.empty()) line += ';';
    line += key + "=" + rawEscaped;
}

// The WIFI rows -> "WIFI=ssid:pass:...". A row with a blank password keeps the stored password of
// the stored network with the same name (so changing the relay does not mean retyping the WiFi);
// a new network with a blank password must be ticked "open network" explicitly rather than guessed.
// A blank name drops the row. If no row is filled in at all the setting is left unchanged (like
// every other blank field); removing every network is a serial-only job.
inline void addWifiRows(ISettingsStore& store, const std::vector<FormField>& fields,
                        std::string& line, std::vector<std::string>& errors) {
    bool anyRow = false;
    for (size_t i = 1; i <= MAX_WIFI_NETWORKS; ++i) {
        if (findField(fields, rowField("ssid", i)) || findField(fields, rowField("pass", i)) ||
            findField(fields, rowField("open", i))) anyRow = true;
    }
    if (!anyRow) return;

    std::vector<WifiNet> stored;
    if (store.has(KEY_WIFI)) {
        std::string e;
        if (!parseWifiList(store.get(KEY_WIFI), stored, e)) stored.clear();   // damaged: nothing to keep
    }

    std::vector<WifiNet> nets;
    for (size_t i = 1; i <= MAX_WIFI_NETWORKS; ++i) {
        const std::string* ssid = findField(fields, rowField("ssid", i));
        const std::string* pass = findField(fields, rowField("pass", i));
        const std::string* open = findField(fields, rowField("open", i));
        std::string name = ssid ? *ssid : "";
        std::string word = pass ? *pass : "";
        bool isOpen = open && *open == "1";
        std::string where = "WiFi network " + std::to_string(static_cast<unsigned long long>(i));

        if (name.empty()) {
            if (!word.empty()) errors.push_back(where + ": a password is typed but the network name is empty");
            continue;
        }
        WifiNet net;
        net.ssid = name;
        if (isOpen && !word.empty()) {
            errors.push_back(where + ": tick \"open network\" or type a password, not both");
            continue;
        }
        if (isOpen) {
            nets.push_back(net);
            continue;
        }
        if (!word.empty()) {
            net.pass = word;
            nets.push_back(net);
            continue;
        }
        bool kept = false;
        for (size_t s = 0; s < stored.size() && !kept; ++s) {
            if (stored[s].ssid == name && !stored[s].pass.empty()) { net.pass = stored[s].pass; kept = true; }
        }
        if (!kept) {
            errors.push_back(where + ": type its password, or tick \"open network\"");
            continue;
        }
        nets.push_back(net);
    }
    if (nets.empty()) return;
    addPair(line, KEY_WIFI, joinWifiList(nets));   // joinWifiList already escapes for the line format
}

// The master password the board will have after this form, and what is wrong with it.
// Typing a new one needs the second field to match (a typo here would lock everybody out of every
// later setup until someone brings a cable); leaving both blank keeps the stored one, which is
// only allowed when it is already a real, non-default one.
inline void checkMasterPassword(const Schema& schema, ISettingsStore& store,
                                const std::vector<FormField>& fields, std::string& line,
                                std::vector<std::string>& errors) {
    const std::string* typed = findField(fields, fieldOf(SETUP_PASSWORD_KEY));
    const std::string* again = findField(fields, fieldOf(SETUP_PASSWORD_KEY) + ".confirm");
    if (typed && !typed->empty()) {
        std::string problem = masterPasswordProblem(*typed);
        if (!problem.empty()) { errors.push_back("The master password " + problem); return; }
        if (!again || *again != *typed) { errors.push_back("The two master password fields are not the same"); return; }
        addPair(line, SETUP_PASSWORD_KEY, escapeText(*typed, false));
        return;
    }
    if (!hasOwnMasterPassword(schema, store)) {
        errors.push_back("Choose your own master password: this board is still using the built-in default, "
                         "which is public. It protects this setup WiFi from now on");
    }
}

// All problems found without writing anything; `line` is only meaningful when `errors` is empty.
// Settings the form does not carry (SETUP_MODE) or treats specially (WIFI, the master password)
// are skipped in the generic loop.
inline std::string buildSettingsLine(const Schema& schema, ISettingsStore& store,
                                     const std::vector<FormField>& fields, std::vector<std::string>& errors) {
    std::string line;
    for (size_t i = 0; i < schema.count; ++i) {
        const KeyDef& def = schema.keys[i];
        std::string name = def.name;
        if (name == SETUP_MODE_KEY || name == SETUP_PASSWORD_KEY) continue;
        if (def.kind == Kind::Wifi) { addWifiRows(store, fields, line, errors); continue; }

        const std::string* f = findField(fields, fieldOf(name));
        if (!f) continue;
        std::string value = trimsWhitespace(def.kind) ? trimSpaces(*f) : *f;
        if (value.empty()) continue;   // blank = leave as it is (what is still missing is reported by the engine)
        addPair(line, name, escapeText(value, false));
    }
    checkMasterPassword(schema, store, fields, line, errors);
    // LAST: if the power goes between two writes the board must still be armed, not "done" and half set up.
    addPair(line, SETUP_MODE_KEY, "0");
    return line;
}

// ── Rendering ───────────────────────────────────────────────────────────

inline void addOption(std::string& html, const std::string& value, const std::string& label, bool selected) {
    html += "<option value=\"" + htmlEscape(value) + "\"" + (selected ? " selected" : "") + ">" + htmlEscape(label) + "</option>";
}

// The input for one setting. `current` is what to show: what the user submitted last time, else
// what is stored (never for secrets).
inline std::string renderInput(const KeyDef& def, const std::string& current, bool secretIsSet) {
    std::string id = std::string("f-") + def.name;
    std::string name = fieldOf(def.name);
    std::string common = " id=\"" + htmlEscape(id) + "\" name=\"" + htmlEscape(name) + "\"";
    switch (def.kind) {
        case Kind::Secret:
            return "<input type=\"password\"" + common + " autocomplete=\"new-password\" placeholder=\"" +
                   (secretIsSet ? "set - leave blank to keep" : "not set") + "\">";
        case Kind::Int:
        case Kind::Float:
            return "<input type=\"number\"" + common + " value=\"" + htmlEscape(current) + "\" min=\"" +
                   htmlEscape(numText(def.min)) + "\" max=\"" + htmlEscape(numText(def.max)) + "\" step=\"" +
                   (def.kind == Kind::Int ? "1" : "any") + "\">";
        case Kind::Bool: {
            std::string h = "<select" + common + ">";
            if (current.empty()) addOption(h, "", "(not set)", true);
            addOption(h, "1", "1 - on / yes", current == "1");
            addOption(h, "0", "0 - off / no", current == "0");
            return h + "</select>";
        }
        case Kind::Level: {
            std::string h = "<select" + common + ">";
            if (current.empty()) addOption(h, "", "(not set)", true);
            addOption(h, "LOW", "LOW", current == "LOW");
            addOption(h, "HIGH", "HIGH", current == "HIGH");
            return h + "</select>";
        }
        case Kind::Pin:
        case Kind::PinOrOff: {
            std::string h = "<select" + common + ">";
            if (current.empty()) addOption(h, "", "(not set)", true);
            if (def.kind == Kind::PinOrOff) addOption(h, "-1", "-1 - off", current == "-1");
            for (int pin = 0; pin <= 48; ++pin) {
                if (!isUsableGpio(pin)) continue;
                std::string v = std::to_string(pin);
                addOption(h, v, "GPIO " + v, current == v);
            }
            return h + "</select>";
        }
        case Kind::Text:
        case Kind::Host:
        case Kind::Id:
        case Kind::Wifi:   // rendered by renderWifi, never here
            break;
    }
    return "<input type=\"text\"" + common + " value=\"" + htmlEscape(current) +
           "\" autocapitalize=\"off\" autocomplete=\"off\" spellcheck=\"false\">";
}

// The WIFI rows: what is submitted (after a rejected save) or else what is stored, plus blank rows
// to add networks. Passwords are never put into the page: a stored one is kept when the box is blank.
inline std::string renderWifi(const KeyDef& def, ISettingsStore& store, const std::vector<FormField>& submitted,
                              const std::string& tag) {
    struct Row { std::string ssid; bool open; bool hasPassword; };
    std::vector<Row> rows;

    size_t submittedRows = 0;
    for (size_t i = 1; i <= MAX_WIFI_NETWORKS; ++i) {
        if (findField(submitted, rowField("ssid", i)) || findField(submitted, rowField("open", i))) submittedRows = i;
    }
    if (submittedRows > 0) {
        for (size_t i = 1; i <= submittedRows; ++i) {
            const std::string* ssid = findField(submitted, rowField("ssid", i));
            const std::string* open = findField(submitted, rowField("open", i));
            Row r = { ssid ? *ssid : std::string(), open && *open == "1", false };   // a typed password is not brought back
            rows.push_back(r);
        }
    } else if (store.has(def.name)) {
        std::vector<WifiNet> nets;
        std::string e;
        if (parseWifiList(store.get(def.name), nets, e)) {
            for (size_t i = 0; i < nets.size(); ++i) {
                Row r = { nets[i].ssid, nets[i].pass.empty(), !nets[i].pass.empty() };
                rows.push_back(r);
            }
        }
    }
    size_t shown = rows.size() + 2;
    if (shown < MIN_WIFI_ROWS) shown = MIN_WIFI_ROWS;
    if (shown > MAX_WIFI_NETWORKS) shown = MAX_WIFI_NETWORKS;

    std::string h = "<fieldset><legend>" + htmlEscape(describeKey(def)) + tag + "</legend>";
    for (size_t i = 0; i < shown; ++i) {
        bool have = i < rows.size();
        std::string n = std::to_string(static_cast<unsigned long long>(i + 1));
        h += "<div class=\"net\"><input type=\"text\" name=\"" + rowField("ssid", i + 1) + "\" value=\"" +
             htmlEscape(have ? rows[i].ssid : std::string()) + "\" placeholder=\"network name " + n + "\" autocapitalize=\"off\" "
             "autocomplete=\"off\" spellcheck=\"false\">"
             "<input type=\"password\" name=\"" + rowField("pass", i + 1) + "\" autocomplete=\"new-password\" "
             "placeholder=\"" + std::string(have && rows[i].hasPassword ? "password set - blank keeps it" : "password") + "\">"
             "<label><input type=\"checkbox\" name=\"" + rowField("open", i + 1) + "\" value=\"1\"" +
             (have && rows[i].open ? " checked" : "") + "> open network</label></div>";
    }
    return h + "</fieldset>";
}

inline const char* pageStyle() {
    return "body{font-family:system-ui,sans-serif;margin:0;background:#f3f4f6;color:#111}"
           "main{max-width:36rem;margin:0 auto;padding:1rem}"
           "h1{font-size:1.3rem}.row,fieldset,.box{background:#fff;border:1px solid #d1d5db;border-radius:.5rem;padding:.6rem .8rem;margin:.6rem 0}"
           "label{display:block;font-size:.85rem;margin-bottom:.25rem}"
           "input[type=text],input[type=password],input[type=number],select{width:100%;box-sizing:border-box;font-size:1rem;padding:.45rem;margin:.15rem 0}"
           ".net{margin-bottom:.5rem}.net label{display:inline;font-size:.85rem}"
           ".tag{display:inline-block;font-size:.7rem;font-weight:bold;color:#fff;background:#b91c1c;border-radius:.3rem;padding:0 .35rem;margin-left:.4rem}"
           ".err{background:#fef2f2;border-color:#b91c1c}.note{font-size:.85rem;color:#374151}"
           "button{font-size:1rem;padding:.6rem 1rem;margin:.3rem 0;border-radius:.4rem;border:1px solid #1f2937;background:#1f2937;color:#fff;width:100%}"
           "button.secondary{background:#fff;color:#1f2937}";
}

inline void addSecurityHeaders(HttpReply& r, bool html) {
    r.headers.push_back(std::make_pair("Cache-Control", "no-store"));
    r.headers.push_back(std::make_pair("X-Content-Type-Options", "nosniff"));
    r.headers.push_back(std::make_pair("Referrer-Policy", "no-referrer"));
    if (html) {
        // No script at all; the one inline stylesheet is the only thing allowed to run in the page.
        r.headers.push_back(std::make_pair("Content-Security-Policy",
            "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"));
        r.headers.push_back(std::make_pair("X-Frame-Options", "DENY"));
    }
}

inline HttpReply htmlPage(int status, const std::string& title, const std::string& bodyHtml) {
    HttpReply r;
    r.status = status;
    r.contentType = "text/html; charset=utf-8";
    r.body = "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
             "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>" + htmlEscape(title) +
             "</title><style>" + pageStyle() + "</style></head><body><main>" + bodyHtml + "</main></body></html>";
    addSecurityHeaders(r, true);
    return r;
}

inline HttpReply textReply(int status, const std::string& text) {
    HttpReply r;
    r.status = status;
    r.body = text + "\n";
    addSecurityHeaders(r, false);
    return r;
}

// The whole form. `submitted` / `errors` are empty on the first visit; after a rejected save they
// bring the user's (non-secret) input back so nothing has to be typed again.
inline std::string renderForm(const Schema& schema, ISettingsStore& store, const FormConfig& cfg,
                              const std::string& csrfToken, const std::vector<FormField>& submitted,
                              const std::vector<std::string>& errors) {
    std::vector<Problem> problems = findProblems(schema, store);
    std::string h = "<h1>Set up " + htmlEscape(cfg.title) + "</h1>";
    if (!errors.empty()) {
        h += "<div class=\"box err\" role=\"alert\"><b>Nothing was saved.</b><ul>";
        for (size_t i = 0; i < errors.size(); ++i) h += "<li>" + htmlEscape(errors[i]) + "</li>";
        h += "</ul><p class=\"note\">Passwords are never sent back to this page: type again any you entered.</p></div>";
    }
    h += "<p class=\"note\">Blank fields stay as they are. Saving restarts the board and ends setup mode.</p>";
    h += "<form method=\"post\" action=\"/save\" autocomplete=\"off\"><input type=\"hidden\" name=\"csrf\" value=\"" +
         htmlEscape(csrfToken) + "\">";

    for (size_t i = 0; i < schema.count; ++i) {
        const KeyDef& def = schema.keys[i];
        std::string name = def.name;
        if (name == SETUP_MODE_KEY || name == SETUP_PASSWORD_KEY) continue;

        std::string tag;
        for (size_t p = 0; p < problems.size(); ++p) {
            if (problems[p].key != name) continue;
            tag = problems[p].missing ? "<span class=\"tag\">required</span>" : "<span class=\"tag\">invalid</span>";
        }
        if (def.kind == Kind::Wifi) { h += renderWifi(def, store, submitted, tag); continue; }

        std::string current;
        const std::string* sub = findField(submitted, fieldOf(name));
        if (def.kind != Kind::Secret) {
            if (sub) current = *sub;
            else if (store.has(name)) current = store.get(name);
        }
        h += "<div class=\"row\"><label for=\"f-" + htmlEscape(name) + "\">" + htmlEscape(describeKey(def)) + tag + "</label>" +
             renderInput(def, current, def.kind == Kind::Secret && store.has(name)) + "</div>";
    }

    bool own = hasOwnMasterPassword(schema, store);
    h += "<div class=\"row\"><label for=\"f-" + std::string(SETUP_PASSWORD_KEY) + "\"><b>Master password</b> - the password of this setup WiFi, "
         "the same for every board. " + (own ? "One is set; leave blank to keep it." : "<b>Not set: the public default is still in use, choose your own now.</b>") +
         (own ? "" : "<span class=\"tag\">required</span>") + "</label>"
         "<input type=\"password\" id=\"f-" + std::string(SETUP_PASSWORD_KEY) + "\" name=\"" + fieldOf(SETUP_PASSWORD_KEY) +
         "\" autocomplete=\"new-password\" placeholder=\"" + (own ? "set - leave blank to keep" : "new master password, 8-63 characters") + "\">"
         "<input type=\"password\" name=\"" + fieldOf(SETUP_PASSWORD_KEY) + ".confirm\" autocomplete=\"new-password\" placeholder=\"the same again\"></div>";

    h += "<button type=\"submit\">Save and restart</button></form>";

    if (remoteFillPossible(schema, store, cfg.prerequisites)) {
        h += "<form method=\"post\" action=\"/exit\"><input type=\"hidden\" name=\"csrf\" value=\"" + htmlEscape(csrfToken) + "\">"
             "<button type=\"submit\" class=\"secondary\">Exit setup mode (change nothing)</button></form>";
    }
    return h;
}

// ── The request handler ─────────────────────────────────────────────────

// Addresses that phones and laptops request to find out whether they are behind a captive portal.
// They are sent to the form (a redirect is what tells the operating system "sign in here").
inline bool isCaptivePortalProbe(const std::string& path) {
    static const char* const probes[] = {
        "/generate_204", "/gen_204",                                  // Android / Chrome
        "/hotspot-detect.html", "/library/test/success.html",         // Apple
        "/connecttest.txt", "/ncsi.txt", "/redirect", "/fwlink",      // Windows
        "/canonical.html", "/success.txt",                            // Firefox
        "/check_network_status.txt",                                  // Linux NetworkManager variants
    };
    for (size_t i = 0; i < sizeof(probes) / sizeof(probes[0]); ++i) if (path == probes[i]) return true;
    return false;
}

class SetupForm : public ISetupOutcome {
public:
    // `csrfToken`: an unguessable string for this session (>= MIN_TOKEN_LENGTH characters, from the
    // hardware random generator). The schema must have SETUP_MODE and SETUP_PASSWORD: without them
    // the board could never leave the default password, so the form refuses to work at all.
    SetupForm(const Schema& schema, ISettingsStore& store, const FormConfig& cfg, const std::string& csrfToken)
        : schema_(schema), store_(store), cfg_(cfg), token_(csrfToken), saved_(false), exited_(false) {}

    // method: "GET" / "POST" (case-sensitive, as on the wire); target: the request target (path and
    // optional ?query, which is ignored); body: the request body, already limited by the server.
    HttpReply handle(const std::string& method, const std::string& target, const std::string& body) {
        std::string path = target.substr(0, target.find('?'));
        if (isCaptivePortalProbe(path)) return method == "GET" ? redirectToForm() : notAllowed("GET");
        if (path == "/") return method == "GET" ? formPage() : notAllowed("GET");
        if (path == "/save") return method == "POST" ? save(body) : notAllowed("POST");
        if (path == "/exit") return method == "POST" ? exitSetup(body) : notAllowed("POST");
        return textReply(404, "Not found");
    }

    bool saved() const override  { return saved_; }    // the settings were stored (and SETUP_MODE is 0): restart soon
    bool exited() const override { return exited_; }   // "Exit setup mode" was pressed (SETUP_MODE is 0): restart soon

private:
    bool ready() const {
        return findKey(schema_, SETUP_MODE_KEY) != nullptr && findKey(schema_, SETUP_PASSWORD_KEY) != nullptr;
    }
    bool done() const { return saved_ || exited_; }

    HttpReply notAllowed(const char* allow) {
        HttpReply r = textReply(405, "Method not allowed");
        r.headers.push_back(std::make_pair("Allow", allow));
        return r;
    }

    HttpReply redirectToForm() {
        HttpReply r = textReply(302, "Redirecting to the setup page");
        r.headers.push_back(std::make_pair("Location", std::string("http://") + SETUP_AP_IP + "/"));
        return r;
    }

    HttpReply restartingPage(const std::string& what) {
        return htmlPage(200, "Restarting", "<h1>" + htmlEscape(what) + "</h1><p>The board is restarting now and this setup WiFi "
                        "will disappear in a few seconds. You can close this page.</p>");
    }

    HttpReply formPage() {
        if (!ready()) return textReply(500, "Setup is unavailable: this firmware's settings table has no SETUP_MODE / SETUP_PASSWORD");
        if (done()) return restartingPage(saved_ ? "Saved" : "Setup mode ended");
        return htmlPage(200, "Setup", renderForm(schema_, store_, cfg_, token_, std::vector<FormField>(), std::vector<std::string>()));
    }

    // The checks every POST starts with. true: `fields` is the parsed form and the token was right.
    // false: `fail` is the answer to send, and nothing has been looked at beyond the token.
    bool acceptPost(const std::string& body, std::vector<FormField>& fields, HttpReply& fail) {
        if (!ready()) { fail = textReply(500, "Setup is unavailable: this firmware's settings table has no SETUP_MODE / SETUP_PASSWORD"); return false; }
        if (done()) { fail = textReply(409, "Already done, the board is restarting"); return false; }
        if (body.size() > MAX_BODY_BYTES) { fail = textReply(413, "The request is too large"); return false; }
        std::string err;
        if (!parseUrlEncoded(body, fields, err)) { fail = textReply(400, "Bad request: " + err); return false; }
        const std::string* sent = findField(fields, "csrf");
        if (token_.size() < MIN_TOKEN_LENGTH || !sent || !constantTimeEquals(*sent, token_)) {
            fail = textReply(403, "Forbidden: open the setup page again and resubmit it");
            return false;
        }
        return true;
    }

    HttpReply rejected(const std::vector<FormField>& fields, const std::vector<std::string>& errors) {
        return htmlPage(422, "Setup", renderForm(schema_, store_, cfg_, token_, fields, errors));
    }

    HttpReply save(const std::string& body) {
        std::vector<FormField> fields;
        HttpReply fail;
        if (!acceptPost(body, fields, fail)) return fail;

        std::vector<std::string> errors;
        std::string line = buildSettingsLine(schema_, store_, fields, errors);
        CheckedLine checked = checkLine(schema_, line);   // every value problem at once, nothing written
        errors.insert(errors.end(), checked.errors.begin(), checked.errors.end());
        if (!errors.empty()) return rejected(fields, errors);

        // Locked keys are only locked against the dashboard: here the user is at the board, so none.
        ChangeResult applied = applyChangeLine(schema_, store_, line, std::vector<std::string>());
        if (!applied.ok()) return rejected(fields, applied.errors);

        saved_ = true;
        return restartingPage("Saved");
    }

    HttpReply exitSetup(const std::string& body) {
        std::vector<FormField> fields;
        HttpReply fail;
        if (!acceptPost(body, fields, fail)) return fail;

        // A blank board has nothing to resume: leaving would only land it back here.
        if (!remoteFillPossible(schema_, store_, cfg_.prerequisites)) {
            return textReply(409, "This board has no settings yet, so there is nothing to go back to: fill in the form");
        }
        CheckedLine off = checkLine(schema_, std::string(SETUP_MODE_KEY) + "=0");
        if (!off.ok() || off.pairs.size() != 1) return textReply(500, "Internal error: SETUP_MODE=0 is not valid");
        const std::string& value = off.pairs[0].value;
        // Only SETUP_MODE is touched (not applyChangeLine: a board that the relay still has to fill in is
        // incomplete, and that must not stop it from leaving setup mode).
        if (!(store_.has(SETUP_MODE_KEY) && store_.get(SETUP_MODE_KEY) == value) && !store_.set(SETUP_MODE_KEY, value)) {
            return textReply(500, "Could not write SETUP_MODE to flash; nothing was changed");
        }
        exited_ = true;
        return restartingPage("Setup mode ended");
    }

    const Schema& schema_;
    ISettingsStore& store_;
    FormConfig cfg_;
    std::string token_;
    bool saved_;
    bool exited_;
};

}  // namespace esp32cam_setup
