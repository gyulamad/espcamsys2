// settings_glue_fakes.h — fakes of the Arduino/ESP32 side shared by the tests
// that compile a sketch's "Settings glue" block (test_settings_glue.cpp,
// test_person_settings_glue.cpp): the flash (Preferences), the serial port, the
// clock and ESP.restart(). Include after framework.h and before the glue block.

#pragma once

#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <map>
#include <string>
#include <vector>

// ── fakes of the Arduino/ESP32 side ─────────────────────────────────────

static uint32_t g_now = 0;
static uint32_t millis() { return g_now; }
static void delay(uint32_t ms) { g_now += ms; }

struct String {
    std::string s;
    String(const char* c = "") : s(c) {}
    const char* c_str() const { return s.c_str(); }
};

// The flash: a static map, so it "survives a reboot" like the real thing.
static std::map<std::string, std::string> g_flash;
static bool g_flashBeginOk = true;
static bool g_flashWriteOk = true;
static int g_prefsOpen = 0;
static std::string g_prefsNamespace;
static bool g_prefsReadOnly = true;
struct Preferences {
    bool begin(const char* ns, bool readOnly) { g_prefsNamespace = ns; g_prefsReadOnly = readOnly; g_prefsOpen++; return g_flashBeginOk; }
    void end() { g_prefsOpen--; }
    bool isKey(const char* k) { return g_flash.count(k) > 0; }
    String getString(const char* k, const char* def) { return g_flash.count(k) ? String(g_flash[k].c_str()) : String(def); }
    size_t putString(const char* k, const char* v) {
        if (!g_flashWriteOk) return 0;
        g_flash[k] = v;
        return strlen(v);
    }
    bool clear() { g_flash.clear(); return true; }
};

// The serial port: input arrives at scripted moments of the fake clock.
struct Incoming { uint32_t at; std::string text; };
static std::vector<Incoming> g_incoming;
static std::string g_rx;
static std::vector<std::string> g_serialOut;
static int g_flushes = 0;
struct FakeSerial {
    void pump() {
        for (size_t i = 0; i < g_incoming.size();) {
            if (g_now >= g_incoming[i].at) { g_rx += g_incoming[i].text; g_incoming.erase(g_incoming.begin() + i); }
            else ++i;
        }
    }
    int available() { pump(); return static_cast<int>(g_rx.size()); }
    int read() { pump(); if (g_rx.empty()) return -1; int c = static_cast<unsigned char>(g_rx[0]); g_rx.erase(0, 1); return c; }
    void println(const char* s) { g_serialOut.push_back(s); }
    void printf(const char* fmt, ...) __attribute__((format(printf, 2, 3))) {
        char buf[512];
        va_list ap; va_start(ap, fmt); vsnprintf(buf, sizeof(buf), fmt, ap); va_end(ap);
        g_serialOut.push_back(buf);
    }
    void flush() { g_flushes++; }
} Serial;

static int g_restarts = 0;
struct FakeEsp { void restart() { g_restarts++; } } ESP;

// ── helpers shared by the glue tests ────────────────────────────────────

static void eraseFlash() { g_flash.clear(); }
static void typeAt(uint32_t ms, const std::string& text) { g_incoming.push_back({ ms, text }); }
static bool said(const char* part) {
    for (size_t i = 0; i < g_serialOut.size(); ++i) if (g_serialOut[i].find(part) != std::string::npos) return true;
    return false;
}

