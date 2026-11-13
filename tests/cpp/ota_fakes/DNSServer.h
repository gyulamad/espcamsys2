// DNSServer.h — desktop fake of the Arduino-ESP32 DNSServer library (the captive-portal DNS of
// setup_mode.h). It only records what the board asked of it; fake_core.h holds the state.
#include "fake_core.h"

enum class DNSReplyCode { NoError = 0, FormError = 1, ServerFailure = 2, NonExistentDomain = 3, NotImplemented = 4, Refused = 5 };

class DNSServer {
 public:
  void setErrorReplyCode(const DNSReplyCode&) {}
  bool start(const uint16_t& port, const String& domain, const IPAddress& ip) {
    (void)port;
    if (!fake::g().dnsOk) return false;
    fake::g().dnsRunning = true;
    fake::g().dnsDomain = domain.c_str();
    fake::g().dnsAnswer = ip.s_;
    return true;
  }
  void processNextRequest() { fake::g().dnsPolls++; }
  void stop() { fake::g().dnsRunning = false; }
};
