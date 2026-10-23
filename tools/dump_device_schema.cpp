// dump_device_schema.cpp — prints one sketch's settings table (settings_schema.h) as a JSON member, so
// the dashboard's settings pages know every setting's kind, limits, conditions and help text without a
// second copy of the table to keep in sync. Built twice by tools/gen_device_schema.sh: as is, it dumps
// the Recorder ("recorder"); with -DDUMP_DETECTOR it dumps the person detector ("detector"). The two
// members are joined (and wrapped) into php/cameras/lib/device_schema.php.
//
//   tools/gen_device_schema.sh            rewrite that file
//   tests (run_tests.sh) fail when it is out of date.

#include <cstdio>
#include <string>

#ifdef DUMP_DETECTOR
#include "../Arduino/ESP32_CAM_TFLite_Person/settings_schema.h"
#define DUMP_NAME "detector"
#define DUMP_SCHEMA PERSON_SCHEMA
#define DUMP_LOCKED() personLockedKeys()
#else
#include "../Arduino/ESP32_CAM_Recorder/settings_schema.h"
#define DUMP_NAME "recorder"
#define DUMP_SCHEMA RECORDER_SCHEMA
#define DUMP_LOCKED() recorderLockedKeys()
#endif

using namespace esp32cam_settings;

static std::string jstr(const char* s) {
    if (!s) return "null";
    std::string out = "\"";
    for (const char* p = s; *p; ++p) {
        unsigned char c = static_cast<unsigned char>(*p);
        if (c == '"') out += "\\\"";
        else if (c == '\\') out += "\\\\";
        else if (c < 0x20) { char b[8]; std::snprintf(b, sizeof b, "\\u%04x", c); out += b; }
        else out += *p;
    }
    return out + "\"";
}

static const char* kindName(Kind k) {
    switch (k) {
        case Kind::Text: return "text";
        case Kind::Host: return "host";
        case Kind::Id: return "id";
        case Kind::Secret: return "secret";
        case Kind::Int: return "int";
        case Kind::Float: return "float";
        case Kind::Bool: return "bool";
        case Kind::Level: return "level";
        case Kind::Pin: return "pin";
        case Kind::PinOrOff: return "pin_or_off";
        case Kind::Wifi: return "wifi";
    }
    return "text";
}

static const char* condName(Cond c) {
    return c == Cond::Always ? "always" : (c == Cond::WhenEquals ? "equals" : "not_equals");
}

int main() {
    std::vector<std::string> locked = DUMP_LOCKED();
    std::printf("  \"" DUMP_NAME "\": {\n    \"keys\": [\n");
    for (size_t i = 0; i < DUMP_SCHEMA.count; ++i) {
        const KeyDef& d = DUMP_SCHEMA.keys[i];
        bool isLocked = false;
        for (size_t j = 0; j < locked.size(); ++j) if (locked[j] == d.name) isLocked = true;
        std::printf("      {\"name\": %s, \"kind\": \"%s\", \"min\": %s, \"max\": %s, \"cond\": \"%s\", \"condKey\": %s, \"condValue\": %s, \"locked\": %s, \"help\": %s}%s\n",
                    jstr(d.name).c_str(), kindName(d.kind), numText(d.min).c_str(), numText(d.max).c_str(), condName(d.cond),
                    jstr(d.condKey).c_str(), jstr(d.condValue).c_str(), isLocked ? "true" : "false", jstr(d.help).c_str(),
                    i + 1 < DUMP_SCHEMA.count ? "," : "");
    }
    // The pins the firmware accepts for a Pin / PinOrOff setting (isUsableGpio), so the dashboard never
    // keeps its own copy of the list.
    std::printf("    ],\n    \"gpios\": [");
    bool first = true;
    for (int pin = 0; pin <= 48; ++pin) {
        if (!isUsableGpio(pin)) continue;
        std::printf("%s%d", first ? "" : ", ", pin);
        first = false;
    }
    std::printf("]\n  }\n");
    return 0;
}
