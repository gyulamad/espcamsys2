// Tests for setup_mode.h — the Arduino half of the setup mode: compiled for real against the fakes of the
// Arduino core (tests/cpp/ota_fakes/), with the phone played by connections queued in `fake::g().incoming`.
// What the form accepts and when the session ends is tested elsewhere (S3/S4); this checks the joins: what
// the radio is told and in which order, the bytes that come in and go out, the limits, and that stop()
// leaves the radio as connectWifi() expects. The last tests put the REAL form (SetupForm) and the REAL
// session (SetupMode) on top of it and drive them from a "phone".
//
// Build: g++ -std=c++17 -I tests/cpp/ota_fakes -I Arduino/ESP32_CAM_Recorder tests/cpp/test_setup_mode_glue.cpp

#include <memory>

#include "fake_core.h"
#include "framework.h"
#include "settings_schema.h"
#include "setup_mode.h"
#include "settings_fakes.h"   // after the settings engine: its fakes derive from it

using namespace esp32cam_setup;

static const char* SSID = "espcamsys2-recorder-d4e5f6";
static const char* PASS = "Secret-Pass-1";

static HttpReply mk(int status, const std::string& type, const std::string& body) {
  HttpReply r;
  r.status = status;
  r.contentType = type;
  r.body = body;
  return r;
}

struct Calls {
  int n = 0;
  std::string method, target, body;
  HttpReply reply = mk(200, "text/html", "<p>hi</p>");
};
static Calls g_calls;

static SetupHandler handler() {
  return [](const std::string& m, const std::string& p, const std::string& b) {
    g_calls.n++; g_calls.method = m; g_calls.target = p; g_calls.body = b;
    return g_calls.reply;
  };
}

static void world() {
  fake::g() = fake::State();
  fake::g().now = 1000;
  g_calls = Calls();
}

static bool logged(const std::string& part) {
  for (size_t i = 0; i < fake::g().serial.size(); ++i) if (fake::g().serial[i].find(part) != std::string::npos) return true;
  return false;
}

static bool called(const std::string& what) {
  for (size_t i = 0; i < fake::g().wifiCalls.size(); ++i) if (fake::g().wifiCalls[i] == what) return true;
  return false;
}

// A phone connecting and sending `bytes`.
static std::shared_ptr<fake::Conn> connect(const std::string& bytes) {
  std::shared_ptr<fake::Conn> c(new fake::Conn());
  c->in = bytes;
  fake::g().incoming.push_back(c);
  return c;
}

static std::string post(const std::string& body) {
  return "POST /save HTTP/1.1\r\nHost: 192.168.4.1\r\nContent-Type: application/x-www-form-urlencoded\r\nContent-Length: " +
         std::to_string(body.size()) + "\r\n\r\n" + body;
}

static const char* GET_ROOT = "GET / HTTP/1.1\r\nHost: 192.168.4.1\r\n\r\n";

// Polls until nothing changes any more (a few polls are needed: accept, read, answer).
static void pump(ArduinoSetupNet& net, int polls = 6) { for (int i = 0; i < polls; ++i) net.poll(); }

// What the phone got back: the status line's number.
static int statusOf(const std::shared_ptr<fake::Conn>& c) {
  return c->out.compare(0, 9, "HTTP/1.1 ") == 0 ? atoi(c->out.c_str() + 9) : -1;
}

// ── starting ────────────────────────────────────────────────────────────────────────────────────
TEST(the_access_point_starts_protected_on_the_right_ports) {
  world();
  ArduinoSetupNet net(handler());
  TEST_ASSERT(net.startAccessPoint(SSID, PASS), "started");
  TEST_ASSERT_EQ(fake::g().wifiMode, (int)WIFI_AP, "in AP mode only (no STA)");
  TEST_ASSERT_EQ(fake::g().softApSsid, std::string(SSID), "the SSID");
  TEST_ASSERT_EQ(fake::g().softApPass, std::string(PASS), "the password (WPA2)");
  TEST_ASSERT_EQ(fake::g().softApHidden, 0, "visible");
  TEST_ASSERT_EQ(fake::g().softApMax, 4, "about four phones");
  TEST_ASSERT(!fake::g().wifiPersistent, "nothing is written to flash while it is up");
  TEST_ASSERT(fake::g().dnsRunning && fake::g().dnsDomain == "*" && fake::g().dnsAnswer == "192.168.4.1", "DNS answers every name with the AP address");
  TEST_ASSERT(fake::g().tcpListening && fake::g().tcpPort == 80, "HTTP on port 80");
  TEST_ASSERT(logged(SSID) && logged("http://192.168.4.1/"), "the log says the SSID and the URL");
  TEST_ASSERT(!logged(PASS), "and never the password");
}

TEST(an_unprotected_or_invalid_access_point_is_never_started) {
  const char* badSsid[] = {"", "this-name-is-way-too-long-for-an-ssid-x"};
  for (size_t i = 0; i < 2; ++i) {
    world();
    ArduinoSetupNet net(handler());
    TEST_ASSERT(!net.startAccessPoint(badSsid[i], PASS), "bad SSID refused");
    TEST_ASSERT(fake::g().wifiCalls.empty(), "the radio was not touched");
  }
  const std::string badPass[] = {"", "short", "1234567", std::string(64, 'x')};
  for (size_t i = 0; i < 4; ++i) {
    world();
    ArduinoSetupNet net(handler());
    TEST_ASSERT(!net.startAccessPoint(SSID, badPass[i]), "bad password refused: never an open network");
    TEST_ASSERT(fake::g().wifiCalls.empty() && !fake::g().softApUp, "no softAP() call at all");
  }
  world();
  ArduinoSetupNet net(handler());
  TEST_ASSERT(net.startAccessPoint(std::string(32, 'a'), std::string(63, 'b')), "the longest valid ones are fine");
  TEST_ASSERT(net.startAccessPoint("a", "12345678"), "and the shortest");
}

TEST(a_failed_start_cleans_up_and_can_be_retried) {
  world();
  fake::g().softApOk = false;
  ArduinoSetupNet net(handler());
  TEST_ASSERT(!net.startAccessPoint(SSID, PASS), "softAP failed");
  TEST_ASSERT(!net.running(), "not running");
  TEST_ASSERT(fake::g().wifiMode == WIFI_OFF && fake::g().wifiPersistent, "radio off, flash behaviour restored");
  TEST_ASSERT(!fake::g().dnsRunning && !fake::g().tcpListening, "no servers");
  TEST_ASSERT(logged("WARN"), "logged");
  fake::g().softApOk = true;
  TEST_ASSERT(net.startAccessPoint(SSID, PASS) && net.running(), "the retry works");

  world();
  fake::g().dnsOk = false;
  ArduinoSetupNet net2(handler());
  TEST_ASSERT(!net2.startAccessPoint(SSID, PASS), "DNS failed");
  TEST_ASSERT(!fake::g().softApUp && fake::g().wifiMode == WIFI_OFF && !fake::g().tcpListening, "the half-started AP is taken down again");
}

TEST(a_second_start_begins_from_a_clean_radio) {
  world();
  ArduinoSetupNet net(handler());
  net.startAccessPoint(SSID, PASS);
  fake::g().wifiCalls.clear();
  TEST_ASSERT(net.startAccessPoint("espcamsys2-recorder-000001", PASS), "restarted");
  TEST_ASSERT(called("softAPdisconnect:1"), "the old AP was taken down first");
  TEST_ASSERT_EQ(fake::g().softApSsid, std::string("espcamsys2-recorder-000001"), "the new name is in use");
}

// ── stopping ────────────────────────────────────────────────────────────────────────────────────
TEST(stop_leaves_the_wifi_clean_for_connectWifi) {
  world();
  ArduinoSetupNet net(handler());
  net.startAccessPoint(SSID, PASS);
  std::shared_ptr<fake::Conn> open = connect("GET / HTTP/1.1\r\n");   // a half-sent request
  pump(net, 2);
  net.stop();
  TEST_ASSERT(!fake::g().dnsRunning && !fake::g().tcpListening && !fake::g().softApUp, "DNS, HTTP and the AP are down");
  TEST_ASSERT_EQ(fake::g().wifiMode, (int)WIFI_OFF, "the radio is off, so WiFi.mode(WIFI_STA) starts it fresh");
  TEST_ASSERT(fake::g().wifiPersistent, "the core's default is back");
  TEST_ASSERT(!open->open, "open connections were closed");
  TEST_ASSERT(!net.running(), "not running");
  size_t n = fake::g().wifiCalls.size();
  net.stop();
  TEST_ASSERT_EQ(fake::g().wifiCalls.size(), n, "a second stop() does nothing");
}

TEST(a_board_that_never_started_is_never_touched) {
  world();
  {
    ArduinoSetupNet net(handler());
    net.stop();
    net.poll();
  }   // destructor too
  TEST_ASSERT(fake::g().wifiCalls.empty(), "stop(), poll() and the destructor leave the radio alone");
  TEST_ASSERT_EQ(fake::g().dnsPolls, 0, "no DNS polling");
}

TEST(the_destructor_stops_a_running_access_point) {
  world();
  { ArduinoSetupNet net(handler()); net.startAccessPoint(SSID, PASS); }
  TEST_ASSERT(!fake::g().softApUp && fake::g().wifiMode == WIFI_OFF, "gone with the object");
}

// ── serving ─────────────────────────────────────────────────────────────────────────────────────
TEST(a_get_reaches_the_handler_and_the_reply_goes_back_whole) {
  world();
  ArduinoSetupNet net(handler());
  net.startAccessPoint(SSID, PASS);
  std::shared_ptr<fake::Conn> c = connect(GET_ROOT);
  pump(net);
  TEST_ASSERT_EQ(g_calls.n, 1, "the handler ran once");
  TEST_ASSERT(g_calls.method == "GET" && g_calls.target == "/" && g_calls.body.empty(), "with GET, / and no body");
  TEST_ASSERT_EQ(statusOf(c), 200, "200");
  TEST_ASSERT(c->out.find("Content-Type: text/html\r\n") != std::string::npos, "its content type");
  TEST_ASSERT(c->out.find("Content-Length: 9\r\n") != std::string::npos, "its exact length");
  TEST_ASSERT(c->out.find("Connection: close\r\n") != std::string::npos, "one answer per connection");
  TEST_ASSERT(c->out.find("Cache-Control") == std::string::npos, "the glue adds no policy of its own: the form's headers are the form's decision");
  TEST_ASSERT(c->out.size() >= 9 && c->out.substr(c->out.size() - 9) == "<p>hi</p>", "the body is last");
  TEST_ASSERT(!c->open, "closed afterwards");
  TEST_ASSERT(fake::g().dnsPolls >= 6, "DNS is served on every poll");
}

TEST(a_post_body_split_over_many_polls_is_handled_once_and_whole) {
  world();
  ArduinoSetupNet net(handler());
  net.startAccessPoint(SSID, PASS);
  std::string body = "WIFI=a%3Bb&CAMERA_ID=front";
  std::string all = post(body);
  std::shared_ptr<fake::Conn> c = connect(all.substr(0, 20));
  pump(net, 3);
  TEST_ASSERT_EQ(g_calls.n, 0, "not before the body is there");
  c->in += all.substr(20, 60);
  pump(net, 3);
  TEST_ASSERT_EQ(g_calls.n, 0, "still not");
  c->in += all.substr(80);
  pump(net, 3);
  TEST_ASSERT_EQ(g_calls.n, 1, "once");
  TEST_ASSERT(g_calls.method == "POST" && g_calls.target == "/save", "POST /save");
  TEST_ASSERT_EQ(g_calls.body, body, "with the exact body");
}

TEST(a_body_is_handed_over_byte_exact_including_nul_and_percent) {
  world();
  ArduinoSetupNet net(handler());
  net.startAccessPoint(SSID, PASS);
  std::string body("a=%\0+b&c=%zz", 12);
  connect(post(body));
  pump(net);
  TEST_ASSERT_EQ(g_calls.body, body, "undecoded and binary-safe: decoding is the form's job");
}

TEST(the_request_target_reaches_the_handler_whole_query_included) {
  world();
  ArduinoSetupNet net(handler());
  net.startAccessPoint(SSID, PASS);
  connect("GET /generate_204?x=1 HTTP/1.0\r\n\r\n");
  pump(net);
  TEST_ASSERT_EQ(g_calls.target, std::string("/generate_204?x=1"), "the form cuts the query off itself (SetupForm::handle)");
}

TEST(other_methods_are_left_to_the_handler_to_refuse) {
  world();
  ArduinoSetupNet net(handler());
  net.startAccessPoint(SSID, PASS);
  g_calls.reply = mk(405, "text/plain", "no");
  std::shared_ptr<fake::Conn> c = connect("PUT / HTTP/1.1\r\n\r\n");
  pump(net);
  TEST_ASSERT(g_calls.method == "PUT" && statusOf(c) == 405, "PUT reaches it and its 405 goes out");
}

TEST(the_headers_the_handler_chose_are_sent_as_they_are) {
  world();
  ArduinoSetupNet net(handler());
  net.startAccessPoint(SSID, PASS);
  g_calls.reply = mk(302, "text/plain", "go");
  g_calls.reply.headers.push_back(std::make_pair("Location", "http://192.168.4.1/"));
  g_calls.reply.headers.push_back(std::make_pair("Cache-Control", "no-store"));
  std::shared_ptr<fake::Conn> c = connect("GET /hotspot-detect.html HTTP/1.1\r\n\r\n");
  pump(net);
  TEST_ASSERT_EQ(statusOf(c), 302, "302");
  TEST_ASSERT(c->out.find("Location: http://192.168.4.1/\r\n") != std::string::npos, "Location");
  TEST_ASSERT(c->out.find("Cache-Control: no-store\r\n") != std::string::npos, "and the others");
}

TEST(a_reply_cannot_split_the_message_or_forge_its_framing) {
  world();
  ArduinoSetupNet net(handler());
  net.startAccessPoint(SSID, PASS);
  g_calls.reply = mk(200, "text/html\r\nSet-Cookie: x=1", "ok");
  g_calls.reply.headers.push_back(std::make_pair("X-Good", "yes"));
  g_calls.reply.headers.push_back(std::make_pair("X-Split", "a\r\nSet-Cookie: y=2"));
  g_calls.reply.headers.push_back(std::make_pair("X-Nul", std::string("a\0b", 3)));
  g_calls.reply.headers.push_back(std::make_pair("Bad Name", "v"));
  g_calls.reply.headers.push_back(std::make_pair("X:Colon", "v"));
  g_calls.reply.headers.push_back(std::make_pair("", "v"));
  g_calls.reply.headers.push_back(std::make_pair("content-length", "1"));
  g_calls.reply.headers.push_back(std::make_pair("Transfer-Encoding", "chunked"));
  g_calls.reply.headers.push_back(std::make_pair("Connection", "keep-alive"));
  g_calls.reply.headers.push_back(std::make_pair("Content-Type", "text/evil"));
  std::shared_ptr<fake::Conn> c = connect(GET_ROOT);
  pump(net);
  TEST_ASSERT(c->out.find("Set-Cookie") == std::string::npos, "no injected header, from the type or from a value");
  TEST_ASSERT(c->out.find("Content-Type: text/plain\r\n") != std::string::npos && c->out.find("text/evil") == std::string::npos, "a bad type becomes plain text, a second type is dropped");
  TEST_ASSERT(c->out.find("X-Good: yes\r\n") != std::string::npos, "a good header still goes out");
  TEST_ASSERT(c->out.find("Bad Name") == std::string::npos && c->out.find("X:Colon") == std::string::npos && c->out.find("X-Nul") == std::string::npos, "malformed names and values are dropped");
  TEST_ASSERT(c->out.find("keep-alive") == std::string::npos && c->out.find("chunked") == std::string::npos, "the connection framing is not the handler's to change");
  size_t first = c->out.find("Content-Length:");
  TEST_ASSERT(first != std::string::npos && c->out.find("Content-Length:", first + 1) == std::string::npos && c->out.find("Content-Length: 2\r\n") != std::string::npos, "exactly one Content-Length, the real one");
  TEST_ASSERT(c->out.size() >= 4 && c->out.substr(c->out.size() - 4) == "\r\nok" , "the body follows the header block");

  g_calls.reply = mk(999, "text/html", "ok");
  std::shared_ptr<fake::Conn> d = connect(GET_ROOT);
  pump(net);
  TEST_ASSERT_EQ(statusOf(d), 500, "an unknown status becomes 500");
}

TEST(a_refusal_by_the_glue_is_never_cached_or_sniffed) {
  world();
  ArduinoSetupNet net(handler());
  net.startAccessPoint(SSID, PASS);
  std::shared_ptr<fake::Conn> c = connect("POST /save HTTP/1.1\r\nContent-Length: 99999\r\n\r\n");
  pump(net);
  TEST_ASSERT(statusOf(c) == 413 && c->out.find("Cache-Control: no-store\r\n") != std::string::npos && c->out.find("nosniff") != std::string::npos, "413 with its own two headers");
}

TEST(a_socket_that_takes_a_few_bytes_at_a_time_still_gets_everything) {
  world();
  ArduinoSetupNet net(handler());
  net.startAccessPoint(SSID, PASS);
  g_calls.reply = mk(200, "text/html", std::string(3000, 'x'));
  std::shared_ptr<fake::Conn> c = connect(GET_ROOT);
  c->maxWrite = 7;
  pump(net);
  TEST_ASSERT(c->out.size() > 3000 && c->out.substr(c->out.size() - 3000) == std::string(3000, 'x'), "the whole 3000-byte body");
}

TEST(a_socket_that_takes_nothing_does_not_hang_the_board) {
  world();
  ArduinoSetupNet net(handler());
  net.startAccessPoint(SSID, PASS);
  std::shared_ptr<fake::Conn> c = connect(GET_ROOT);
  c->writeFails = true;
  pump(net);   // returns at all = no endless loop
  TEST_ASSERT(!c->open, "given up on and closed");
  std::shared_ptr<fake::Conn> d = connect(GET_ROOT);
  pump(net);
  TEST_ASSERT_EQ(statusOf(d), 200, "the next phone is served");
}

// ── refusals ────────────────────────────────────────────────────────────────────────────────────
static int answerTo(const std::string& bytes, bool* handled = NULL) {
  world();
  ArduinoSetupNet net(handler());
  net.startAccessPoint(SSID, PASS);
  std::shared_ptr<fake::Conn> c = connect(bytes);
  pump(net);
  if (handled) *handled = g_calls.n != 0;
  return statusOf(c);
}

TEST(malformed_requests_are_refused_and_never_reach_the_handler) {
  struct Case { const char* name; std::string bytes; int status; };
  std::string big(5000, 'a');
  Case cases[] = {
    {"lowercase method", "get / HTTP/1.1\r\n\r\n", 400},
    {"no method", " / HTTP/1.1\r\n\r\n", 400},
    {"method too long", "ABCDEFGHI / HTTP/1.1\r\n\r\n", 400},
    {"no version", "GET /\r\n\r\n", 400},
    {"HTTP/2", "GET / HTTP/2\r\n\r\n", 400},
    {"target without slash", "GET index HTTP/1.1\r\n\r\n", 400},
    {"absolute target", "GET http://x/ HTTP/1.1\r\n\r\n", 400},
    {"target too long", "GET /" + std::string(300, 'a') + " HTTP/1.1\r\n\r\n", 400},
    {"NUL in the head", std::string("GET /a\0b HTTP/1.1\r\n\r\n", 21), 400},
    {"control byte in a header", "GET / HTTP/1.1\r\nX: a\x01" "b\r\n\r\n", 400},
    {"bare LF line end", "GET / HTTP/1.1\nHost: x\r\n\r\n", 400},
    {"bare CR", "GET / HTTP/1.1\rHost: x\r\n\r\n", 400},
    {"folded header", "GET / HTTP/1.1\r\nX: a\r\n b\r\n\r\n", 400},
    {"header without colon", "GET / HTTP/1.1\r\nNoColon\r\n\r\n", 400},
    {"space in header name", "GET / HTTP/1.1\r\nBad Name: x\r\n\r\n", 400},
    {"POST without length", "POST /save HTTP/1.1\r\n\r\nbody", 411},
    {"chunked body", "POST /save HTTP/1.1\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n", 501},
    {"signed length", "POST /save HTTP/1.1\r\nContent-Length: +5\r\n\r\nabcde", 400},
    {"negative length", "POST /save HTTP/1.1\r\nContent-Length: -1\r\n\r\n", 400},
    {"hex length", "POST /save HTTP/1.1\r\nContent-Length: 0x10\r\n\r\n", 400},
    {"exponent length", "POST /save HTTP/1.1\r\nContent-Length: 1e3\r\n\r\n", 400},
    {"empty length", "POST /save HTTP/1.1\r\nContent-Length:\r\n\r\n", 400},
    {"ten-digit length", "POST /save HTTP/1.1\r\nContent-Length: 4294967296\r\n\r\n", 400},
    {"two different lengths", "POST /save HTTP/1.1\r\nContent-Length: 3\r\nContent-Length: 4\r\n\r\nabcd", 400},
    {"body over the cap", "POST /save HTTP/1.1\r\nContent-Length: 4097\r\n\r\n", 413},
    {"huge announced body", "POST /save HTTP/1.1\r\nContent-Length: 999999999\r\n\r\n", 413},
    {"head over the cap", "GET / HTTP/1.1\r\nX: " + big + "\r\n\r\n", 431},
    {"head that never ends", "GET / HTTP/1.1\r\nX: " + big, 431},
    {"too many headers", [] { std::string s = "GET / HTTP/1.1\r\n"; for (int i = 0; i < 40; ++i) s += "H: v\r\n"; return s + "\r\n"; }(), 431},
  };
  for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); ++i) {
    bool handled = true;
    int status = answerTo(cases[i].bytes, &handled);
    TEST_ASSERT_EQ(status, cases[i].status, std::string("refused: ") + cases[i].name);
    TEST_ASSERT(!handled, std::string("handler not reached: ") + cases[i].name);
  }
}

TEST(a_body_exactly_at_the_cap_is_accepted_and_one_more_byte_is_not) {
  bool handled = false;
  TEST_ASSERT_EQ(answerTo(post(std::string(4096, 'a')), &handled), 200, "4096 bytes accepted");
  TEST_ASSERT(handled, "handled");
  TEST_ASSERT_EQ(answerTo(post(std::string(4097, 'a')), &handled), 413, "4097 refused");
}

TEST(bytes_after_the_announced_body_are_ignored) {
  world();
  ArduinoSetupNet net(handler());
  net.startAccessPoint(SSID, PASS);
  connect(post("a=1") + "GET /evil HTTP/1.1\r\n\r\n");
  pump(net);
  TEST_ASSERT(g_calls.n == 1 && g_calls.body == "a=1" && g_calls.target == "/save", "only the first request, with only its own body");
}

TEST(an_oversized_body_is_refused_without_waiting_for_it) {
  world();
  ArduinoSetupNet net(handler());
  net.startAccessPoint(SSID, PASS);
  std::shared_ptr<fake::Conn> c = connect("POST /save HTTP/1.1\r\nContent-Length: 100000\r\n\r\n" + std::string(100, 'x'));
  pump(net, 2);
  TEST_ASSERT_EQ(statusOf(c), 413, "413 at once, the rest of the body is never collected");
}

// ── slow, vanishing and many clients ────────────────────────────────────────────────────────────
TEST(a_client_that_sends_nothing_is_dropped_after_the_timeout) {
  world();
  ArduinoSetupNet net(handler());
  net.startAccessPoint(SSID, PASS);
  std::shared_ptr<fake::Conn> c = connect("");
  pump(net, 2);
  TEST_ASSERT(c->open, "still waiting at first");
  fake::g().now += SETUP_REQUEST_TIMEOUT_MS - 1;
  pump(net, 2);
  TEST_ASSERT(c->open, "and just before the timeout");
  fake::g().now += 2;
  pump(net, 2);
  TEST_ASSERT_EQ(statusOf(c), 408, "408 after it");
  TEST_ASSERT(!c->open && g_calls.n == 0, "closed, handler never ran");
}

TEST(a_client_that_trickles_bytes_cannot_hold_a_slot_for_ever) {
  world();
  ArduinoSetupNet net(handler());
  net.startAccessPoint(SSID, PASS);
  std::shared_ptr<fake::Conn> c = connect("GET / HTTP/1.1\r\n");
  for (int i = 0; i < 20; ++i) { fake::g().now += 1000; c->in += "X: a\r\n"; pump(net, 1); }
  TEST_ASSERT(!c->open && statusOf(c) == 408, "the deadline counts from the first byte, not the last");
}

TEST(a_client_that_leaves_mid_save_changes_nothing) {
  world();
  ArduinoSetupNet net(handler());
  net.startAccessPoint(SSID, PASS);
  std::string all = post("WIFI=a%3Bb&CAMERA_ID=front");
  std::shared_ptr<fake::Conn> c = connect(all.substr(0, all.size() - 5));
  pump(net, 3);
  c->remoteLeft = true;
  pump(net, 3);
  TEST_ASSERT_EQ(g_calls.n, 0, "the handler never saw a half body");
  TEST_ASSERT(!c->open, "the slot was freed");
  std::shared_ptr<fake::Conn> d = connect(GET_ROOT);
  pump(net);
  TEST_ASSERT_EQ(statusOf(d), 200, "and the next phone is served");
}

TEST(more_connections_than_slots_are_dropped_and_served_later) {
  world();
  ArduinoSetupNet net(handler());
  net.startAccessPoint(SSID, PASS);
  std::vector<std::shared_ptr<fake::Conn> > idle;
  for (int i = 0; i < 4; ++i) idle.push_back(connect(""));
  std::shared_ptr<fake::Conn> fifth = connect(GET_ROOT);
  pump(net, 2);
  TEST_ASSERT(!fifth->open && fifth->out.empty() && g_calls.n == 0, "the fifth is closed at once, unanswered");
  for (size_t i = 0; i < idle.size(); ++i) TEST_ASSERT(idle[i]->open, "the four that were there first are untouched");
  fake::g().now += SETUP_REQUEST_TIMEOUT_MS + 1;
  pump(net, 2);
  std::shared_ptr<fake::Conn> later = connect(GET_ROOT);
  pump(net);
  TEST_ASSERT_EQ(statusOf(later), 200, "once the idle ones timed out a new phone gets in");
}

TEST(a_flood_of_connections_cannot_make_one_poll_run_long) {
  world();
  ArduinoSetupNet net(handler());
  net.startAccessPoint(SSID, PASS);
  for (int i = 0; i < 100; ++i) connect("");
  net.poll();
  TEST_ASSERT(fake::g().incoming.size() >= 90, "a poll accepts at most one connection per slot");
}

TEST(two_phones_at_once_are_each_answered) {
  world();
  ArduinoSetupNet net(handler());
  net.startAccessPoint(SSID, PASS);
  std::shared_ptr<fake::Conn> a = connect(GET_ROOT), b = connect(post("a=1"));
  pump(net);
  TEST_ASSERT(statusOf(a) == 200 && statusOf(b) == 200 && g_calls.n == 2, "both");
}

TEST(a_missing_handler_answers_500_instead_of_crashing) {
  world();
  ArduinoSetupNet net((SetupHandler()));
  net.startAccessPoint(SSID, PASS);
  std::shared_ptr<fake::Conn> c = connect(GET_ROOT);
  pump(net);
  TEST_ASSERT_EQ(statusOf(c), 500, "500");
}

// ── the reader on its own: the same answer however the bytes are cut ────────────────────────────
TEST(the_reader_gives_the_same_result_for_any_split_of_the_bytes) {
  std::string req = post("a=1&b=2");
  for (size_t cut = 1; cut < req.size(); ++cut) {
    HttpRequestReader r;
    r.feed(req.data(), cut);
    HttpRequestReader::Status st = r.feed(req.data() + cut, req.size() - cut);
    TEST_ASSERT(st == HttpRequestReader::Complete && r.body() == "a=1&b=2" && r.target() == "/save", "split at " + std::to_string(cut));
  }
  HttpRequestReader one;
  HttpRequestReader::Status st = HttpRequestReader::NeedMore;
  for (size_t i = 0; i < req.size(); ++i) st = one.feed(req.data() + i, 1);
  TEST_ASSERT(st == HttpRequestReader::Complete && one.body() == "a=1&b=2", "one byte at a time");
}

TEST(a_rejected_reader_stays_rejected) {
  HttpRequestReader r;
  std::string bad = "get / HTTP/1.1\r\n\r\n";
  TEST_ASSERT(r.feed(bad.data(), bad.size()) == HttpRequestReader::Rejected, "rejected");
  std::string good = GET_ROOT;
  TEST_ASSERT(r.feed(good.data(), good.size()) == HttpRequestReader::Rejected, "later good bytes do not revive it");
  r.reset();
  TEST_ASSERT(r.feed(good.data(), good.size()) == HttpRequestReader::Complete, "reset starts over");
}

// ── helpers for the sketch ──────────────────────────────────────────────────────────────────────
TEST(the_csrf_token_is_32_hex_digits_from_the_hardware_random_generator) {
  world();
  fake::g().randomValue = 0x0abcdef1;
  TEST_ASSERT_EQ(newCsrfToken(), std::string("1fedcba0") + "1fedcba0" + "1fedcba0" + "1fedcba0", "four 32-bit words, hex");
  fake::g().randomValue = 0;
  std::string t = newCsrfToken();
  TEST_ASSERT(t.size() == 32 && t.find_first_not_of("0123456789abcdef") == std::string::npos, "always 32 lowercase hex digits");
}

TEST(the_mac_comes_from_the_efuse_in_the_wifi_format) {
  world();
  TEST_ASSERT_EQ(boardMacAddress(), std::string("AA:BB:CC:D4:E5:F6"), "AA:BB:CC:D4:E5:F6");
  TEST_ASSERT(fake::g().wifiCalls.empty(), "without starting the radio");
  fake::g().efuseMac = 0;
  TEST_ASSERT_EQ(boardMacAddress(), std::string("00:00:00:00:00:00"), "zero stays zero (the form's SSID check rejects it)");
}

// ── the real form and the real session on top of it ─────────────────────────────────────────────
struct RealStore : esp32cam_setup::ISetupStore {      // what the session calls to make SETUP_MODE=0 permanent
  MemoryStore& st;
  explicit RealStore(MemoryStore& s) : st(s) {}
  bool clearSetupMode() override { return st.set("SETUP_MODE", "0"); }
};

static const char* TYPICAL =
    "WIFI=extender-1:password1;SERVER_HOST=192.168.4.9;PUSH_PORT=8081;HTTP_PORT=8080;"
    "CAMERA_ID=cam2;API_KEY=s3cret;PUSH_GAP_MUL=1.5;JPEG_Q_DROP=1;JPEG_Q_MIN=12;JPEG_Q_MAX=63;SIZE_DROP=1;"
    "ALARM_GPIO_PIN=13;ALARM_ACTIVE=LOW;ALARM_ALL_CAMS=0;"
    "LOG_ENABLED=1;LOG_MIN_LEVEL=1;LOG_ECHO=1;LOG_RETRY_MAX=3;LOG_RETRY_SEC=300;LOG_FLUSH_SEC=10;"
    "LOG_REPEAT_SEC=30;LOG_HEARTBEAT=600;LOG_LOW_HEAP=30000";

// An armed, configured recorder with its own master password, behind a real form, session and net.
struct Board {
  MemoryStore st;
  FormConfig cfg;
  std::string ssid;
  std::unique_ptr<SetupForm> form;
  std::unique_ptr<ArduinoSetupNet> net;
  RealStore store;
  std::unique_ptr<SetupMode> session;

  Board() : store(st) {
    world();
    fake::g().randomValue = 0x12345678;
    CheckedLine c = checkLine(esp32cam_settings::RECORDER_SCHEMA, TYPICAL);
    for (size_t i = 0; i < c.pairs.size(); ++i) st.set(c.pairs[i].key, c.pairs[i].value);
    st.set("SETUP_PASSWORD", "My-Own-Master-1");
    st.set("SETUP_MODE", "1");
    cfg.title = "setup";
    cfg.prerequisites = esp32cam_settings::recorderRemotePrerequisites();
    setupSsid("recorder", boardMacAddress(), ssid);
    form.reset(new SetupForm(esp32cam_settings::RECORDER_SCHEMA, st, cfg, newCsrfToken()));
    SetupForm* f = form.get();
    net.reset(new ArduinoSetupNet([f](const std::string& m, const std::string& t, const std::string& b) { return f->handle(m, t, b); }));
    SetupSessionConfig sc;
    sc.ssid = ssid;
    sc.password = setupPassword(esp32cam_settings::RECORDER_SCHEMA, st);
    sc.graceMs = SETUP_RESTART_GRACE_MS;
    sc.retryMs = 5000;
    session.reset(new SetupMode(true, sc, *net, *form, store, nullptr));
  }
  SetupStep tick(int times = 6) {
    SetupStep r = SetupStep::Running;
    for (int i = 0; i < times; ++i) r = session->step(fake::g().now);
    return r;
  }
  // The token the form put into its page, the way a browser would find it.
  std::string tokenFromPage(const std::string& page) {
    size_t at = page.find("name=\"csrf\" value=\"");
    return at == std::string::npos ? "" : page.substr(at + 19, 32);
  }
};

TEST(the_board_opens_the_setup_wifi_named_after_its_mac_with_the_master_password) {
  Board b;
  TEST_ASSERT(b.tick(1) == SetupStep::Running, "the session is running");
  TEST_ASSERT_EQ(fake::g().softApSsid, std::string("espcamsys2-recorder-d4e5f6"), "the SSID the form's rule makes from the board's own MAC");
  TEST_ASSERT_EQ(fake::g().softApPass, std::string("My-Own-Master-1"), "the stored master password");
}

TEST(a_phone_gets_the_real_form_and_the_captive_portal_probe_is_redirected) {
  Board b;
  b.tick(1);
  std::shared_ptr<fake::Conn> page = connect(GET_ROOT), probe = connect("GET /generate_204 HTTP/1.1\r\nHost: connectivitycheck.gstatic.com\r\n\r\n");
  b.tick();
  TEST_ASSERT_EQ(statusOf(page), 200, "the form");
  TEST_ASSERT(page->out.find("Exit setup mode") != std::string::npos && page->out.find("Content-Security-Policy") != std::string::npos, "with the form's own security headers");
  TEST_ASSERT(page->out.find("\r\n\r\n<!doctype html>") != std::string::npos, "and the page after the header block");
  TEST_ASSERT_EQ(statusOf(probe), 302, "a probe is redirected");
  TEST_ASSERT(probe->out.find("Location: http://192.168.4.1/\r\n") != std::string::npos, "to the setup page");
  TEST_ASSERT(page->out.find("My-Own-Master-1") == std::string::npos && page->out.find("s3cret") == std::string::npos, "no secret is in the page");
}

TEST(pressing_exit_ends_setup_clears_the_switch_and_restarts_after_the_grace_time) {
  Board b;
  b.tick(1);
  std::shared_ptr<fake::Conn> page = connect(GET_ROOT);
  b.tick();
  std::string token = b.tokenFromPage(page->out);
  TEST_ASSERT_EQ(token.size(), (size_t)32, "the page carries the session token");
  std::shared_ptr<fake::Conn> exit = connect(post("csrf=" + token).replace(0, 10, "POST /exit"));
  b.tick(3);
  TEST_ASSERT_EQ(statusOf(exit), 200, "the form answers 'restarting'");
  TEST_ASSERT(b.form->exited() && b.st.get("SETUP_MODE") == "0", "exited, and the switch is off");
  TEST_ASSERT(b.tick(1) == SetupStep::Running && fake::g().softApUp, "the setup WiFi is still up during the grace time");
  fake::g().now += SETUP_RESTART_GRACE_MS;
  TEST_ASSERT(b.tick(1) == SetupStep::Restart, "then the session says Restart");
  TEST_ASSERT(!fake::g().softApUp && fake::g().wifiMode == WIFI_OFF && fake::g().wifiPersistent, "with the radio left clean for connectWifi()");
}

TEST(a_post_without_the_token_is_refused_and_the_board_stays_in_setup_for_days) {
  Board b;
  b.tick(1);
  std::shared_ptr<fake::Conn> bad = connect("POST /exit HTTP/1.1\r\nContent-Length: 4\r\n\r\nx=yz");
  b.tick();
  TEST_ASSERT_EQ(statusOf(bad), 403, "403");
  TEST_ASSERT(!b.form->exited() && b.st.get("SETUP_MODE") == "1", "nothing changed");
  for (int day = 0; day < 3; ++day) {
    fake::g().now += 24UL * 3600UL * 1000UL;   // millis() wraps after ~49.7 days; three days are not it, the session test covers that
    TEST_ASSERT(b.tick(2) == SetupStep::Running, "still in setup");
  }
  TEST_ASSERT(fake::g().softApUp && fake::g().dnsRunning && fake::g().tcpListening, "with the WiFi, DNS and HTTP up");
  std::shared_ptr<fake::Conn> page = connect(GET_ROOT);
  b.tick();
  TEST_ASSERT_EQ(statusOf(page), 200, "and the form still answers");
}

// ── SetupBoot (setup_boot.h) over the real hardware class ───────────────────────────────────────
static void storeLine(MemoryStore& st, const char* line) {
  CheckedLine c = checkLine(esp32cam_settings::RECORDER_SCHEMA, line);
  for (size_t i = 0; i < c.pairs.size(); ++i) st.set(c.pairs[i].key, c.pairs[i].value);
}

TEST(the_real_hardware_gives_the_boards_address_a_fresh_token_and_the_serial_port) {
  world();
  fake::g().randomValue = 0x12345678;
  ArduinoSetupHardware hw;
  TEST_ASSERT_EQ(hw.mac(), std::string("AA:BB:CC:D4:E5:F6"), "the eFuse address");
  std::string a = hw.newToken(), b = hw.newToken();
  TEST_ASSERT(a.size() == 32 && a.find_first_not_of("0123456789abcdef") == std::string::npos, "a token is 32 hex digits");
  hw.log("setup: a line for the serial port");
  TEST_ASSERT(logged("setup: a line for the serial port"), "log() writes to the serial port");
  TEST_ASSERT(fake::g().wifiCalls.empty(), "asking for the address, a token or a log line never starts the radio");
}

TEST(the_real_hardware_opens_an_access_point_that_answers_with_the_handler_it_was_given) {
  world();
  ArduinoSetupHardware hw;
  std::unique_ptr<ISetupNet> net = hw.openNet(handler());
  TEST_ASSERT(net != nullptr, "a net");
  TEST_ASSERT(fake::g().wifiCalls.empty(), "opening it does not start the radio yet");
  TEST_ASSERT(net->startAccessPoint(SSID, PASS), "it starts");
  std::shared_ptr<fake::Conn> c = connect(GET_ROOT);
  for (int i = 0; i < 6; ++i) net->poll();
  TEST_ASSERT_EQ(statusOf(c), 200, "a phone is answered");
  TEST_ASSERT_EQ(g_calls.n, 1, "by the handler the hardware was given");
  net->stop();
  TEST_ASSERT(!fake::g().softApUp, "and it stops");
}

TEST(a_board_that_is_not_in_setup_never_touches_the_radio_or_the_hardware) {
  world();
  MemoryStore st;
  storeLine(st, TYPICAL);
  size_t storedBefore = st.m.size();
  ArduinoSetupHardware hw;
  SetupBoot boot(esp32cam_settings::RECORDER_SCHEMA, st, esp32cam_settings::recorderRemotePrerequisites(), "recorder", hw);
  TEST_ASSERT(!boot.active() && !boot.armed(), "configured and not armed: not in setup");
  TEST_ASSERT(boot.step(1) == SetupStep::Proceed && boot.step(99999) == SetupStep::Proceed, "Proceed, every time");
  boot.stop();
  TEST_ASSERT(fake::g().wifiCalls.empty() && !fake::g().softApUp && !fake::g().dnsRunning && !fake::g().tcpListening, "the radio, DNS and the HTTP server were never touched");
  TEST_ASSERT(fake::g().serial.empty(), "and nothing was printed");
  TEST_ASSERT(st.m.size() == storedBefore && !st.has("SETUP_MODE"), "nothing was written");
}

TEST(a_blank_board_opens_the_setup_wifi_with_the_default_password_and_is_not_armed) {
  world();
  MemoryStore st;
  ArduinoSetupHardware hw;
  SetupBoot boot(esp32cam_settings::RECORDER_SCHEMA, st, esp32cam_settings::recorderRemotePrerequisites(), "recorder", hw);
  TEST_ASSERT(boot.active() && !boot.armed(), "a blank board is in setup, not 'armed'");
  TEST_ASSERT(boot.step(1) == SetupStep::Running, "running");
  TEST_ASSERT_EQ(fake::g().softApSsid, std::string("espcamsys2-recorder-d4e5f6"), "named after its MAC");
  TEST_ASSERT_EQ(fake::g().softApPass, std::string(SETUP_DEFAULT_PASSWORD), "with the built-in default password");
  TEST_ASSERT(!logged(SETUP_DEFAULT_PASSWORD), "which is never printed");
  boot.stop();
  TEST_ASSERT(!fake::g().softApUp, "stop() takes the access point down");
}

TEST(an_armed_board_serves_the_form_and_leaves_with_a_restart_when_exited) {
  world();
  fake::g().randomValue = 0x12345678;
  MemoryStore st;
  storeLine(st, TYPICAL);
  st.set("SETUP_PASSWORD", "My-Own-Master-1");
  st.set("SETUP_MODE", "1");
  ArduinoSetupHardware hw;
  SetupBoot boot(esp32cam_settings::RECORDER_SCHEMA, st, esp32cam_settings::recorderRemotePrerequisites(), "recorder", hw);
  TEST_ASSERT(boot.active() && boot.armed(), "armed");
  TEST_ASSERT(boot.step(fake::g().now) == SetupStep::Running, "running");
  TEST_ASSERT_EQ(fake::g().softApPass, std::string("My-Own-Master-1"), "the stored master password is the WiFi password");

  std::shared_ptr<fake::Conn> page = connect(GET_ROOT);
  for (int i = 0; i < 6; ++i) boot.step(fake::g().now);
  size_t at = page->out.find("name=\"csrf\" value=\"");
  TEST_ASSERT(statusOf(page) == 200 && at != std::string::npos, "the real form, with its token");
  std::string token = page->out.substr(at + 19, 32);
  std::shared_ptr<fake::Conn> exit = connect(post("csrf=" + token).replace(0, 10, "POST /exit"));
  for (int i = 0; i < 6; ++i) boot.step(fake::g().now);
  TEST_ASSERT_EQ(statusOf(exit), 200, "'Exit setup mode' is answered");
  TEST_ASSERT_EQ(st.get("SETUP_MODE"), std::string("0"), "the switch is off in the store the board restarts from");
  TEST_ASSERT(boot.step(fake::g().now) == SetupStep::Running && fake::g().softApUp, "the WiFi stays up for the grace time");
  fake::g().now += SETUP_RESTART_GRACE_MS;
  TEST_ASSERT(boot.step(fake::g().now) == SetupStep::Restart, "then Restart");
  TEST_ASSERT(!fake::g().softApUp && fake::g().wifiMode == WIFI_OFF, "with the radio left clean");
  TEST_ASSERT(!logged("My-Own-Master-1"), "the password was never printed");
}

int main() {
  RUN_TEST(the_access_point_starts_protected_on_the_right_ports);
  RUN_TEST(an_unprotected_or_invalid_access_point_is_never_started);
  RUN_TEST(a_failed_start_cleans_up_and_can_be_retried);
  RUN_TEST(a_second_start_begins_from_a_clean_radio);
  RUN_TEST(stop_leaves_the_wifi_clean_for_connectWifi);
  RUN_TEST(a_board_that_never_started_is_never_touched);
  RUN_TEST(the_destructor_stops_a_running_access_point);
  RUN_TEST(a_get_reaches_the_handler_and_the_reply_goes_back_whole);
  RUN_TEST(a_post_body_split_over_many_polls_is_handled_once_and_whole);
  RUN_TEST(a_body_is_handed_over_byte_exact_including_nul_and_percent);
  RUN_TEST(the_request_target_reaches_the_handler_whole_query_included);
  RUN_TEST(other_methods_are_left_to_the_handler_to_refuse);
  RUN_TEST(the_headers_the_handler_chose_are_sent_as_they_are);
  RUN_TEST(a_reply_cannot_split_the_message_or_forge_its_framing);
  RUN_TEST(a_refusal_by_the_glue_is_never_cached_or_sniffed);
  RUN_TEST(a_socket_that_takes_a_few_bytes_at_a_time_still_gets_everything);
  RUN_TEST(a_socket_that_takes_nothing_does_not_hang_the_board);
  RUN_TEST(malformed_requests_are_refused_and_never_reach_the_handler);
  RUN_TEST(a_body_exactly_at_the_cap_is_accepted_and_one_more_byte_is_not);
  RUN_TEST(bytes_after_the_announced_body_are_ignored);
  RUN_TEST(an_oversized_body_is_refused_without_waiting_for_it);
  RUN_TEST(a_client_that_sends_nothing_is_dropped_after_the_timeout);
  RUN_TEST(a_client_that_trickles_bytes_cannot_hold_a_slot_for_ever);
  RUN_TEST(a_client_that_leaves_mid_save_changes_nothing);
  RUN_TEST(more_connections_than_slots_are_dropped_and_served_later);
  RUN_TEST(a_flood_of_connections_cannot_make_one_poll_run_long);
  RUN_TEST(two_phones_at_once_are_each_answered);
  RUN_TEST(a_missing_handler_answers_500_instead_of_crashing);
  RUN_TEST(the_reader_gives_the_same_result_for_any_split_of_the_bytes);
  RUN_TEST(a_rejected_reader_stays_rejected);
  RUN_TEST(the_csrf_token_is_32_hex_digits_from_the_hardware_random_generator);
  RUN_TEST(the_mac_comes_from_the_efuse_in_the_wifi_format);
  RUN_TEST(the_board_opens_the_setup_wifi_named_after_its_mac_with_the_master_password);
  RUN_TEST(a_phone_gets_the_real_form_and_the_captive_portal_probe_is_redirected);
  RUN_TEST(pressing_exit_ends_setup_clears_the_switch_and_restarts_after_the_grace_time);
  RUN_TEST(a_post_without_the_token_is_refused_and_the_board_stays_in_setup_for_days);
  RUN_TEST(the_real_hardware_gives_the_boards_address_a_fresh_token_and_the_serial_port);
  RUN_TEST(the_real_hardware_opens_an_access_point_that_answers_with_the_handler_it_was_given);
  RUN_TEST(a_board_that_is_not_in_setup_never_touches_the_radio_or_the_hardware);
  RUN_TEST(a_blank_board_opens_the_setup_wifi_with_the_default_password_and_is_not_armed);
  RUN_TEST(an_armed_board_serves_the_form_and_leaves_with_a_restart_when_exited);
  return test::summarize();
}
