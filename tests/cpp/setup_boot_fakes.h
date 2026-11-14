// setup_boot_fakes.h — a fake of the hardware a setup boot needs (ISetupHardware, setup_boot.h): the
// board's address, a token, the access point and the serial port. Used by the SetupBoot tests and, under
// the name ArduinoSetupHardware, by the tests that compile the sketches' settings glue (the real class
// needs the Arduino core; the glue only needs something with the same name and shape).
//
// The including file includes the sketch's settings_logic.h (through its settings_schema.h) and
// setup_boot.h first. Everything the fake does is recorded in one `setupWorld()`, which a test resets
// at the start and may script: `onPoll` is called on every poll of the access point, so a test can
// play the phone that opens the form and presses a button.

#pragma once

#include <functional>
#include <memory>
#include <string>
#include <vector>

struct FakeSetupWorld {
    std::string mac;                // what mac() answers
    std::string token;              // what newToken() answers
    int macCalls, tokenCalls, opens, starts, polls, stops;
    int failStarts;                 // the next N startAccessPoint() calls fail
    std::string ssid, password;     // what the access point was last started with
    esp32cam_setup::SetupHandler handler;   // what the HTTP server calls, as given to openNet()
    std::function<void()> onPoll;   // plays the phone
    std::vector<std::string> logs;  // the serial lines

    FakeSetupWorld() { reset(); }
    void reset() {
        mac = "AA:BB:CC:D4:E5:F6";
        token = "0123456789abcdef0123456789abcdef";
        macCalls = tokenCalls = opens = starts = polls = stops = 0;
        failStarts = 0;
        ssid.clear();
        password.clear();
        handler = esp32cam_setup::SetupHandler();
        onPoll = std::function<void()>();
        logs.clear();
    }
    int touched() const { return macCalls + tokenCalls + opens + starts + polls + stops + static_cast<int>(logs.size()); }
    bool logged(const std::string& part) const {
        for (size_t i = 0; i < logs.size(); ++i) if (logs[i].find(part) != std::string::npos) return true;
        return false;
    }
};

inline FakeSetupWorld& setupWorld() {
    static FakeSetupWorld w;
    return w;
}

struct FakeSetupNet : esp32cam_setup::ISetupNet {
    bool startAccessPoint(const std::string& ssid, const std::string& password) override {
        FakeSetupWorld& w = setupWorld();
        w.starts++;
        w.ssid = ssid;
        w.password = password;
        if (w.failStarts > 0) { w.failStarts--; return false; }
        return true;
    }
    void poll() override {
        FakeSetupWorld& w = setupWorld();
        w.polls++;
        if (w.onPoll) w.onPoll();
    }
    void stop() override { setupWorld().stops++; }
};

class FakeSetupHardware : public esp32cam_setup::ISetupHardware {
public:
    std::string mac() override { setupWorld().macCalls++; return setupWorld().mac; }
    std::string newToken() override { setupWorld().tokenCalls++; return setupWorld().token; }
    std::unique_ptr<esp32cam_setup::ISetupNet> openNet(const esp32cam_setup::SetupHandler& handler) override {
        setupWorld().opens++;
        setupWorld().handler = handler;
        return std::unique_ptr<esp32cam_setup::ISetupNet>(new FakeSetupNet());
    }
    void log(const std::string& line) override { setupWorld().logs.push_back(line); }
};
