// fake_core.h — just enough of the Arduino/ESP32 core (millis, Serial, String, WiFi,
// HTTPClient, Update, ESP) for ota.h to compile and run on a desktop, with every
// answer scripted by the test through `fake::g`. The four headers next to it
// (Arduino.h, WiFi.h, HTTPClient.h, Update.h) only include this one, so that ota.h's
// own #include lines find them.

#pragma once

#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <deque>
#include <functional>
#include <map>
#include <memory>
#include <string>
#include <utility>
#include <vector>

namespace fake {

struct Route {            // what the "relay" answers for a URL that contains `part`
  std::string part;
  int code;
  std::string body;       // for the version answer
  std::string image;      // for the firmware download
  int declaredLength = -2;   // the Content-Length the relay announces: -2 = the real size of the body, -1 = unknown (chunked),
                             // anything else = that number (a body that stops short of it never completes)
};

// One TCP connection as the setup server sees it (setup_mode.h): the test fills `in` with what the
// phone sends and reads `out` for what the board answered. `maxWrite` plays a socket that takes only a
// few bytes at a time; `remoteLeft` is the phone going away.
struct Conn {
  std::string in, out;
  size_t inPos = 0;
  bool open = true;
  bool remoteLeft = false;
  size_t maxWrite = (size_t)-1;
  bool writeFails = false;
};

struct State {
  uint32_t now = 0;
  long randomValue = 0;
  bool wifiUp = true;
  std::vector<Route> routes;

  // what happened
  std::vector<std::string> requests;                           // every URL asked for
  std::vector<std::map<std::string, std::string> > headers;    // headers of each request
  std::vector<std::string> methods;                            // GET or POST, per request
  std::vector<std::string> bodies;                             // the body sent with each request ("" for a GET)
  std::vector<std::string> serial;                             // serial lines
  bool restarted = false;
  bool aborted = false;
  size_t updateSize = 0;
  std::string updateMd5;
  size_t bytesFlashed = 0;

  // the network (relay_find.h): this board's address, DNS, and the UDP socket. `udpHook` plays the
  // machines on the network: it is called with (address, port, payload) for every packet sent and
  // may put answers into udpInbox as (from address, payload).
  std::string ownIp = "192.168.1.50";
  std::map<std::string, std::string> dns;
  std::vector<std::string> udpSent;                              // "<address>:<port> <payload>", per packet
  std::deque<std::pair<std::string, std::string> > udpInbox;
  std::function<void(const std::string&, int, const std::string&)> udpHook;
  int udpOpens = 0, udpCloses = 0;
  bool udpOpen = false;

  // the HTTP connection: like the real one it stays OPEN after the last byte (keep-alive) unless a test says
  // otherwise, so "connected() but nothing to read" is the normal state at the end of a body.
  bool keepAlive = true;
  // A loop that polls the connection over and over without ever calling delay() starves the idle task on a
  // real board (the task watchdog then reboots it). pollsSinceDelay counts such polls; past the limit the
  // fake flags `spun` and closes the connection, so the buggy loop ends instead of hanging the test.
  uint32_t pollsSinceDelay = 0;
  bool spun = false;

  // the soft access point, its DNS and TCP servers (setup_mode.h). `wifiCalls` is the order in which
  // the radio was told things, for the tests that care about it.
  int wifiMode = 0;                       // WIFI_OFF
  bool wifiPersistent = true;             // the Arduino core's default: settings go to flash
  bool softApOk = true;                   // false: softAP() fails
  bool softApUp = false;
  std::string softApSsid, softApPass, apIp = "192.168.4.1";
  int softApChannel = -1, softApHidden = -1, softApMax = -1;
  bool dnsOk = true;                      // false: DNSServer::start() fails
  bool dnsRunning = false;
  int dnsPolls = 0;
  std::string dnsDomain, dnsAnswer;
  bool tcpListening = false;
  int tcpPort = 0;
  std::deque<std::shared_ptr<Conn> > incoming;   // connections waiting to be accepted
  uint64_t efuseMac = 0x0000f6e5d4ccbbaaULL;     // AA:BB:CC:D4:E5:F6, first byte lowest
  std::vector<std::string> wifiCalls;

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
#define WIFI_OFF 0
#define WIFI_STA 1
#define WIFI_AP 2
#define WL_CONNECTED 3
#define WL_DISCONNECTED 6

inline uint32_t millis() { return fake::g().now; }
inline long random(long, long) { return fake::g().randomValue; }
inline void delay(uint32_t ms) { fake::g().now += ms; fake::g().pollsSinceDelay = 0; }   // time passes, so a loop that waits with delay() ends; and the idle task gets to run

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

class IPAddress {
 public:
  IPAddress() {}
  bool fromString(const char* s) { s_ = s; return true; }
  String toString() const { return String(s_.c_str()); }
  std::string s_;
};

struct FakeWiFi {
  int status() { return fake::g().wifiUp ? WL_CONNECTED : WL_DISCONNECTED; }
  IPAddress localIP() { IPAddress a; a.s_ = fake::g().ownIp; return a; }
  // the soft AP (setup_mode.h): the fake records what it was told and answers as scripted
  bool mode(int m) { fake::g().wifiMode = m; fake::g().wifiCalls.push_back("mode:" + std::to_string(m)); return true; }
  int getMode() { return fake::g().wifiMode; }
  bool persistent(bool p) { fake::g().wifiPersistent = p; fake::g().wifiCalls.push_back(p ? "persistent:1" : "persistent:0"); return true; }
  bool softAP(const char* ssid, const char* pass, int channel, int hidden, int maxConn) {
    fake::g().wifiCalls.push_back("softAP");
    fake::g().softApSsid = ssid; fake::g().softApPass = pass;
    fake::g().softApChannel = channel; fake::g().softApHidden = hidden; fake::g().softApMax = maxConn;
    fake::g().softApUp = fake::g().softApOk;
    return fake::g().softApOk;
  }
  IPAddress softAPIP() { IPAddress a; a.s_ = fake::g().apIp; return a; }
  bool softAPdisconnect(bool wifioff) { fake::g().wifiCalls.push_back(wifioff ? "softAPdisconnect:1" : "softAPdisconnect:0"); fake::g().softApUp = false; return true; }
  bool hostByName(const char* name, IPAddress& out) {
    std::map<std::string, std::string>::const_iterator it = fake::g().dns.find(name);
    if (it == fake::g().dns.end()) return false;
    out.s_ = it->second;
    return true;
  }
};
inline FakeWiFi WiFi;

class WiFiUDP {
 public:
  uint8_t begin(uint16_t) { fake::g().udpOpen = true; fake::g().udpOpens++; return 1; }
  void stop() { if (fake::g().udpOpen) fake::g().udpCloses++; fake::g().udpOpen = false; }
  int beginPacket(IPAddress ip, uint16_t port) { to_ = ip.s_; port_ = port; out_.clear(); return fake::g().udpOpen ? 1 : 0; }
  size_t write(const uint8_t* d, size_t n) { out_.append(reinterpret_cast<const char*>(d), n); return n; }
  int endPacket() {
    fake::g().udpSent.push_back(to_ + ":" + std::to_string(port_) + " " + out_);
    if (fake::g().udpHook) fake::g().udpHook(to_, port_, out_);
    return 1;
  }
  int parsePacket() { return fake::g().udpInbox.empty() ? 0 : (int)fake::g().udpInbox.front().second.size(); }
  int read(uint8_t* buf, size_t len) {
    if (fake::g().udpInbox.empty()) return 0;
    from_.s_ = fake::g().udpInbox.front().first;
    std::string p = fake::g().udpInbox.front().second;
    fake::g().udpInbox.pop_front();
    size_t n = p.size() < len ? p.size() : len;
    for (size_t i = 0; i < n; ++i) buf[i] = (uint8_t)p[i];
    return (int)n;
  }
  IPAddress remoteIP() { return from_; }
 private:
  std::string to_, out_;
  int port_ = 0;
  IPAddress from_;
};

struct FakeEsp {
  void restart() { fake::g().restarted = true; }
  uint64_t getEfuseMac() { return fake::g().efuseMac; }
};
inline FakeEsp ESP;

class Stream {
 public:
  std::string bytes;
};

// (review ARD-008) WiFiClient fake for ota.h's readBounded(). Real WiFiClient
// is what http.getStreamPtr() returns; on the desktop the fake HTTPClient
// returns a Stream*, and readBounded() needs the same shape so the code under
// test compiles unchanged. We model only the two methods readBounded() uses.
class WiFiClient : public Stream {
 public:
  WiFiClient() {}
  explicit WiFiClient(std::shared_ptr<fake::Conn> c) : conn_(c) {}   // an accepted connection (WiFiServer)
  int read(uint8_t* buf, size_t len) {
    if (conn_) {
      size_t left = conn_->in.size() - conn_->inPos;
      size_t n = left < len ? left : len;
      for (size_t i = 0; i < n; ++i) buf[i] = (uint8_t)conn_->in[conn_->inPos + i];
      conn_->inPos += n;
      return (int)n;
    }
    size_t n = bytes.size() < len ? bytes.size() : len;
    for (size_t i = 0; i < n; ++i) buf[i] = (uint8_t)bytes[i];
    bytes.erase(0, n);
    return (int)n;
  }
  int available() { return conn_ ? (int)(conn_->in.size() - conn_->inPos) : (int)bytes.size(); }
  // like the real one: the socket counts as connected while the peer is there OR unread data is left
  uint8_t connected() { return conn_ && conn_->open && (!conn_->remoteLeft || available() > 0); }
  size_t write(const uint8_t* d, size_t n) {
    if (!conn_ || !conn_->open || conn_->writeFails) return 0;
    size_t k = n < conn_->maxWrite ? n : conn_->maxWrite;
    conn_->out.append(reinterpret_cast<const char*>(d), k);
    return k;
  }
  void stop() { if (conn_) conn_->open = false; }
  operator bool() const { return (bool)conn_; }
 private:
  std::shared_ptr<fake::Conn> conn_;
};

// The listening socket: the test queues connections in fake::g().incoming, the board accepts them.
class WiFiServer {
 public:
  explicit WiFiServer(uint16_t port = 80, uint8_t = 4) : port_(port) {}
  void begin() { fake::g().tcpListening = true; fake::g().tcpPort = port_; }
  void end() { fake::g().tcpListening = false; }
  WiFiClient available() {
    if (!fake::g().tcpListening || fake::g().incoming.empty()) return WiFiClient();
    std::shared_ptr<fake::Conn> c = fake::g().incoming.front();
    fake::g().incoming.pop_front();
    return WiFiClient(c);
  }
 private:
  uint16_t port_;
};

class HTTPClient {
 public:
  void begin(const String& url) {
    fake::g().requests.push_back(url.c_str());
    fake::g().headers.push_back(std::map<std::string, std::string>());
    fake::g().methods.push_back("GET");
    fake::g().bodies.push_back("");
    url_ = url.c_str();
  }
  void setTimeout(int) {}
  void addHeader(const char* name, const char* value) { fake::g().headers.back()[name] = value; }
  int GET() {
    for (size_t i = 0; i < fake::g().routes.size(); i++) {
      const fake::Route& r = fake::g().routes[i];
      if (url_.find(r.part) != std::string::npos) {
        body_ = r.body;
        // (review ARD-008) on real hardware http.getString() and
        // http.getStreamPtr() both expose the SAME response body — they are
        // not separate channels. The fake used to put the text body in body_
        // and a separate "image" buffer in stream_.bytes, which worked while
        // the production code only called getString() for the version reply
        // and only called getStreamPtr() for the firmware image. Now that
        // readBounded() reads the version reply through getStreamPtr() too,
        // the fake must mirror the real behaviour: stream_.bytes holds the
        // body when no image is provided (the version reply case), and the
        // image when one is provided (the firmware download case).
        stream_.bytes = r.image.empty() ? r.body : r.image;
        contentLength_ = r.declaredLength == -2 ? (int)stream_.bytes.size() : r.declaredLength;
        open_ = true;
        return r.code;
      }
    }
    return -1;   // connection refused
  }
  int POST(const String& payload) {
    fake::g().methods.back() = "POST";
    fake::g().bodies.back() = payload.c_str();
    return GET();
  }
  String getString() { return String(body_.c_str()); }
  // The announced Content-Length (fixed at GET time, -1 when unknown), like the real client's.
  int getSize() { return contentLength_; }
  // Like the real one: true while the connection is up OR unread data is left. With keep-alive (the
  // default) the connection stays up after the last byte, so this is true for ever; each call counts as a
  // poll, and a loop that polls without delay() is flagged (see State::pollsSinceDelay).
  bool connected() {
    if (++fake::g().pollsSinceDelay > 10000) {
      fake::g().spun = true;
      open_ = false;
    }
    if (!stream_.bytes.empty()) return true;
    return fake::g().keepAlive && open_;
  }
  WiFiClient* getStreamPtr() { return &stream_; }
  void end() { open_ = false; }
 private:
  std::string url_, body_;
  WiFiClient stream_;
  int contentLength_ = 0;
  bool open_ = false;
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
  size_t write(uint8_t* buf, size_t len) { (void)buf;   // non-const, like the real UpdateClass::write(uint8_t*, size_t)
    size_t n = fake::g().shortWrite ? len / 2 : len;
    if (fake::g().shortWrite) fake::g().shortWrite = false;   // only the first chunk is short
    fake::g().bytesFlashed += n;
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
