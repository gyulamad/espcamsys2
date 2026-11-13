// setup_mode.h — the Arduino half of the cable-free setup mode (F-21): the board's own WiFi access
// point, a captive-portal DNS and a tiny HTTP server that hands every request to the pure form handler
// (SetupForm::handle in setup_form.h). What is DECIDED (when to open the AP, what the form accepts, when
// to restart) lives in setup_logic.h / setup_form.h / setup_session.h and is unit-tested; this file only
// joins it to the radio and to sockets: it implements ISetupNet (setup_session.h). The desktop
// tests compile it against fakes of the core (tests/cpp/test_setup_mode_glue.cpp); the real radio can
// only be checked on a board (S11).
//
// Copied into every sketch folder that uses it; the copies must be identical.
//
// Usage (the sketch, S6):
//     esp32cam_setup::ArduinoSetupNet net(handler);      // handler: (method, target, body) -> HttpReply, i.e. form.handle
//     net.startAccessPoint(ssid, pass);                  // false: log and try again later
//     for (;;) net.poll();                               // from the loop, with a delay() or yield() in it
//     net.stop();                                        // leaves the radio as connectWifi() expects
//
// Design points worth knowing before changing anything:
//  * The HTTP side is a small bounded reader on WiFiServer, not the WebServer library: WebServer reads
//    a POST body of any announced size into the heap before the handler runs and does not hand over the
//    raw urlencoded body, but the form handler needs both a hard size cap and the exact bytes (strict
//    decoding, duplicate-field detection). It is also smaller in flash (the Person sketch is tight).
//  * The AP is never open: a password outside 8..63 characters is refused BEFORE the radio is touched,
//    because softAP() with an empty password silently starts an unprotected network.
//  * WiFi.persistent(false) while the AP is up: otherwise the setup password and mode are written to
//    flash on every session. stop() puts it back to the core's default (true).
//  * The reply's headers (security headers, Location, Allow) are the form's decision and are sent as they
//    are; this file only adds the framing (status line, Content-Type, Content-Length, Connection: close)
//    and drops any handler header that could break it (CR/LF, a second Content-Length, ...).
//  * The password is never printed. Logs carry the SSID and the URL only.
//  * poll() never blocks for long and never calls delay(); the caller's loop must yield (the task
//    watchdog), like the rest of the sketches.
//
// Knobs (define before including to change):
//   SETUP_AP_CHANNEL            1     Wi-Fi channel of the access point
//   SETUP_AP_MAX_STATIONS       4     phones that may be joined at once
//   SETUP_HTTP_PORT             80
//   SETUP_DNS_PORT              53
//   SETUP_MAX_CONNECTIONS       4     open HTTP connections; more are closed at once
//   SETUP_HEAD_MAX              2048  bytes of request line + headers
//   SETUP_BODY_MAX              MAX_BODY_BYTES (4096) bytes of body
//   SETUP_REQUEST_TIMEOUT_MS    10000 a request that is not complete by then is dropped (slow-loris)
//   SETUP_READ_CHUNK            1024  bytes read from one connection per poll()

#pragma once

#include <Arduino.h>
#include <DNSServer.h>
#include <WiFi.h>
#include <esp_system.h>   // esp_random(): the hardware RNG, same as relay_find.h

#include <functional>
#include <string>

#include "setup_form.h"      // HttpReply, SetupForm
#include "setup_logic.h"     // SETUP_AP_IP
#include "setup_session.h"   // ISetupNet

#ifndef SETUP_AP_CHANNEL
#define SETUP_AP_CHANNEL 1
#endif
#ifndef SETUP_AP_MAX_STATIONS
#define SETUP_AP_MAX_STATIONS 4
#endif
#ifndef SETUP_HTTP_PORT
#define SETUP_HTTP_PORT 80
#endif
#ifndef SETUP_DNS_PORT
#define SETUP_DNS_PORT 53
#endif
#ifndef SETUP_MAX_CONNECTIONS
#define SETUP_MAX_CONNECTIONS 4
#endif
#ifndef SETUP_HEAD_MAX
#define SETUP_HEAD_MAX 2048
#endif
#ifndef SETUP_BODY_MAX
#define SETUP_BODY_MAX ((long)esp32cam_setup::MAX_BODY_BYTES)   // one cap for the reader and the form
#endif
#ifndef SETUP_REQUEST_TIMEOUT_MS
#define SETUP_REQUEST_TIMEOUT_MS 10000
#endif
#ifndef SETUP_READ_CHUNK
#define SETUP_READ_CHUNK 1024
#endif

#ifndef SETUP_INFO
#define SETUP_INFO(...) Serial.printf("[setup] " __VA_ARGS__), Serial.println()
#endif
#ifndef SETUP_WARN
#define SETUP_WARN(...) Serial.printf("[setup] WARN " __VA_ARGS__), Serial.println()
#endif

namespace esp32cam_setup {

// What the pure form handler is: (method, request target, raw body) -> reply. The target keeps its
// "?query" (the form ignores it); the body is the exact bytes, decoding is the form's job.
typedef std::function<HttpReply(const std::string&, const std::string&, const std::string&)> SetupHandler;

// ── the request reader ──────────────────────────────────────────────────────────────────────────
// Reads ONE request, a few bytes at a time, and refuses everything unusual with the status to answer
// (400/411/413/431/501): no chunked bodies, no folded or bare-LF headers, no control characters, no
// body without Content-Length, nothing past the caps. Pure: no sockets, so it is tested byte by byte.
class HttpRequestReader {
 public:
  enum Status { NeedMore, Complete, Rejected };

  HttpRequestReader() { reset(); }

  void reset() {
    buf_.clear(); method_.clear(); target_.clear(); body_.clear();
    headDone_ = false; contentLength_ = -1; rejectStatus_ = 0;
  }

  Status feed(const char* data, size_t n) {
    if (rejectStatus_) return Rejected;
    if (headDone_) {
      body_.append(data, n);
      return finishBody();
    }
    buf_.append(data, n);
    size_t end = buf_.find("\r\n\r\n");
    if (end == std::string::npos) {
      // no end of head yet: a head this long will never be accepted, so stop collecting it
      if (buf_.size() > (size_t)SETUP_HEAD_MAX) return reject(431);
      return NeedMore;
    }
    if (end > (size_t)SETUP_HEAD_MAX) return reject(431);
    std::string head = buf_.substr(0, end);
    body_ = buf_.substr(end + 4);
    buf_.clear();
    int status = parseHead(head);
    if (status) return reject(status);
    headDone_ = true;
    if (method_ == "POST" && contentLength_ < 0) return reject(411);
    if (contentLength_ > (long)SETUP_BODY_MAX) return reject(413);   // refused before the body is waited for
    return finishBody();
  }

  int rejectStatus() const { return rejectStatus_; }
  const std::string& method() const { return method_; }
  const std::string& target() const { return target_; }
  const std::string& body() const { return body_; }

 private:
  Status reject(int status) { rejectStatus_ = status; return Rejected; }

  Status finishBody() {
    size_t want = contentLength_ > 0 ? (size_t)contentLength_ : 0;
    if (body_.size() < want) return NeedMore;
    body_.resize(want);   // the connection is closed after one answer: whatever follows is ignored
    return Complete;
  }

  static bool isControl(unsigned char c) { return (c < 0x20 && c != '\t') || c == 0x7f; }

  static std::string lower(std::string s) {
    for (size_t i = 0; i < s.size(); ++i) if (s[i] >= 'A' && s[i] <= 'Z') s[i] = (char)(s[i] - 'A' + 'a');
    return s;
  }

  // 0 = fine, else the status to answer
  int parseHead(const std::string& head) {
    // a CR or LF that is not part of a CRLF pair, or any other control byte, is an attack or a bug
    for (size_t i = 0; i < head.size(); ++i) {
      unsigned char c = (unsigned char)head[i];
      if (c == '\r') { if (i + 1 >= head.size() || head[i + 1] != '\n') return 400; continue; }
      if (c == '\n') { if (i == 0 || head[i - 1] != '\r') return 400; continue; }
      if (isControl(c)) return 400;
    }
    size_t lineEnd = head.find("\r\n");
    int status = parseRequestLine(head.substr(0, lineEnd));
    if (status) return status;
    size_t pos = lineEnd == std::string::npos ? head.size() : lineEnd + 2;
    int headers = 0;
    while (pos < head.size()) {
      size_t e = head.find("\r\n", pos);
      std::string line = head.substr(pos, e == std::string::npos ? std::string::npos : e - pos);
      pos = e == std::string::npos ? head.size() : e + 2;
      if (++headers > 32) return 431;
      status = parseHeader(line);
      if (status) return status;
    }
    return 0;
  }

  int parseRequestLine(const std::string& line) {
    size_t a = line.find(' ');
    size_t b = a == std::string::npos ? a : line.find(' ', a + 1);
    if (b == std::string::npos) return 400;
    std::string method = line.substr(0, a), target = line.substr(a + 1, b - a - 1), version = line.substr(b + 1);
    if (method.empty() || method.size() > 8) return 400;
    for (size_t i = 0; i < method.size(); ++i) if (method[i] < 'A' || method[i] > 'Z') return 400;
    if (target.empty() || target.size() > 256 || target[0] != '/' || target.find(' ') != std::string::npos) return 400;
    if (version != "HTTP/1.1" && version != "HTTP/1.0") return 400;
    method_ = method;
    target_ = target;   // with its query: the form cuts it off itself
    return 0;
  }

  int parseHeader(const std::string& line) {
    size_t colon = line.find(':');
    if (colon == std::string::npos || colon == 0) return 400;       // also catches a folded line (it has no name)
    std::string name = line.substr(0, colon);
    if (name.find(' ') != std::string::npos || name.find('\t') != std::string::npos) return 400;
    name = lower(name);
    std::string value = line.substr(colon + 1);
    size_t s = value.find_first_not_of(" \t"), e = value.find_last_not_of(" \t");
    value = s == std::string::npos ? std::string() : value.substr(s, e - s + 1);
    if (name == "transfer-encoding") return 501;                    // chunked bodies are not read
    if (name != "content-length") return 0;
    if (value.empty() || value.size() > 9) return 400;
    long n = 0;
    for (size_t i = 0; i < value.size(); ++i) {
      if (value[i] < '0' || value[i] > '9') return 400;             // no sign, no hex, no exponent
      n = n * 10 + (value[i] - '0');
    }
    if (contentLength_ >= 0 && contentLength_ != n) return 400;     // two different lengths: request smuggling
    contentLength_ = n;
    return 0;
  }

  std::string buf_, method_, target_, body_;
  bool headDone_;
  long contentLength_;
  int rejectStatus_;
};

// ── the reply ───────────────────────────────────────────────────────────────────────────────────
inline const char* reasonPhrase(int status) {
  switch (status) {
    case 200: return "OK";
    case 301: return "Moved Permanently";
    case 302: return "Found";
    case 303: return "See Other";
    case 307: return "Temporary Redirect";
    case 308: return "Permanent Redirect";
    case 400: return "Bad Request";
    case 403: return "Forbidden";
    case 404: return "Not Found";
    case 405: return "Method Not Allowed";
    case 408: return "Request Timeout";
    case 411: return "Length Required";
    case 413: return "Payload Too Large";
    case 431: return "Request Header Fields Too Large";
    case 500: return "Internal Server Error";
    case 501: return "Not Implemented";
    default: return NULL;
  }
}

// The content type comes from the handler, but a stray CR/LF in it would split the reply: fall back to plain text.
inline bool safeHeaderValue(const std::string& v) {
  if (v.empty()) return false;
  for (size_t i = 0; i < v.size(); ++i) if ((unsigned char)v[i] < 0x20 || (unsigned char)v[i] == 0x7f) return false;
  return true;
}

// A header the handler asked for is sent only when it cannot break the message: a real name, no control
// character anywhere (CR/LF would end the header block and let a value inject headers or a body), and
// not one of the four the framing is built from here.
inline bool isFramingHeader(const std::string& name) {
  std::string n;
  for (size_t i = 0; i < name.size(); ++i) n += (name[i] >= 'A' && name[i] <= 'Z') ? (char)(name[i] - 'A' + 'a') : name[i];
  return n == "content-type" || n == "content-length" || n == "connection" || n == "transfer-encoding";
}

inline bool sendableHeader(const std::string& name, const std::string& value) {
  if (name.empty() || name.size() > 64 || value.size() > 512 || isFramingHeader(name)) return false;
  for (size_t i = 0; i < name.size(); ++i) {
    unsigned char c = (unsigned char)name[i];
    if (c <= 0x20 || c >= 0x7f || c == ':') return false;
  }
  for (size_t i = 0; i < value.size(); ++i) {
    unsigned char c = (unsigned char)value[i];
    if ((c < 0x20 && c != '\t') || c == 0x7f) return false;
  }
  return true;
}

// The whole answer as bytes.
inline std::string formatHttpReply(const HttpReply& reply) {
  int status = reasonPhrase(reply.status) ? reply.status : 500;
  std::string type = safeHeaderValue(reply.contentType) ? reply.contentType : "text/plain";
  std::string out = "HTTP/1.1 " + std::to_string(status) + " " + reasonPhrase(status) + "\r\n";
  out += "Content-Type: " + type + "\r\n";
  out += "Content-Length: " + std::to_string(reply.body.size()) + "\r\n";
  out += "Connection: close\r\n";
  for (size_t i = 0; i < reply.headers.size(); ++i) {
    if (sendableHeader(reply.headers[i].first, reply.headers[i].second)) out += reply.headers[i].first + ": " + reply.headers[i].second + "\r\n";
  }
  out += "\r\n";
  out += reply.body;
  return out;
}

// What the glue itself answers when it refuses a request before the form sees it.
inline HttpReply rejection(int status) {
  HttpReply r;
  r.status = status;
  r.contentType = "text/plain";
  r.body = std::string(reasonPhrase(status) ? reasonPhrase(status) : "Error") + "\n";
  r.headers.push_back(std::make_pair("Cache-Control", "no-store"));
  r.headers.push_back(std::make_pair("X-Content-Type-Options", "nosniff"));
  return r;
}

// ── small helpers for the sketch ────────────────────────────────────────────────────────────────
// A fresh unpredictable CSRF token (128 bits, hex) for the form: a guessable one lets a web page the
// user has open in another tab post to the board. The hardware RNG, as in relay_find.h.
inline std::string newCsrfToken() {
  static const char digits[] = "0123456789abcdef";
  std::string t;
  for (int w = 0; w < 4; ++w) {
    uint32_t r = esp_random();
    for (int i = 0; i < 8; ++i) { t += digits[r & 0x0f]; r >>= 4; }
  }
  return t;
}

// The board's own MAC as "AA:BB:CC:DD:EE:FF" (the format WiFi.macAddress() has), for the SSID. Read
// from the eFuse: WiFi.macAddress() answers all zeros on some cores until the radio was started once,
// and every board would then open the SAME network name.
inline std::string boardMacAddress() {
  static const char digits[] = "0123456789ABCDEF";
  uint64_t mac = ESP.getEfuseMac();
  std::string s;
  for (int i = 0; i < 6; ++i) {
    unsigned b = (unsigned)((mac >> (8 * i)) & 0xff);
    if (i) s += ':';
    s += digits[b >> 4];
    s += digits[b & 0x0f];
  }
  return s;
}

// ── the real network ────────────────────────────────────────────────────────────────────────────
class ArduinoSetupNet : public ISetupNet {
 public:
  explicit ArduinoSetupNet(SetupHandler handler)
      : handler_(handler), server_(SETUP_HTTP_PORT, SETUP_MAX_CONNECTIONS), touched_(false), running_(false),
        dnsStarted_(false), serverStarted_(false) {}
  ~ArduinoSetupNet() { stop(); }

  bool startAccessPoint(const std::string& ssid, const std::string& pass) override {
    // Refuse BEFORE touching the radio: softAP() with an empty password opens an unprotected network.
    if (ssid.empty() || ssid.size() > 32 || pass.size() < 8 || pass.size() > 63) {
      SETUP_WARN("access point refused: the SSID or password has an invalid length");
      return false;
    }
    stop();   // a second start begins from a clean radio
    touched_ = true;
    WiFi.persistent(false);   // do not write the setup network to flash
    if (!WiFi.mode(WIFI_AP)) return failStart("WiFi.mode(WIFI_AP) failed");
    if (!WiFi.softAP(ssid.c_str(), pass.c_str(), SETUP_AP_CHANNEL, 0, SETUP_AP_MAX_STATIONS)) return failStart("softAP() failed");
    IPAddress ip = WiFi.softAPIP();
    dns_.setErrorReplyCode(DNSReplyCode::NoError);   // answer every name: phones then open the form by themselves
    dnsStarted_ = dns_.start(SETUP_DNS_PORT, "*", ip);
    if (!dnsStarted_) return failStart("the DNS server did not start");
    server_.begin();
    serverStarted_ = true;
    running_ = true;
    std::string where = ip.toString().c_str();
    // The form redirects captive-portal probes to SETUP_AP_IP; the ESP32's default AP address is that one.
    if (where != SETUP_AP_IP) SETUP_WARN("the access point has address %s, the form redirects to %s", where.c_str(), SETUP_AP_IP);
    SETUP_INFO("setup WiFi up: join \"%s\" and open http://%s/", ssid.c_str(), where.c_str());
    return true;
  }

  void poll() override {
    if (!running_) return;
    dns_.processNextRequest();
    acceptNew();
    for (int i = 0; i < SETUP_MAX_CONNECTIONS; ++i) if (slots_[i].used) serve(slots_[i]);
  }

  // Safe to call at any time and more than once; a board that never started an AP is not touched.
  void stop() override {
    if (!touched_) return;
    for (int i = 0; i < SETUP_MAX_CONNECTIONS; ++i) release(slots_[i]);
    if (dnsStarted_) dns_.stop();
    if (serverStarted_) server_.end();
    dnsStarted_ = serverStarted_ = running_ = touched_ = false;
    WiFi.softAPdisconnect(true);
    WiFi.mode(WIFI_OFF);        // connectWifi() starts again with WiFi.mode(WIFI_STA) from a quiet radio
    WiFi.persistent(true);      // the core's default, which the sketch has been running with
    SETUP_INFO("setup WiFi down");
  }

  bool running() const { return running_; }

 private:
  struct Slot {
    Slot() : used(false), startMs(0) {}
    bool used;
    uint32_t startMs;
    WiFiClient client;
    HttpRequestReader reader;
  };

  bool failStart(const char* why) {
    SETUP_WARN("%s", why);
    stop();
    return false;
  }

  void acceptNew() {
    // at most one accept per slot per poll, so a flood cannot keep this loop busy
    for (int n = 0; n < SETUP_MAX_CONNECTIONS; ++n) {
      WiFiClient c = server_.available();
      if (!c) return;
      Slot* free = NULL;
      for (int i = 0; i < SETUP_MAX_CONNECTIONS && !free; ++i) if (!slots_[i].used) free = &slots_[i];
      if (!free) { c.stop(); continue; }   // all slots busy: drop it, the phone retries
      free->used = true;
      free->startMs = millis();
      free->client = c;
      free->reader.reset();
    }
  }

  void serve(Slot& s) {
    if ((uint32_t)(millis() - s.startMs) > (uint32_t)SETUP_REQUEST_TIMEOUT_MS) { answer(s, rejection(408)); return; }
    int avail = s.client.available();
    if (avail <= 0) {
      if (!s.client.connected()) release(s);   // the phone left before the request was complete: nothing is handled
      return;
    }
    uint8_t buf[SETUP_READ_CHUNK];
    int want = avail < (int)sizeof(buf) ? avail : (int)sizeof(buf);
    int n = s.client.read(buf, (size_t)want);
    if (n <= 0) return;
    HttpRequestReader::Status st = s.reader.feed(reinterpret_cast<const char*>(buf), (size_t)n);
    if (st == HttpRequestReader::NeedMore) return;
    if (st == HttpRequestReader::Rejected) {
      SETUP_WARN("request refused: %d", s.reader.rejectStatus());
      answer(s, rejection(s.reader.rejectStatus()));
      return;
    }
    answer(s, handler_ ? handler_(s.reader.method(), s.reader.target(), s.reader.body()) : rejection(500));
  }

  void answer(Slot& s, const HttpReply& reply) {
    std::string bytes = formatHttpReply(reply);
    size_t sent = 0;
    int stalls = 0;
    while (sent < bytes.size() && stalls < 3) {   // a socket may take less than offered; a dead one takes nothing
      size_t k = s.client.write(reinterpret_cast<const uint8_t*>(bytes.data()) + sent, bytes.size() - sent);
      if (k == 0) ++stalls; else { sent += k; stalls = 0; }
    }
    release(s);
  }

  void release(Slot& s) {
    if (!s.used) return;
    s.client.stop();
    s.client = WiFiClient();
    s.reader.reset();
    s.used = false;
  }

  SetupHandler handler_;
  DNSServer dns_;
  WiFiServer server_;
  Slot slots_[SETUP_MAX_CONNECTIONS];
  bool touched_, running_, dnsStarted_, serverStarted_;
};

}  // namespace esp32cam_setup
