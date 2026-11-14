// setup_logic.h — the pure decisions behind the cable-free first setup (F-21):
// WHEN a board opens its own setup WiFi, what that WiFi is called, and which
// password protects it. No Arduino/ESP includes: the hardware is reached only
// through ISettingsStore, so all of this is compiled and tested on a desktop
// (tests/cpp/test_setup_logic.cpp), like settings_logic.h.
//
// Rules for anything added to this file (same as settings_logic.h):
//   - Only standard C++11, so the ESP32 toolchain builds it.
//   - Reuse settings_logic.h (validateStored, remoteFillPossible, ...); never
//     re-implement a check that already lives there.
//
// COPIES: deliberately duplicated into every sketch folder (an Arduino sketch
// can only include files from its own folder). run_tests.sh fails if the copies
// differ — edit one, copy it to the other.

#pragma once

#include <cstddef>
#include <cstdint>
#include <string>
#include <vector>

#include "settings_logic.h"

namespace esp32cam_setup {

using esp32cam_settings::ISettingsStore;
using esp32cam_settings::Schema;

// ── Constants ───────────────────────────────────────────────────────────

// The two settings F-21 adds to the schema (S1). Named here so the logic and the
// form never spell them out twice.
static const char* const SETUP_MODE_KEY     = "SETUP_MODE";
static const char* const SETUP_PASSWORD_KEY = "SETUP_PASSWORD";

// The master password a board uses until its owner has chosen one. The built-in one is public
// (it is in the repository), so the form refuses to save while it is still the one in use; it
// only exists because a blank board has nothing else.
//
// A build can replace it with a private one of its own: define SETUP_DEFAULT_PASSWORD_OVERRIDE (a
// string literal) before this header is first included. The sketches do that from the git-ignored
// setup_credentials.local.h next to them (template: Arduino/templates/setup_credentials.example.h).
// Everything that asks "is this still the default?" reads these constants, so the form's rule follows
// the override (and still refuses the public built-in password, which stays public whatever a build uses). The checks below turn a bad override into a build error: at run time it
// would make softAP() refuse the passphrase and a blank board would have no setup WiFi at all.
static constexpr char SETUP_PUBLIC_PASSWORD[] = "Admin1234";   // the built-in one: in the repository, so known to everybody
#ifdef SETUP_DEFAULT_PASSWORD_OVERRIDE
static constexpr char SETUP_DEFAULT_PASSWORD[] = SETUP_DEFAULT_PASSWORD_OVERRIDE;
#else
static constexpr char SETUP_DEFAULT_PASSWORD[] = "Admin1234";
#endif

// WPA2 passphrases are 8 to 63 printable ASCII characters.
static const size_t WPA2_PASS_MIN = 8;
static const size_t WPA2_PASS_MAX = 63;

constexpr bool isPrintableAscii(const char* s, size_t i = 0) {
    return s[i] == '\0' ? true : (s[i] >= 0x20 && s[i] <= 0x7e && isPrintableAscii(s, i + 1));
}
static_assert(sizeof(SETUP_DEFAULT_PASSWORD) - 1 >= WPA2_PASS_MIN &&
              sizeof(SETUP_DEFAULT_PASSWORD) - 1 <= WPA2_PASS_MAX,
              "the default master password must be 8 to 63 characters (a WPA2 passphrase)");
static_assert(isPrintableAscii(SETUP_DEFAULT_PASSWORD),
              "the default master password must be printable ASCII (a WPA2 passphrase)");

// The ESP32's own access-point address: where the form lives.
static const char* const SETUP_AP_IP = "192.168.4.1";

// After a save or an exit the board waits this long before restarting, so the
// browser still receives the "restarting" page.
static const uint32_t SETUP_RESTART_GRACE_MS = 1500;

// An SSID is at most 32 bytes.
static const size_t SSID_MAX = 32;

// ── Why (or whether) the board opens its setup WiFi ─────────────────────

enum class SetupReason : uint8_t {
    None,          // run normally
    Unconfigured,  // can't reach the relay: nothing else to do but set up
    Armed          // configured, but the owner switched SETUP_MODE on
};

// `prerequisites` are the settings the board needs to reach the relay (the same
// list remoteFillPossible() takes; empty means "can't", so that is Unconfigured).
// Unconfigured wins over Armed: a board that can't reach the relay is in setup
// whatever the switch says. A damaged SETUP_MODE is NOT armed: opening an
// access point because of garbage in flash would be the unsafe way to be wrong.
inline SetupReason setupReason(const Schema& schema, ISettingsStore& store,
                               const std::vector<std::string>& prerequisites) {
    if (!esp32cam_settings::remoteFillPossible(schema, store, prerequisites)) return SetupReason::Unconfigured;

    const esp32cam_settings::KeyDef* def = esp32cam_settings::findKey(schema, SETUP_MODE_KEY);
    if (!def || !store.has(def->name)) return SetupReason::None;

    std::string raw = store.get(def->name);
    std::string norm, err;
    // Stored text is canonical (unescaped); validateValue wants the typed form.
    if (!esp32cam_settings::validateValue(*def, esp32cam_settings::escapeText(raw, false), norm, err)) return SetupReason::None;
    return norm == "1" ? SetupReason::Armed : SetupReason::None;
}

// ── The setup WiFi's name ───────────────────────────────────────────────

// "espcamsys2-<type>-<last 3 MAC bytes, lowercase hex>", e.g. espcamsys2-recorder-d4e5f6.
// `type` is the relay's word for the board ("recorder" or "detector"); `mac` is
// the 6 bytes as 12 hex digits, optionally separated by ':' or '-' (what
// WiFi.macAddress() returns). Anything else is refused, so a bad input can never
// produce an SSID that is empty, too long or has odd characters.
inline bool setupSsid(const std::string& type, const std::string& mac, std::string& out) {
    if (type != "recorder" && type != "detector") return false;

    // 12 hex digits, or 6 pairs joined by one repeated separator (17 characters).
    bool plain = mac.size() == 12;
    if (!plain && mac.size() != 17) return false;
    char sep = plain ? 0 : mac[2];
    if (!plain && sep != ':' && sep != '-') return false;

    std::string digits;
    for (size_t i = 0; i < mac.size(); ++i) {
        char c = mac[i];
        if (!plain && i % 3 == 2) {
            if (c != sep) return false;
            continue;
        }
        bool hex = (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F');
        if (!hex) return false;
        digits += (c >= 'A' && c <= 'F') ? static_cast<char>(c - 'A' + 'a') : c;
    }

    std::string ssid = "espcamsys2-" + type + "-" + digits.substr(6);
    if (ssid.size() > SSID_MAX) return false;
    out = ssid;
    return true;
}

// ── The master password ─────────────────────────────────────────────────

// Printable ASCII, 8 to 63 characters: what WPA2 accepts, and what the form must
// accept for the new master password too (one rule, here).
inline bool validSetupPassword(const std::string& pass) {
    if (pass.size() < WPA2_PASS_MIN || pass.size() > WPA2_PASS_MAX) return false;
    for (size_t i = 0; i < pass.size(); ++i) {
        if (pass[i] < 0x20 || pass[i] > 0x7e) return false;
    }
    return true;
}

// "Not chosen yet": the password this build starts with, or the public built-in one. The form refuses
// to save while the master password is either.
inline bool isDefaultSetupPassword(const std::string& pass) {
    return pass == SETUP_DEFAULT_PASSWORD || pass == SETUP_PUBLIC_PASSWORD;
}

// The password the setup WiFi uses now: the stored master password when there is
// a valid one, else the default. The result is always usable as a WPA2 passphrase.
inline std::string setupPassword(const Schema& schema, ISettingsStore& store) {
    const esp32cam_settings::KeyDef* def = esp32cam_settings::findKey(schema, SETUP_PASSWORD_KEY);
    if (!def || !store.has(def->name)) return SETUP_DEFAULT_PASSWORD;

    std::string stored = store.get(def->name);
    std::string err;
    if (!esp32cam_settings::validateStored(*def, stored, err)) return SETUP_DEFAULT_PASSWORD;
    if (!validSetupPassword(stored)) return SETUP_DEFAULT_PASSWORD;
    return stored;
}

}  // namespace esp32cam_setup
