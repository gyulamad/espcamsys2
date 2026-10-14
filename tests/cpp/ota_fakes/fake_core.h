// fake_core.h — just enough of the Arduino/ESP32 core (millis, Serial, String, WiFi,
// HTTPClient, Update, ESP) for ota.h to compile and run on a desktop, with every
// answer scripted by the test through `fake::g`. The four headers next to it
// (Arduino.h, WiFi.h, HTTPClient.h, Update.h) only include this one, so that ota.h's
// own #include lines find them.

#pragma once

#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <map>
#include <string>
#include <vector>

namespace fake {

struct Route {            // what the "relay" answers for a URL that contains `part`
  std::string part;
  int code;
  std::string body;       // for the version answer
  std::string image;      // for the firmware download
};

struct State {
  uint32_t now = 0;
  long randomValue = 0;
  bool wifiUp = true;
  std::vector<Route> routes;

  // what happened
  std::vector<std::string> requests;                           // every URL asked for
  std::vector<std::map<std::string, std::string> > headers;    // headers of each request
  std::vector<std::string> serial;                             // serial lines
  bool restarted = false;
  bool aborted = false;
  size_t updateSize = 0;
  std::string updateMd5;
  size_t bytesFlashed = 0;

  // how the flash behaves
  bool beginOk = true;
  bool shortWrite = false;
  bool endOk = true;
  int updateError = 0;
};

inline State& g() { static State s; return s; }

}  // namespace fake

#define UPDATE_ERROR_OK 0
#define UPDATE_ERROR_MD5 7
#define UPDATE_ERROR_NO_PARTITION 12
#define WL_CONNECTED 3
#define WL_DISCONNECTED 6

inline uint32_t millis() { return fake::g().now; }
inline long random(long, long) { return fake::g().randomValue; }
inline void delay(uint32_t) {}

class String {
 public:
  String() {}
  String(const char* s) : s_(s) {}
  const char* c_str() const { return s_.c_str(); }
 private:
  std::string s_;
};

struct FakeSerial {
  void printf(const char* fmt, ...) {
    char buf[512];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    pending += buf;
  }
  void println() { fake::g().serial.push_back(pending); pending.clear(); }
  std::string pending;
};
inline FakeSerial Serial;

struct FakeWiFi { int status() { return fake::g().wifiUp ? WL_CONNECTED : WL_DISCONNECTED; } };
inline FakeWiFi WiFi;

struct FakeEsp { void restart() { fake::g().restarted = true; } };
inline FakeEsp ESP;

class Stream {
 public:
  std::string bytes;
};

class HTTPClient {
 public:
  void begin(const String& url) {
    fake::g().requests.push_back(url.c_str());
    fake::g().headers.push_back(std::map<std::string, std::string>());
    url_ = url.c_str();
  }
  void setTimeout(int) {}
  void addHeader(const char* name, const char* value) { fake::g().headers.back()[name] = value; }
  int GET() {
    for (size_t i = 0; i < fake::g().routes.size(); i++) {
      const fake::Route& r = fake::g().routes[i];
      if (url_.find(r.part) != std::string::npos) {
        body_ = r.body;
        stream_.bytes = r.image;
        return r.code;
      }
    }
    return -1;   // connection refused
  }
  String getString() { return String(body_.c_str()); }
  int getSize() { return (int)stream_.bytes.size(); }
  Stream* getStreamPtr() { return &stream_; }
  void end() {}
 private:
  std::string url_, body_;
  Stream stream_;
};

class UpdateClass {
 public:
  bool begin(size_t size) {
    fake::g().updateSize = size;
    if (!fake::g().beginOk) { fake::g().updateError = UPDATE_ERROR_NO_PARTITION; return false; }
    return true;
  }
  bool setMD5(const char* md5) { fake::g().updateMd5 = md5; return true; }
  size_t writeStream(Stream& s) {
    size_t n = fake::g().shortWrite ? s.bytes.size() / 2 : s.bytes.size();
    fake::g().bytesFlashed = n;
    return n;
  }
  bool end(bool) {
    if (!fake::g().endOk) { fake::g().updateError = UPDATE_ERROR_MD5; return false; }
    return true;
  }
  bool isFinished() { return true; }
  void abort() { fake::g().aborted = true; }
  int getError() { return fake::g().updateError; }
  const char* errorString() { return "Fake Error"; }
};
inline UpdateClass Update;
