// relay_health.h — tracks when the relay was last CONFIRMED alive, so relay-find
// (relay_find_logic.h) knows when to look for it again. Pure C++11, no Arduino
// includes, so it is unit-tested on a desktop: tests/cpp/test_relay_health.cpp.
//
// The rule: the relay is "down" (relay-find should run) when it has not been
// CONFIRMED for longer than the threshold. A confirmation is a POSITIVE signal
// that the peer is really the relay — NOT a bare TCP connect. A router's web
// admin on the relay's port accepts TCP and returns 404 for unknown paths, and
// that must not count as "the relay is OK": if it did, relayDown would never go
// true, relay-find would never run, and the board would 404-loop against the
// router forever.
//
// Copied into every sketch folder that uses it; run_tests.sh checks the copies
// are identical. Edit one, copy it over the others.

#pragma once

#include <stdint.h>

class RelayHealth {
 public:
  void confirm(uint32_t now) { confirmed_ = true; lastConfirmedMs_ = now; }
  bool isDown(uint32_t now, uint32_t thresholdMs) const {
    if (!confirmed_) return true;
    return (int32_t)(now - lastConfirmedMs_) > (int32_t)thresholdMs;
  }
  uint32_t lastConfirmedMs() const { return lastConfirmedMs_; }
 private:
  bool confirmed_ = false;
  uint32_t lastConfirmedMs_ = 0;
};
