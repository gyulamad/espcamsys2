// setup_session.h — the setup-mode session (F-21): when the board's own setup WiFi is opened,
// how long it stays, and when the board restarts. Plain, hardware-free C++11 (no Arduino
// includes) so it can be unit-tested on a desktop: tests/cpp/test_setup_mode_session.cpp.
// setup_mode.h (hardware glue) supplies the real access point behind ISetupNet.
//
// Why it is a state machine of its own: the access point, DNS and HTTP server cannot run on a
// desktop, but WHEN to open them and when to leave is the part that can take a camera out of
// service, so that is what is tested here, against fakes and a clock the caller passes in.
//
// The rules (handover F-21 §2):
//   * Not in setup (active = false)  -> Proceed at once, the network is never touched.
//   * In setup (a blank board, or SETUP_MODE = 1 — both behave the same): open the access
//     point and keep serving FOREVER. There is no timeout: when the WiFi of a whole site is being
//     replaced, many boards are armed at once and each needs as long as it takes to be visited.
//   * The form reports "saved" or "exited": persist SETUP_MODE = 0, keep serving a moment (so the
//     browser still gets its "restarting" page), tear the access point down, answer Restart.
//   * The access point fails to start: log, clean up, try again later. NEVER Proceed — a board
//     that was asked for setup must not quietly go back to normal operation.
//   * If SETUP_MODE = 0 cannot be stored, do NOT restart (the board would come straight back
//     into setup); keep serving and try again.
//
// The password is only ever passed to ISetupNet::startAccessPoint; it is never logged.
//
// Copied into every sketch folder that uses it (an Arduino sketch can only include files from
// its own folder); run_tests.sh checks the copies are identical. Edit one, copy it over the others.

#pragma once

#include <stdint.h>
#include <string>

namespace esp32cam_setup {

// The hardware half (setup_mode.h); a fake in the tests.
struct ISetupNet {
  virtual ~ISetupNet() {}
  // true = the access point is up and the servers are listening.
  virtual bool startAccessPoint(const std::string& ssid, const std::string& password) = 0;
  virtual void poll() = 0;  // serve DNS + HTTP; never blocks for long
  virtual void stop() = 0;  // access point and servers off, WiFi left clean for connectWifi()
};

// What the on-device form has decided. Sticky: once true it stays true.
struct ISetupOutcome {
  virtual ~ISetupOutcome() {}
  virtual bool saved() const = 0;
  virtual bool exited() const = 0;
};

// Makes the one-shot switch permanent (flash), idempotent. The form already clears SETUP_MODE in
// the store it works on; this is what guarantees it is really written before the restart.
struct ISetupStore {
  virtual ~ISetupStore() {}
  virtual bool clearSetupMode() = 0;  // true = SETUP_MODE is now 0/absent and stored
};

// Serial log lines (optional).
struct ISetupLog {
  virtual ~ISetupLog() {}
  virtual void line(const std::string& text) = 0;
};

enum class SetupStep { Running, Proceed, Restart };

struct SetupSessionConfig {
  std::string ssid;
  std::string password;
  uint32_t graceMs;  // keep serving this long after save/exit so the browser gets its reply
  uint32_t retryMs;  // pause between failed access-point starts / failed flash writes
};

class SetupMode {
 public:
  // active: the board is in setup mode (blank, or armed). Both are treated identically, so the
  // session does not need to know which one it is.
  SetupMode(bool active, const SetupSessionConfig& cfg, ISetupNet& net,
            const ISetupOutcome& outcome, ISetupStore& store, ISetupLog* log = nullptr)
      : cfg_(cfg), net_(net), outcome_(outcome), store_(store), log_(log),
        state_(active ? State::Starting : State::Passthrough) {}

  // Call it from the boot loop. Running: call again. Proceed: carry on with the normal boot.
  // Restart: ESP.restart().
  SetupStep step(uint32_t nowMs) {
    if (state_ == State::Passthrough) return SetupStep::Proceed;
    if (state_ == State::Done) return SetupStep::Restart;
    if (state_ == State::Starting || state_ == State::RetryWait) return stepStart(nowMs);

    // Serving, Clearing and Grace all keep the pages flowing: without it the "saved, restarting"
    // reply would never reach the browser.
    net_.poll();
    if (state_ == State::Serving) {
      if (!outcome_.saved() && !outcome_.exited()) return SetupStep::Running;
      say(outcome_.saved() ? "setup: saved, restarting" : "setup: left without saving, restarting");
      state_ = State::Clearing;
      hasMark_ = false;
    }
    if (state_ == State::Clearing) return stepClear(nowMs);
    return stepGrace(nowMs);
  }

  // Leaves the WiFi clean. Safe to call at any time and more than once; a session that never
  // touched the network leaves it alone.
  void stop() {
    if (!touched_) return;
    touched_ = false;
    net_.stop();
  }

 private:
  enum class State { Passthrough, Starting, RetryWait, Serving, Clearing, Grace, Done };

  // Unsigned subtraction stays right across the ~49.7-day millis() wrap, which a board that
  // waits "forever" will reach.
  static bool elapsed(uint32_t now, uint32_t since, uint32_t span) {
    return static_cast<uint32_t>(now - since) >= span;
  }

  void say(const std::string& text) {
    if (log_) log_->line(text);
  }

  SetupStep stepStart(uint32_t now) {
    if (state_ == State::RetryWait && !elapsed(now, mark_, cfg_.retryMs)) return SetupStep::Running;
    touched_ = true;
    if (net_.startAccessPoint(cfg_.ssid, cfg_.password)) {
      say("setup: WiFi '" + cfg_.ssid + "' is up");
      state_ = State::Serving;
      return SetupStep::Running;
    }
    net_.stop();  // a half-started access point would make the next attempt fail too
    say("setup: WiFi failed to start, will retry");
    mark_ = now;
    state_ = State::RetryWait;
    return SetupStep::Running;
  }

  SetupStep stepClear(uint32_t now) {
    if (hasMark_ && !elapsed(now, mark_, cfg_.retryMs)) return SetupStep::Running;
    if (!store_.clearSetupMode()) {
      say("setup: could not store SETUP_MODE=0, will retry");
      mark_ = now;
      hasMark_ = true;
      return SetupStep::Running;
    }
    mark_ = now;  // the grace period counts from the moment the switch is really off
    state_ = State::Grace;
    return stepGrace(now);
  }

  SetupStep stepGrace(uint32_t now) {
    if (!elapsed(now, mark_, cfg_.graceMs)) return SetupStep::Running;
    stop();
    state_ = State::Done;
    return SetupStep::Restart;
  }

  SetupSessionConfig cfg_;
  ISetupNet& net_;
  const ISetupOutcome& outcome_;
  ISetupStore& store_;
  ISetupLog* log_;
  State state_;
  uint32_t mark_ = 0;
  bool hasMark_ = false;
  bool touched_ = false;
};

}  // namespace esp32cam_setup
