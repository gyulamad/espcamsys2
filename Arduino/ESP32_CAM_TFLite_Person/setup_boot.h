// setup_boot.h — everything the two sketches need to put the setup mode (F-21) into their start-up,
// except the radio itself: whether this boot is a setup boot, which WiFi name and password it uses,
// how the pieces (form, session, access point) are put together, and how SETUP_MODE is switched off.
// Plain C++11 (no Arduino includes): unit-tested on a desktop, tests/cpp/test_setup_boot_*.cpp.
//
// Why it is a class of its own: the sketches' setupSettings() would otherwise each carry a copy of
// this wiring (the two differ only in their key table, their relay prerequisites and their name), and
// the wiring is exactly where a mistake takes a camera out of service. The sketch only supplies the
// hardware (ISetupHardware, implemented by ArduinoSetupHardware in setup_mode.h) and calls step().
//
// A board that is NOT in setup (the normal case) is untouched: nothing is allocated, the hardware is
// never asked anything, step() answers Proceed. See handover F-21 §7.5.
//
// Copied into every sketch folder that uses it (an Arduino sketch can only include files from its own
// folder); run_tests.sh checks the copies are identical. Edit one, copy it over the others.

#pragma once

#include <stdint.h>

#include <functional>
#include <memory>
#include <string>
#include <vector>

#include "settings_logic.h"
#include "setup_form.h"      // HttpReply, SetupForm, FormConfig
#include "setup_logic.h"     // the reason, the SSID, the password, the constants
#include "setup_session.h"   // SetupMode and its interfaces

namespace esp32cam_setup {

// What the HTTP server calls for every request: (method, target, body) -> the reply. SetupForm::handle.
typedef std::function<HttpReply(const std::string&, const std::string&, const std::string&)> SetupHandler;

// The part that needs a radio, a random number generator and a serial port. setup_mode.h has the real
// one (ArduinoSetupHardware); the tests have a fake.
struct ISetupHardware {
    virtual ~ISetupHardware() {}
    virtual std::string mac() = 0;        // "AA:BB:CC:DD:EE:FF", the board's own address
    virtual std::string newToken() = 0;   // unguessable, per session: the form's CSRF token
    // The access point plus its DNS and HTTP servers, answering with `handler`. Called only when the
    // board really is in setup, so a normal boot never pays for the servers' memory.
    virtual std::unique_ptr<ISetupNet> openNet(const SetupHandler& handler) = 0;
    virtual void log(const std::string& line) = 0;   // one serial line; never the password
};

// A failed access-point start or flash write is tried again after this long.
static const uint32_t SETUP_RETRY_MS = 5000;

// Used when the board's MAC address is not usable for the name (cannot happen with an eFuse address,
// but a board in setup must open SOME network: the alternative is a camera that can never be set up).
static const char* const SETUP_FALLBACK_SSID = "espcamsys2-setup";

// ── SETUP_MODE = 0, for real ────────────────────────────────────────────

// Makes sure the one-shot switch is off in the store the board restarts from. The form already writes
// SETUP_MODE=0 as part of a save or an exit; this is the session's guarantee that it is really there
// before the restart (a restart with the switch still on would put the board straight back into
// setup), and that a damaged value does not survive either. Idempotent.
class SettingsSetupStore : public ISetupStore {
public:
    SettingsSetupStore(const esp32cam_settings::Schema& schema, esp32cam_settings::ISettingsStore& store)
        : schema_(schema), store_(store) {}

    bool clearSetupMode() override {
        const esp32cam_settings::KeyDef* def = esp32cam_settings::findKey(schema_, SETUP_MODE_KEY);
        if (!def || !store_.has(def->name)) return true;   // no switch, or never set: nothing to clear
        if (store_.get(def->name) == "0") return true;
        return store_.set(def->name, "0");
    }

private:
    const esp32cam_settings::Schema& schema_;
    esp32cam_settings::ISettingsStore& store_;
};

// ── The setup boot ──────────────────────────────────────────────────────

class SetupBoot {
public:
    // `type` is the relay's word for the board ("recorder" or "detector"); `prerequisites` the settings
    // it needs to reach the relay (what remoteFillPossible() takes).
    SetupBoot(const esp32cam_settings::Schema& schema, esp32cam_settings::ISettingsStore& store,
              const std::vector<std::string>& prerequisites, const std::string& type, ISetupHardware& hw)
        : reason_(setupReason(schema, store, prerequisites)), log_(hw) {
        if (reason_ == SetupReason::None) return;   // the normal boot: nothing is built, nothing is asked

        std::string ssid;
        if (!setupSsid(type, hw.mac(), ssid)) {
            hw.log("setup: this board's MAC address is not usable for the WiFi name, using a fixed one");
            ssid = SETUP_FALLBACK_SSID;
        }

        FormConfig formConfig;
        formConfig.title = ssid;
        formConfig.prerequisites = prerequisites;
        form_.reset(new SetupForm(schema, store, formConfig, hw.newToken()));

        SetupForm& form = *form_;
        net_ = hw.openNet([&form](const std::string& method, const std::string& target, const std::string& body) {
            return form.handle(method, target, body);
        });
        clear_.reset(new SettingsSetupStore(schema, store));

        SetupSessionConfig config;
        config.ssid = ssid;
        config.password = setupPassword(schema, store);
        config.graceMs = SETUP_RESTART_GRACE_MS;
        config.retryMs = SETUP_RETRY_MS;
        mode_.reset(new SetupMode(true, config, *net_, *form_, *clear_, &log_));
    }

    // Non-copyable: the session holds references into the members.
    SetupBoot(const SetupBoot&) = delete;
    SetupBoot& operator=(const SetupBoot&) = delete;

    ~SetupBoot() { stop(); }

    // The board is in setup mode this boot (blank, or armed with SETUP_MODE).
    bool active() const { return reason_ != SetupReason::None; }
    // Configured, and SETUP_MODE switched on: the serial conversation is not needed, the session runs alone.
    bool armed() const { return reason_ == SetupReason::Armed; }

    // Proceed: not in setup, carry on. Running: call again. Restart: restart the board.
    SetupStep step(uint32_t nowMs) {
        if (!mode_) return SetupStep::Proceed;
        return mode_->step(nowMs);
    }

    // The access point and the servers off, WiFi clean for connectWifi(). Safe to call at any time.
    void stop() {
        if (mode_) mode_->stop();
    }

private:
    // The session talks to the serial port through the hardware; this adapts one call to the other.
    class HardwareLog : public ISetupLog {
    public:
        explicit HardwareLog(ISetupHardware& hw) : hw_(hw) {}
        void line(const std::string& text) override { hw_.log(text); }
    private:
        ISetupHardware& hw_;
    };

    SetupReason reason_;
    HardwareLog log_;
    // Declaration order is destruction order backwards: the session goes first, then what it points at.
    std::unique_ptr<SetupForm> form_;
    std::unique_ptr<ISetupNet> net_;
    std::unique_ptr<SettingsSetupStore> clear_;
    std::unique_ptr<SetupMode> mode_;
};

}  // namespace esp32cam_setup
