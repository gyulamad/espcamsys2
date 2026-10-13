// settings_fakes.h — in-memory stand-ins for what the settings engine talks to,
// shared by the desktop tests of the engine and of each sketch's key table:
// MemoryStore (the flash) and ScriptConsole (the serial port). Include after
// settings_logic.h.

#pragma once

#include <map>
#include <string>
#include <vector>

using namespace esp32cam_settings;

// ── fakes ───────────────────────────────────────────────────────────────

// The real flash logs an error whenever a key that doesn't exist is read, so
// the engine must only ever get() a key it has checked with has() — counted.
struct MemoryStore : ISettingsStore {
    std::map<std::string, std::string> m;
    bool failWrites = false;
    int badGets = 0;
    int clears = 0;
    bool has(const std::string& k) override { return m.count(k) > 0; }
    std::string get(const std::string& k) override {
        std::map<std::string, std::string>::iterator it = m.find(k);
        if (it == m.end()) { badGets++; return ""; }
        return it->second;
    }
    bool set(const std::string& k, const std::string& v) override {
        if (failWrites) return false;
        m[k] = v;
        return true;
    }
    void clearAll() override { m.clear(); clears++; }
};

struct ScriptConsole : IConsole {
    std::string in;
    size_t pos = 0;
    std::vector<std::string> out;
    int read() override { return pos < in.size() ? static_cast<unsigned char>(in[pos++]) : -1; }
    void println(const std::string& s) override { out.push_back(s); }
    bool said(const std::string& part) const {
        for (size_t i = 0; i < out.size(); ++i) if (out[i].find(part) != std::string::npos) return true;
        return false;
    }
    int count(const std::string& part) const {
        int n = 0;
        for (size_t i = 0; i < out.size(); ++i) if (out[i].find(part) != std::string::npos) n++;
        return n;
    }
    void clear() { out.clear(); }
};

