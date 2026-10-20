// test_person_report_logic.cpp — unit tests for what the person detector tells the relay and how it
// keeps its connection to the relay up (ESP32_CAM_TFLite_Person/report_logic.h). No ESP32, no
// Arduino core: the connection runs against a FAKE environment (socket, clock, JPEG encoder, the
// detection loop's snapshot) that can fail on cue, so every way the link can go wrong is exercised —
// and checked to say what went wrong in its log line, which is the whole point: a detector that
// "just does not show up" used to leave no trace anywhere.
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -Wall -Wextra -o build/test_person_report_logic test_person_report_logic.cpp

#include "framework.h"

#include <string.h>
#include <string>
#include <utility>
#include <vector>

#include "../../Arduino/ESP32_CAM_TFLite_Person/report_logic.h"

using namespace person_report;

static bool has(const std::string& s, const char* part) { return s.find(part) != std::string::npos; }

static Config cfg() {
    Config c;
    c.detectorId = "detector-1"; c.fw = "abc 1";
    c.gpioPin = 13; c.darkBelow = 40; c.motionAtLeast = 300; c.holdSec = 10; c.detectAt = 0.6f; c.clearAt = 0.5f;
    return c;
}

static Snapshot snap() {
    Snapshot s;
    s.valid = true; s.seq = 7; s.brightness = 120; s.motion = 812; s.gate = Gate::Active;
    s.hasScore = true; s.score = 0.74f; s.scoreAtMs = 1000; s.detected = true;
    return s;
}

static LinkStats link(uint32_t frames = 5, uint32_t fails = 1, uint32_t reconnects = 2, uint32_t heap = 91000) {
    LinkStats l; l.frames = frames; l.jpegFails = fails; l.reconnects = reconnects; l.heap = heap;
    return l;
}

// ── JSON strings ─────────────────────────────────────────────────────────

TEST(json_strings_are_escaped) {
    std::string out;
    appendJsonString(out, "a\"b\\c\n\t\r\x01 é");
    TEST_ASSERT_EQ(out, std::string("\"a\\\"b\\\\c\\n\\t\\r\\u0001 é\""), "quotes, backslashes, control characters escaped; UTF-8 passes through");
    std::string empty;
    appendJsonString(empty, "");
    TEST_ASSERT_EQ(empty, std::string("\"\""), "an empty string is two quotes");
}

TEST(log_url) {
    TEST_ASSERT_EQ(buildLogUrl("192.168.4.9", 8080), std::string("http://192.168.4.9:8080/log"), "the relay's log endpoint");
}

// ── the gate ─────────────────────────────────────────────────────────────

TEST(gate_names_and_mapping) {
    TEST_ASSERT_EQ(std::string(gateName(Gate::Dark)), std::string("dark"), "dark");
    TEST_ASSERT_EQ(std::string(gateName(Gate::Still)), std::string("still"), "still");
    TEST_ASSERT_EQ(std::string(gateName(Gate::Active)), std::string("active"), "active");
    TEST_ASSERT_EQ(std::string(gateName(Gate::Off)), std::string("off"), "off");
    using person_scene::SceneState;
    TEST_ASSERT(gateFor(SceneState::Dark, 40, 300) == Gate::Dark, "dark scene -> dark");
    TEST_ASSERT(gateFor(SceneState::Idle, 40, 300) == Gate::Still, "idle scene -> still");
    TEST_ASSERT(gateFor(SceneState::Active, 40, 300) == Gate::Active, "active scene -> active");
    TEST_ASSERT(gateFor(SceneState::Active, 0, 0) == Gate::Off, "both checks off -> the gate is off");
    TEST_ASSERT(gateFor(SceneState::Dark, 0, 300) == Gate::Dark, "only the motion check off: still reports the scene");
    TEST_ASSERT(gateFor(SceneState::Idle, 40, 0) == Gate::Still, "only the darkness check off: still reports the scene");
}

// ── the readings ─────────────────────────────────────────────────────────

TEST(status_json_carries_everything_the_dashboard_shows) {
    std::string j = buildStatusJson(cfg(), snap(), 1500, "192.168.4.37", -61, 123456, link());
    TEST_ASSERT(has(j, "\"ip\":\"192.168.4.37\""), "ip");
    TEST_ASSERT(has(j, "\"fw\":\"abc 1\""), "firmware build");
    TEST_ASSERT(has(j, "\"uptimeMs\":123456,\"rssi\":-61"), "uptime and signal");
    TEST_ASSERT(has(j, "\"gpio\":{\"pin\":13,\"high\":true}"), "alarm pin and its level");
    TEST_ASSERT(has(j, "\"scene\":{\"state\":\"active\",\"brightness\":120,\"motion\":812,\"darkBelow\":40,\"motionAtLeast\":300,\"holdS\":10}"), "the gate's readings and thresholds");
    TEST_ASSERT(has(j, "\"person\":{\"score\":0.740,\"detectAt\":0.600,\"clearAt\":0.500,\"detected\":true}"), "score, thresholds and verdict");
    TEST_ASSERT(has(j, "\"link\":{\"frames\":5,\"jpegFails\":1,\"reconnects\":2,\"heap\":91000}"), "how the link is doing");
    TEST_ASSERT(j.front() == '{' && j.back() == '}', "one object");
    TEST_ASSERT(j.find('\n') == std::string::npos, "no line breaks");
    TEST_ASSERT(!has(j, "jpeg\":\"") && !has(j, "base64"), "the picture is never inside the readings");
    TEST_ASSERT(j.size() < 400, "small enough to send several times a second");
}

TEST(status_json_scores) {
    Snapshot s = snap();
    TEST_ASSERT(has(buildStatusJson(cfg(), s, 1000 + SCORE_FRESH_MS, "x", 0, 0, link()), "\"score\":0.740"), "a score exactly at the freshness limit is shown");
    TEST_ASSERT(has(buildStatusJson(cfg(), s, 1000 + SCORE_FRESH_MS + 1, "x", 0, 0, link()), "\"score\":null"), "an older score is not shown (model paused)");
    s.hasScore = false;
    TEST_ASSERT(has(buildStatusJson(cfg(), s, 1000, "x", 0, 0, link()), "\"score\":null"), "no score yet");
    s = snap(); s.score = 1.7f;
    TEST_ASSERT(has(buildStatusJson(cfg(), s, 1000, "x", 0, 0, link()), "\"score\":1.000"), "a score above 1 is clamped");
    s.score = -0.2f;
    TEST_ASSERT(has(buildStatusJson(cfg(), s, 1000, "x", 0, 0, link()), "\"score\":0.000"), "a negative score is clamped");
    s = snap(); s.scoreAtMs = 0xFFFFFF00u;
    TEST_ASSERT(has(buildStatusJson(cfg(), s, 0x00000100u, "x", 0, 0, link()), "\"score\":0.740"), "freshness survives the millis() wrap");
}

TEST(status_json_other_states) {
    Snapshot s = snap();
    s.detected = false; s.gate = Gate::Dark; s.brightness = 3;
    std::string j = buildStatusJson(cfg(), s, 1000, "x", -70, 5, link());
    TEST_ASSERT(has(j, "\"high\":false") && has(j, "\"detected\":false"), "pin low and no person");
    TEST_ASSERT(has(j, "\"state\":\"dark\",\"brightness\":3"), "dark gate");
    Config c = cfg(); c.detectAt = 0.123456f; c.clearAt = 0.5f;
    TEST_ASSERT(has(buildStatusJson(c, snap(), 1000, "x", 0, 0, link()), "\"detectAt\":0.123"), "thresholds are printed with three decimals");
    c = cfg(); c.fw = "quote\" and \\ slash"; 
    TEST_ASSERT(has(buildStatusJson(c, snap(), 1000, "x", 0, 0, link()), "\"fw\":\"quote\\\" and \\\\ slash\""), "text fields are escaped");
}

// ── the wire format ──────────────────────────────────────────────────────

TEST(frame_message_layout_is_what_the_relay_reads) {
    const uint8_t jpeg[] = { 0xff, 0xd8, 0xff, 0xd9 };
    std::string m = buildFrameMessage("{\"a\":1}", jpeg, sizeof(jpeg));
    TEST_ASSERT_EQ(m.size(), (size_t)(4 + 1 + 2 + 7 + 4), "length prefix + type + status length + status + picture");
    TEST_ASSERT_EQ((int)(uint8_t)m[0] * 16777216 + (int)(uint8_t)m[1] * 65536 + (int)(uint8_t)m[2] * 256 + (int)(uint8_t)m[3], 1 + 2 + 7 + 4, "the length prefix counts the message only, big-endian");
    TEST_ASSERT_EQ((int)(uint8_t)m[4], 1, "message type 1 = frame");
    TEST_ASSERT_EQ(((int)(uint8_t)m[5] << 8) | (int)(uint8_t)m[6], 7, "status length, big-endian");
    TEST_ASSERT_EQ(m.substr(7, 7), std::string("{\"a\":1}"), "the status JSON");
    TEST_ASSERT_EQ((int)(uint8_t)m[14], 0xff, "then the picture");
    TEST_ASSERT_EQ((int)(uint8_t)m[17], 0xd9, "...to its last byte");
}

TEST(frame_message_without_a_picture_is_a_heartbeat) {
    std::string m = buildFrameMessage("{\"a\":1}", nullptr, 0);
    TEST_ASSERT_EQ(m.size(), (size_t)(4 + 1 + 2 + 7), "no picture bytes");
    TEST_ASSERT_EQ((int)(uint8_t)m[3], 10, "length prefix = 10");
    const uint8_t jpeg[] = { 0xff, 0xd8 };
    TEST_ASSERT_EQ(buildFrameMessage("{\"a\":1}", nullptr, 2).size(), (size_t)(4 + 1 + 2 + 7), "a null picture with a length is no picture");
    (void)jpeg;
}

TEST(frame_message_refuses_what_the_relay_would_refuse) {
    TEST_ASSERT(buildFrameMessage("", nullptr, 0).empty(), "an empty status is no message");
    TEST_ASSERT(buildFrameMessage(std::string(MAX_STATUS_BYTES + 1, 'x'), nullptr, 0).empty(), "a status over the limit is no message");
    TEST_ASSERT(!buildFrameMessage(std::string(MAX_STATUS_BYTES, 'x'), nullptr, 0).empty(), "a status at the limit is fine");
    std::vector<uint8_t> big(MAX_JPEG_BYTES + 1, 0xff);
    TEST_ASSERT(buildFrameMessage("{}", big.data(), big.size()).empty(), "a picture over the limit is no message");
    big.resize(MAX_JPEG_BYTES);
    TEST_ASSERT(!buildFrameMessage("{}", big.data(), big.size()).empty(), "a picture at the limit is fine");
}

TEST(uplink_request_is_what_the_relay_expects) {
    TEST_ASSERT_EQ(buildUplinkRequest("192.168.4.9", 8080, "detector-1", "s3cret"),
                   std::string("GET /detector/detector-1/uplink HTTP/1.1\r\n"
                               "Host: 192.168.4.9:8080\r\n"
                               "Connection: Upgrade\r\n"
                               "Upgrade: espcam-detector/1\r\n"
                               "X-Api-Key: s3cret\r\n\r\n"), "request line, host, upgrade headers, key, blank line");
}

// ── reading the relay's answer ───────────────────────────────────────────

TEST(json_error_extraction) {
    TEST_ASSERT_EQ(extractJsonError("{\"error\":\"wrong key\"}"), std::string("wrong key"), "plain");
    TEST_ASSERT_EQ(extractJsonError("{\"x\":1, \"error\" : \"a \\\"b\\\" c\\\\d\"}"), std::string("a \"b\" c\\d"), "spaces and escapes");
    TEST_ASSERT_EQ(extractJsonError("{\"error\":\"line\\nbreak\"}"), std::string("line break"), "a newline becomes a space");
    TEST_ASSERT_EQ(extractJsonError("{\"ok\":true}"), std::string(), "no error member");
    TEST_ASSERT_EQ(extractJsonError("{\"error\":\"never closed"), std::string(), "unterminated string is not trusted");
    TEST_ASSERT_EQ(extractJsonError("{\"error\""), std::string(), "no value");
    TEST_ASSERT_EQ(extractJsonError("<html>Cannot GET /x</html>"), std::string(), "not JSON at all");
    TEST_ASSERT_EQ(extractJsonError(""), std::string(), "empty");
}

TEST(uplink_head_accepted) {
    UplinkHead h = parseUplinkHead("HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: espcam-detector/1\r\n\r\n", false);
    TEST_ASSERT(h.kind == UplinkHead::Accepted && h.status == 101, "a 101 is the go-ahead");
    h = parseUplinkHead("HTTP/1.1 101 Switching Protocols\r\n\r\n\x01\x02 stream bytes already", false);
    TEST_ASSERT(h.kind == UplinkHead::Accepted, "bytes after the head do not matter");
}

TEST(uplink_head_incomplete) {
    TEST_ASSERT(parseUplinkHead("", false).kind == UplinkHead::Incomplete, "nothing yet");
    TEST_ASSERT(parseUplinkHead("HTTP/1.1 101 Switching Pro", false).kind == UplinkHead::Incomplete, "head not finished");
    TEST_ASSERT(parseUplinkHead("HTTP/1.1 101 Switching Protocols\r\n\r", false).kind == UplinkHead::Incomplete, "blank line not finished");
}

TEST(uplink_head_refused_reads_the_relays_reason) {
    std::string body = "{\"error\":\"wrong key: API_KEY on the board must equal camKey in the relay's config.js\"}";
    std::string all = "HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: " + std::to_string(body.size()) + "\r\nConnection: close\r\n\r\n" + body;
    UplinkHead h = parseUplinkHead(all, false);
    TEST_ASSERT(h.kind == UplinkHead::Refused && h.status == 401, "a 401");
    TEST_ASSERT(has(h.detail, "wrong key") && has(h.detail, "camKey"), "carrying the relay's own words");
    h = parseUplinkHead(all.substr(0, all.size() - 20), false);
    TEST_ASSERT(h.kind == UplinkHead::Incomplete, "the body is announced but not all here: wait for it");
    h = parseUplinkHead(all.substr(0, all.size() - 20), true);
    TEST_ASSERT(h.kind == UplinkHead::Refused && h.status == 401, "...unless the relay has closed: then judge what there is");
    std::string lower = "HTTP/1.1 401 Unauthorized\r\ncontent-length: 5\r\n\r\n{\"er";
    TEST_ASSERT(parseUplinkHead(lower, false).kind == UplinkHead::Incomplete, "the header name is found in lower case too");
}

TEST(uplink_head_refused_without_json) {
    UplinkHead h = parseUplinkHead("HTTP/1.1 404 Not Found\r\nContent-Type: text/html\r\nContent-Length: 20\r\n\r\n<pre>Cannot GET /x</pre>", false);
    TEST_ASSERT(h.kind == UplinkHead::Refused && h.status == 404, "an HTML 404 (a relay that predates the uplink)");
    TEST_ASSERT_EQ(h.detail, std::string("Not Found"), "no JSON reason: the HTTP reason phrase is used");
    h = parseUplinkHead("HTTP/1.1 503 Service Unavailable\r\n\r\n", false);
    TEST_ASSERT(h.kind == UplinkHead::Refused && h.detail == "Service Unavailable", "no body at all");
    h = parseUplinkHead("HTTP/1.1 500 Internal\r\nContent-Length: 999999\r\n\r\nabc", false);
    TEST_ASSERT(h.kind == UplinkHead::Refused, "an absurd announced length is not waited for");
}

TEST(uplink_head_malformed) {
    UplinkHead h = parseUplinkHead("SSH-2.0-OpenSSH_9.2\r\n\r\n", false);
    TEST_ASSERT(h.kind == UplinkHead::Malformed && has(h.detail, "not HTTP: 'SSH-2.0") , "something that is not HTTP is quoted");
    h = parseUplinkHead("HTTP/1.1 abc Nope\r\n\r\n", false);
    TEST_ASSERT(h.kind == UplinkHead::Malformed, "a status that is not a number");
    h = parseUplinkHead("HTTP/1.1 99 Low\r\n\r\n", false);
    TEST_ASSERT(h.kind == UplinkHead::Malformed, "a status below 100");
    h = parseUplinkHead(std::string("\x16\x03\x01 binary garbage\r\n\r\n"), false);
    TEST_ASSERT(h.kind == UplinkHead::Malformed && has(h.detail, "..."), "binary bytes are shown as dots");
    h = parseUplinkHead(std::string(3000, 'x'), false);
    TEST_ASSERT(h.kind == UplinkHead::Malformed && has(h.detail, "over 2048"), "a head that never ends");
    h = parseUplinkHead("HTTP/1.1 101 Switch", true);
    TEST_ASSERT(h.kind == UplinkHead::Malformed && has(h.detail, "cut off"), "closed in the middle of the head");
}

TEST(uplink_head_closed_silently) {
    TEST_ASSERT(parseUplinkHead("", true).kind == UplinkHead::ClosedSilently, "the relay hung up without a word");
}

TEST(refusals_are_explained_with_what_to_do) {
    std::string e401 = explainRefusal(401, "wrong key: x", "10.0.0.1", 8080);
    TEST_ASSERT(has(e401, "10.0.0.1:8080") && has(e401, "HTTP 401") && has(e401, "wrong key: x") && has(e401, "API_KEY") && has(e401, "camKey"), "401: names the relay, the reason and both settings");
    std::string own = explainRefusal(401, "wrong key: API_KEY on the board must equal camKey in the relay's config.js", "10.0.0.1", 8080);
    TEST_ASSERT(own.find("camKey") == own.rfind("camKey"), "...but a relay that already says it is not repeated");
    std::string e404 = explainRefusal(404, "Not Found", "10.0.0.1", 8080);
    TEST_ASSERT(has(e404, "HTTP 404") && has(e404, "older than this firmware") && has(e404, "update and restart nodejs/camera-relay"), "404: a relay that is too old");
    TEST_ASSERT(has(explainRefusal(426, "x", "h", 1), "not the same version"), "426: version mismatch");
    TEST_ASSERT(has(explainRefusal(503, "too many", "h", 1), "HTTP 503") && has(explainRefusal(503, "too many", "h", 1), "too many"), "503: carries the reason");
    TEST_ASSERT(has(explainRefusal(418, "", "h", 2), "HTTP 418") && has(explainRefusal(418, "", "h", 2), "no reason given"), "anything else, even without a reason");
}

// ── small helpers ────────────────────────────────────────────────────────

TEST(wifi_status_names) {
    TEST_ASSERT(has(wifiStatusName(1), "NO_SSID_AVAIL") && has(wifiStatusName(1), "none of the WIFI networks is in range"), "no SSID in range");
    TEST_ASSERT(has(wifiStatusName(4), "CONNECT_FAILED") && has(wifiStatusName(4), "password"), "connect failed hints at the password");
    TEST_ASSERT(has(wifiStatusName(3), "CONNECTED"), "connected");
    TEST_ASSERT(has(wifiStatusName(6), "DISCONNECTED") && has(wifiStatusName(5), "CONNECTION_LOST") && has(wifiStatusName(0), "IDLE"), "the others");
    TEST_ASSERT(has(wifiStatusName(255), "NO_SHIELD") && has(wifiStatusName(2), "SCAN_COMPLETED"), "255 and 2");
    TEST_ASSERT(has(wifiStatusName(77), "unknown"), "an unknown number");
}

TEST(camera_errors_come_with_the_likely_cure) {
    TEST_ASSERT(has(cameraErrorHint(0x105), "ribbon cable") && has(cameraErrorHint(0x105), "5 V supply"), "ESP_ERR_NOT_FOUND: the cable and the supply");
    TEST_ASSERT_EQ(std::string(cameraErrorHint(0x20001)), std::string(cameraErrorHint(0x105)), "the camera component's own 'not detected' reads the same");
    TEST_ASSERT(has(cameraErrorHint(0x101), "PSRAM"), "out of memory points at PSRAM");
    TEST_ASSERT(has(cameraErrorHint(0x102), "already started"), "invalid state");
    TEST_ASSERT(has(cameraErrorHint(0x20002), "does not support") && has(cameraErrorHint(0x20004), "does not support"), "unsupported size / format");
    TEST_ASSERT_EQ(std::string(cameraErrorHint(0x999)), std::string(), "an unknown code adds nothing");
    TEST_ASSERT(cameraErrorHint(0x105)[0] == ' ' && cameraErrorHint(0x105)[1] == '-', "every hint is a suffix: it starts with ' - '");
}

TEST(durations) {
    TEST_ASSERT_EQ(formatDuration(0), std::string("0s"), "zero");
    TEST_ASSERT_EQ(formatDuration(42999), std::string("42s"), "seconds");
    TEST_ASSERT_EQ(formatDuration(185000), std::string("3m 05s"), "minutes");
    TEST_ASSERT_EQ(formatDuration(3 * 3600000u + 12 * 60000u), std::string("3h 12m"), "hours");
    TEST_ASSERT_EQ(formatDuration(2 * 86400000u + 5 * 3600000u), std::string("2d 5h"), "days");
}

TEST(wifi_watch_turns_transitions_into_events) {
    WifiWatch w(10000);
    TEST_ASSERT(w.update(100, false).kind == WifiEvent::None, "just booted, not connected yet: nothing to say");
    TEST_ASSERT(w.update(5000, false).kind == WifiEvent::None, "still within the first 10 s");
    WifiEvent e = w.update(10100, false);
    TEST_ASSERT(e.kind == WifiEvent::StillDown && e.downForMs == 10000, "10 s after boot with no Wi-Fi: say so, with how long");
    TEST_ASSERT(w.update(15000, false).kind == WifiEvent::None, "not again until another 10 s");
    e = w.update(20100, false);
    TEST_ASSERT(e.kind == WifiEvent::StillDown && e.downForMs == 20000, "and again");
    TEST_ASSERT(w.update(21000, true).kind == WifiEvent::Connected, "the first connection after boot");
    TEST_ASSERT(w.update(22000, true).kind == WifiEvent::None, "staying up is silent");
    TEST_ASSERT(w.update(30000, false).kind == WifiEvent::Lost, "losing it is said once");
    TEST_ASSERT(w.update(31000, false).kind == WifiEvent::None, "...not on every pass");
    e = w.update(40000, false);
    TEST_ASSERT(e.kind == WifiEvent::StillDown && e.downForMs == 10000, "still down: how long since it was lost");
    e = w.update(45000, true);
    TEST_ASSERT(e.kind == WifiEvent::Reconnected && e.downForMs == 15000, "back: how long it was gone");
    TEST_ASSERT(w.update(46000, true).kind == WifiEvent::None, "quiet again");
}

TEST(wifi_watch_connected_at_once) {
    WifiWatch w;
    TEST_ASSERT(w.update(0, true).kind == WifiEvent::Connected, "up on the very first look");
}

TEST(every_fires_once_per_period) {
    Every e(1000);
    TEST_ASSERT(!e.due(5000), "the first call only starts the clock");
    TEST_ASSERT(!e.due(5999), "not yet");
    TEST_ASSERT(e.due(6000), "a period later");
    TEST_ASSERT(!e.due(6500), "then quiet");
    TEST_ASSERT(e.due(7000), "and again");
    Every w(1000);
    w.due(0xFFFFFF00u);
    TEST_ASSERT(!w.due(0x000001FFu), "767 ms later, across the wrap: not yet");
    TEST_ASSERT(w.due(0x000003FFu), "1279 ms later, across the wrap: due");
}

// ── when to send ─────────────────────────────────────────────────────────

TEST(send_policy_pacing) {
    SendPolicy p(100, 1000);
    TEST_ASSERT(p.decide(0, false, 0) == SendPolicy::Nothing, "no frame seen yet: nothing to say");
    TEST_ASSERT(p.mayLook(0), "before anything was sent the snapshot may be looked at");
    TEST_ASSERT(p.decide(0, true, 5) == SendPolicy::Frame, "the first message goes out at once");
    p.onFrameSent(1000, 5);
    TEST_ASSERT(!p.mayLook(1050), "within the minimum gap: do not even look");
    TEST_ASSERT(p.decide(1050, true, 6) == SendPolicy::Nothing, "a new frame inside the gap waits");
    TEST_ASSERT(p.mayLook(1100), "gap over");
    TEST_ASSERT(p.decide(1100, true, 6) == SendPolicy::Frame, "a new frame after the gap is sent");
    TEST_ASSERT(p.decide(1100, true, 5) == SendPolicy::Nothing, "the same frame as before is not sent again, until the heartbeat");
    p.onFrameSent(1100, 6);
    TEST_ASSERT(p.decide(1999, true, 6) == SendPolicy::Nothing, "no new frame, heartbeat not due");
    TEST_ASSERT(p.decide(2100, true, 6) == SendPolicy::Heartbeat, "no new frame for a second: a heartbeat, so the relay knows we are alive");
    p.onHeartbeatSent(2100);
    TEST_ASSERT(p.sentSeq() == 6, "a heartbeat does not change which frame was sent");
    TEST_ASSERT(p.decide(2200, true, 6) == SendPolicy::Nothing, "and the next heartbeat is a second later");
    TEST_ASSERT(p.decide(2200, true, 7) == SendPolicy::Frame, "a new frame still goes at once");
}

TEST(send_policy_reset_and_wrap) {
    SendPolicy p(100, 1000);
    p.onFrameSent(500, 9);
    p.reset();
    TEST_ASSERT(p.decide(501, true, 9) == SendPolicy::Frame, "after a new connection even an old frame goes out at once");
    TEST_ASSERT(p.sentSeq() == 0, "so the snapshot hands the frame over again");
    SendPolicy w(100, 1000);
    w.onFrameSent(0xFFFFFFF0u, 1);
    TEST_ASSERT(w.decide(0x00000010u, true, 2) == SendPolicy::Nothing, "32 ms after, across the wrap: inside the gap");
    TEST_ASSERT(w.decide(0x00000070u, true, 2) == SendPolicy::Frame, "112 ms after, across the wrap: sent");
}

TEST(backoff_starts_short_doubles_and_caps) {
    TEST_ASSERT_EQ(backoffDelayMs(0, 2000, 30000), 0u, "no failure, no wait");
    TEST_ASSERT_EQ(backoffDelayMs(1, 2000, 30000), 2000u, "the first retry is soon");
    TEST_ASSERT_EQ(backoffDelayMs(2, 2000, 30000), 4000u, "doubles");
    TEST_ASSERT_EQ(backoffDelayMs(3, 2000, 30000), 8000u, "...");
    TEST_ASSERT_EQ(backoffDelayMs(4, 2000, 30000), 16000u, "...");
    TEST_ASSERT_EQ(backoffDelayMs(5, 2000, 30000), 30000u, "capped at the maximum (ANN_RETRY)");
    TEST_ASSERT_EQ(backoffDelayMs(1000000, 2000, 30000), 30000u, "and stays there, with no overflow");
    TEST_ASSERT_EQ(backoffDelayMs(1, 5000, 3000), 3000u, "a maximum below the first delay wins");
    TEST_ASSERT_EQ(backoffDelayMs(3, 1, 1), 1u, "tiny values");
}

// ══════════════════════════════════════════════════════════════════════════
// The connection, against a fake environment
// ══════════════════════════════════════════════════════════════════════════

struct FakeEnv : public IUplinkEnv {
    // clock
    uint32_t now = 1000;
    // the socket, as scripted
    std::vector<bool> openScript;             // results of the successive open() calls; the last one repeats
    std::string openWhy = "connection refused";
    uint32_t openCostMs = 0, sendCostMs = 0;
    size_t openCalls = 0, closeCalls = 0, sendCalls = 0;
    int failSendFrom = -1;                    // send() number N and later write nothing
    int partialSendAt = -1;                   // send() number N writes half
    bool isOpen_ = false, peerClosed = false;
    std::string host; int port = 0;
    std::string sent;                         // everything written to the socket
    std::string incoming;                     // what the relay "sent", waiting to be received
    size_t rxChunk = 4096;
    // the detection loop
    Snapshot snapshot;
    std::vector<uint8_t> frameData;
    size_t snapCalls = 0, framesCopied = 0;
    // the JPEG encoder
    bool jpegOk = true;
    std::string jpeg;
    size_t encodeCalls = 0;
    // the rest
    Telemetry tele;
    std::vector<std::pair<Level, std::string> > logs;
    int reachable = 0;

    FakeEnv() {
        snapshot = snap();
        snapshot.valid = true;
        frameData.assign(96 * 96, 0x42);
        jpeg = std::string("\xff\xd8\xff\xe0 jpeg bytes \xff\xd9", 4 + 12 + 2);
        tele.ip = "192.168.4.37"; tele.rssi = -58; tele.heap = 88000;
    }

    uint32_t nowMs() override { return now; }
    bool open(const std::string& h, int p, uint32_t, std::string& why) override {
        size_t i = openCalls++;
        now += openCostMs;
        host = h; port = p;
        bool ok = openScript.empty() ? true : openScript[i < openScript.size() ? i : openScript.size() - 1];
        if (!ok) { why = openWhy; return false; }
        isOpen_ = true; peerClosed = false; incoming.clear();
        return true;
    }
    bool isOpen() override { return isOpen_ && !(peerClosed && incoming.empty()); }
    size_t send(const uint8_t* data, size_t len, uint32_t) override {
        int n = (int)sendCalls++;
        now += sendCostMs;
        if (!isOpen_ || (failSendFrom >= 0 && n >= failSendFrom)) return 0;
        size_t w = (partialSendAt == n) ? len / 2 : len;
        sent.append((const char*)data, w);
        return w;
    }
    size_t receive(uint8_t* buf, size_t cap) override {
        size_t n = incoming.size();
        if (n > cap) n = cap;
        if (n > rxChunk) n = rxChunk;
        memcpy(buf, incoming.data(), n);
        incoming.erase(0, n);
        return n;
    }
    void close() override { closeCalls++; isOpen_ = false; }
    bool takeSnapshot(Snapshot& s, uint8_t* frame, uint32_t haveSeq) override {
        snapCalls++;
        if (!snapshot.valid) return false;
        s = snapshot;
        if (s.seq != haveSeq) { memcpy(frame, frameData.data(), frameData.size()); framesCopied++; }
        return true;
    }
    bool encodeJpeg(const uint8_t*, std::string& out) override {
        encodeCalls++;
        if (!jpegOk) return false;
        out = jpeg;
        return true;
    }
    Telemetry telemetry() override { return tele; }
    void log(Level l, const std::string& m) override { logs.push_back(std::make_pair(l, m)); }
    void relayReachable() override { reachable++; }

    // ── helpers for the tests ──
    bool logged(Level l, const char* part) const {
        for (size_t i = 0; i < logs.size(); i++) if (logs[i].first == l && has(logs[i].second, part)) return true;
        return false;
    }
    size_t countLogged(Level l, const char* part) const {
        size_t n = 0;
        for (size_t i = 0; i < logs.size(); i++) if (logs[i].first == l && has(logs[i].second, part)) n++;
        return n;
    }
    std::string lastLog() const { return logs.empty() ? std::string() : logs.back().second; }
    void relayAccepts() { incoming += "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: espcam-detector/1\r\n\r\n"; }
    void relayRefuses(int status, const std::string& reason, const std::string& jsonError) {
        std::string body = jsonError.empty() ? std::string() : "{\"error\":\"" + jsonError + "\"}";
        incoming += "HTTP/1.1 " + std::to_string(status) + " " + reason + "\r\nContent-Type: application/json\r\nContent-Length: " + std::to_string(body.size()) + "\r\nConnection: close\r\n\r\n" + body;
        peerClosed = true;
    }
};

// One message parsed back out of the bytes the session wrote.
struct Wire {
    int type = 0;
    std::string status;
    std::string jpeg;
};

// The messages after the uplink request.
static std::vector<Wire> messagesIn(const std::string& sent) {
    std::vector<Wire> out;
    size_t pos = sent.find("\r\n\r\n");
    if (pos == std::string::npos) return out;
    pos += 4;
    while (pos + 4 <= sent.size()) {
        size_t len = ((size_t)(uint8_t)sent[pos] << 24) | ((size_t)(uint8_t)sent[pos + 1] << 16) | ((size_t)(uint8_t)sent[pos + 2] << 8) | (size_t)(uint8_t)sent[pos + 3];
        if (pos + 4 + len > sent.size() || len < 3) break;
        Wire w;
        w.type = (uint8_t)sent[pos + 4];
        size_t sl = ((size_t)(uint8_t)sent[pos + 5] << 8) | (size_t)(uint8_t)sent[pos + 6];
        w.status = sent.substr(pos + 7, sl);
        w.jpeg = sent.substr(pos + 7 + sl, len - 3 - sl);
        out.push_back(w);
        pos += 4 + len;
    }
    return out;
}

static UplinkConfig ucfg() {
    UplinkConfig c;
    c.host = "192.168.4.9"; c.port = 8080; c.detectorId = "detector-1"; c.apiKey = "s3cret";
    c.report = cfg();
    c.minFrameGapMs = 100; c.heartbeatMs = 1000; c.retryFirstMs = 2000; c.retryMaxMs = 30000;
    c.connectTimeoutMs = 4000; c.answerTimeoutMs = 5000; c.writeStallMs = 3000;
    return c;
}

// A session that is already streaming (accepted by the relay), the way most tests start: connected, the
// 101 read, and the first streaming pass done (so the first message, if there is a frame, is out).
static void bringUp(UplinkSession& s, FakeEnv& env) {
    s.step(true);          // connects, sends the request
    env.relayAccepts();
    s.step(true);          // reads the 101
    s.step(true);          // the first streaming pass
}

// Message i, or an empty one — so a failing assertion never turns into an out-of-range crash.
static Wire wireAt(const std::vector<Wire>& m, size_t i) { return i < m.size() ? m[i] : Wire(); }

// ── bringing the link up ─────────────────────────────────────────────────

TEST(session_waits_for_wifi_and_then_connects_at_once) {
    FakeEnv env;
    UplinkSession s(ucfg(), env);
    s.step(false);
    s.step(false);
    TEST_ASSERT_EQ(env.openCalls, (size_t)0, "no Wi-Fi: no connection attempt");
    TEST_ASSERT(s.state() == UplinkSession::State::WaitingForWifi, "waiting for Wi-Fi");
    TEST_ASSERT(has(s.describe(), "waiting for Wi-Fi"), "and says so");
    s.step(true);
    TEST_ASSERT_EQ(env.openCalls, (size_t)1, "Wi-Fi is up: connects at once");
    TEST_ASSERT(env.host == "192.168.4.9" && env.port == 8080, "to the configured relay");
    TEST_ASSERT_EQ(env.sent, buildUplinkRequest("192.168.4.9", 8080, "detector-1", "s3cret"), "the first thing sent is the uplink request, exactly");
    TEST_ASSERT(s.state() == UplinkSession::State::AwaitingAnswer, "now waiting for the relay's answer");
}

TEST(session_goes_streaming_when_the_relay_says_101) {
    FakeEnv env;
    UplinkSession s(ucfg(), env);
    bringUp(s, env);
    TEST_ASSERT(s.streaming(), "streaming");
    TEST_ASSERT(env.logged(Level::Info, "uplink to the relay at 192.168.4.9:8080 is up (attempt 1)"), "an INFO line says the link is up, where, and which attempt");
    TEST_ASSERT(env.logged(Level::Info, "as 'detector-1'") && env.logged(Level::Info, "up to 10 pictures/s"), "...as which detector and at what rate");
    TEST_ASSERT_EQ(env.reachable, 1, "the log is told the relay is reachable (so queued entries go out)");
    TEST_ASSERT(has(s.describe(), "relay link up for 0s"), "describe() says so");
}

TEST(session_accepts_an_answer_that_arrives_in_pieces) {
    FakeEnv env;
    env.rxChunk = 3;
    UplinkSession s(ucfg(), env);
    s.step(true);
    env.relayAccepts();
    int guard = 0;
    while (!s.streaming() && guard++ < 100) s.step(true);
    TEST_ASSERT(s.streaming(), "a 101 dribbling in three bytes at a time is still understood");
    env.now += 10;
}

TEST(session_ignores_bytes_after_the_head_and_drains_what_the_relay_sends) {
    FakeEnv env;
    UplinkSession s(ucfg(), env);
    s.step(true);
    env.relayAccepts();
    env.incoming += "unexpected extra bytes";
    s.step(true);
    TEST_ASSERT(s.streaming(), "extra bytes after the head do not matter");
    env.incoming += std::string(5000, 'x');
    env.now += 200;
    s.step(true);
    TEST_ASSERT(env.incoming.empty(), "anything the relay sends while streaming is drained so buffers never fill");
    TEST_ASSERT(s.streaming(), "...and ignored");
}

// ── the first messages ───────────────────────────────────────────────────

TEST(session_sends_a_frame_message_with_readings_and_picture) {
    FakeEnv env;
    UplinkSession s(ucfg(), env);
    bringUp(s, env);
    std::vector<Wire> m = messagesIn(env.sent);
    TEST_ASSERT_EQ(m.size(), (size_t)1, "the first message goes out at once");
    TEST_ASSERT_EQ(wireAt(m, 0).type, 1, "a frame message");
    TEST_ASSERT_EQ(wireAt(m, 0).jpeg, env.jpeg, "carrying the encoded picture, byte for byte");
    TEST_ASSERT(has(wireAt(m, 0).status, "\"ip\":\"192.168.4.37\"") && has(wireAt(m, 0).status, "\"rssi\":-58"), "the board's address and signal come from the environment");
    TEST_ASSERT(has(wireAt(m, 0).status, "\"scene\":{\"state\":\"active\",\"brightness\":120,\"motion\":812,\"darkBelow\":40,\"motionAtLeast\":300,\"holdS\":10}"), "the gate's readings and thresholds");
    TEST_ASSERT(has(wireAt(m, 0).status, "\"gpio\":{\"pin\":13,\"high\":true}"), "the alarm pin level");
    TEST_ASSERT(has(wireAt(m, 0).status, "\"link\":{\"frames\":0,\"jpegFails\":0,\"reconnects\":0,\"heap\":88000}"), "link statistics, with the live heap");
    TEST_ASSERT(env.logged(Level::Info, "first picture sent to the relay (18 bytes of JPEG)"), "the first picture is logged, once the relay actually has it");
    TEST_ASSERT_EQ(s.stats().frames, 1u, "counted");
    TEST_ASSERT_EQ(env.framesCopied, (size_t)1, "the frame was copied out of the snapshot once");
}

TEST(session_paces_frames_and_sends_heartbeats_without_pictures) {
    FakeEnv env;
    UplinkSession s(ucfg(), env);
    bringUp(s, env);
    size_t encodes = env.encodeCalls;

    env.now += 50;  s.step(true);
    TEST_ASSERT_EQ(messagesIn(env.sent).size(), (size_t)1, "inside the minimum gap nothing is sent");

    env.now += 60;  s.step(true);
    TEST_ASSERT_EQ(messagesIn(env.sent).size(), (size_t)1, "the same frame is not sent twice");
    TEST_ASSERT_EQ(env.encodeCalls, encodes, "...nor encoded again");

    env.snapshot.seq = 8; env.snapshot.brightness = 99;
    env.now += 10;  s.step(true);
    std::vector<Wire> m = messagesIn(env.sent);
    TEST_ASSERT_EQ(m.size(), (size_t)2, "a new frame after the gap goes out");
    TEST_ASSERT(has(wireAt(m, 1).status, "\"brightness\":99") && !wireAt(m, 1).jpeg.empty(), "with its own readings and a picture");
    TEST_ASSERT_EQ(env.framesCopied, (size_t)2, "and was copied again");

    env.now += 500;  s.step(true);
    TEST_ASSERT_EQ(messagesIn(env.sent).size(), (size_t)2, "no new frame, heartbeat not due");
    size_t copied = env.framesCopied;
    env.now += 600;  s.step(true);
    m = messagesIn(env.sent);
    TEST_ASSERT_EQ(m.size(), (size_t)3, "no new frame for a second: a heartbeat");
    TEST_ASSERT(wireAt(m, 2).jpeg.empty() && has(wireAt(m, 2).status, "\"brightness\":99"), "readings only, no picture");
    TEST_ASSERT_EQ(env.framesCopied, copied, "a heartbeat does not copy the frame");
    TEST_ASSERT_EQ(s.stats().frames, 2u, "heartbeats are not counted as pictures");
    TEST_ASSERT_EQ(env.countLogged(Level::Info, "first picture"), (size_t)1, "the first-picture line appears once");
}

TEST(session_status_carries_link_statistics) {
    FakeEnv env;
    UplinkSession s(ucfg(), env);
    bringUp(s, env);
    env.snapshot.seq = 8; env.tele.heap = 70000;
    env.now += 200; s.step(true);
    std::vector<Wire> m = messagesIn(env.sent);
    TEST_ASSERT(has(wireAt(m, 1).status, "\"link\":{\"frames\":1,\"jpegFails\":0,\"reconnects\":0,\"heap\":70000}"), "frames sent so far and the heap at that moment");
}

TEST(session_sends_nothing_before_the_first_frame_exists) {
    FakeEnv env;
    env.snapshot.valid = false;
    UplinkSession s(ucfg(), env);
    bringUp(s, env);
    TEST_ASSERT_EQ(messagesIn(env.sent).size(), (size_t)0, "no frame yet: nothing to say");
    TEST_ASSERT(s.streaming(), "but the link stays up");
    env.snapshot.valid = true;
    env.now += 10; s.step(true);
    TEST_ASSERT_EQ(messagesIn(env.sent).size(), (size_t)1, "the first frame goes out as soon as there is one");
}

// ── JPEG trouble ─────────────────────────────────────────────────────────

TEST(session_without_a_jpeg_still_reports_the_numbers_and_says_why_there_is_no_picture) {
    FakeEnv env;
    env.jpegOk = false;
    UplinkSession s(ucfg(), env);
    bringUp(s, env);
    std::vector<Wire> m = messagesIn(env.sent);
    TEST_ASSERT_EQ(m.size(), (size_t)1, "the readings are sent anyway");
    TEST_ASSERT(wireAt(m, 0).jpeg.empty(), "without a picture");
    TEST_ASSERT(env.logged(Level::Warn, "could not encode the 96x96 frame as JPEG") && env.logged(Level::Warn, "low on memory"), "a WARN says the encoder failed and what that means");
    TEST_ASSERT_EQ(s.stats().jpegFails, 1u, "counted");
    TEST_ASSERT_EQ(s.stats().frames, 0u, "no picture was sent");
    TEST_ASSERT(!env.logged(Level::Info, "first picture"), "so no first-picture line");
    TEST_ASSERT(has(wireAt(m, 0).status, "\"jpegFails\":1"), "the board tells the relay about the failure in the very message that has no picture");
    env.snapshot.seq = 9; env.now += 200; s.step(true);
    m = messagesIn(env.sent);
    TEST_ASSERT(has(wireAt(m, 1).status, "\"jpegFails\":2"), "...and keeps counting");
    env.jpegOk = true;
    env.snapshot.seq = 10; env.now += 200; s.step(true);
    m = messagesIn(env.sent);
    TEST_ASSERT(!wireAt(m, 2).jpeg.empty() && env.logged(Level::Info, "first picture sent"), "when the encoder recovers pictures flow and the first one is logged");
}

TEST(session_treats_an_oversized_jpeg_as_a_failure) {
    FakeEnv env;
    env.jpeg = std::string(MAX_JPEG_BYTES + 1, 'x');
    env.jpeg[0] = (char)0xff; env.jpeg[1] = (char)0xd8;
    UplinkSession s(ucfg(), env);
    bringUp(s, env);
    TEST_ASSERT(wireAt(messagesIn(env.sent), 0).jpeg.empty(), "a picture the relay would refuse is not sent");
    TEST_ASSERT_EQ(s.stats().jpegFails, 1u, "it counts as a failure");
    TEST_ASSERT(s.streaming(), "and the link is not harmed");
}

// ── when the relay cannot be reached ─────────────────────────────────────

TEST(session_logs_why_it_could_not_connect_and_retries_with_backoff) {
    FakeEnv env;
    env.openScript.push_back(false);
    env.openWhy = "TCP connect to 192.168.4.9:8080 failed (nothing is listening there, a firewall drops it, or the relay is down)";
    UplinkSession s(ucfg(), env);
    s.step(true);
    TEST_ASSERT(s.state() == UplinkSession::State::Backoff, "in backoff");
    TEST_ASSERT(env.logged(Level::Warn, "could not reach the relay at 192.168.4.9:8080: TCP connect to 192.168.4.9:8080 failed"), "a WARN names the relay and the reason the board found");
    TEST_ASSERT(has(env.lastLog(), "retrying in 2 s"), "and when it will try again");
    TEST_ASSERT(has(s.describe(), "relay link down after 1 attempt: could not reach the relay"), "describe() carries the last failure");

    env.now += 1999; s.step(true);
    TEST_ASSERT_EQ(env.openCalls, (size_t)1, "not retried before the delay is over");
    env.now += 1; s.step(true);
    TEST_ASSERT_EQ(env.openCalls, (size_t)2, "retried after 2 s");
    TEST_ASSERT(has(env.lastLog(), "retrying in 4 s"), "the second wait is 4 s");
    env.now += 4000; s.step(true);
    TEST_ASSERT(has(env.lastLog(), "retrying in 8 s"), "then 8");
    env.now += 8000; s.step(true);
    TEST_ASSERT(has(env.lastLog(), "retrying in 16 s"), "then 16");
    env.now += 16000; s.step(true);
    TEST_ASSERT(has(env.lastLog(), "retrying in 30 s"), "then the cap (ANN_RETRY)");
    env.now += 30000; s.step(true);
    TEST_ASSERT(has(env.lastLog(), "retrying in 30 s") && env.openCalls == 6, "and it stays there");
}

TEST(session_connects_when_the_relay_comes_back) {
    FakeEnv env;
    env.openScript.push_back(false);
    env.openScript.push_back(false);
    env.openScript.push_back(true);
    UplinkSession s(ucfg(), env);
    s.step(true);
    env.now += 2000; s.step(true);
    env.now += 4000; s.step(true);
    TEST_ASSERT(s.state() == UplinkSession::State::AwaitingAnswer, "the third attempt got through");
    env.relayAccepts(); s.step(true);
    TEST_ASSERT(s.streaming(), "streaming");
    TEST_ASSERT(env.logged(Level::Info, "(attempt 3)"), "the log says it took three attempts");
}

TEST(session_blocking_connects_do_not_confuse_the_retry_clock) {
    FakeEnv env;
    env.openScript.push_back(false);
    env.openCostMs = 4000;     // a connect that times out takes its time
    UplinkSession s(ucfg(), env);
    s.step(true);
    uint32_t after = env.now;
    env.now = after + 1999; s.step(true);
    TEST_ASSERT_EQ(env.openCalls, (size_t)1, "the retry delay counts from when the failed attempt ENDED");
    env.now = after + 2000; s.step(true);
    TEST_ASSERT_EQ(env.openCalls, (size_t)2, "and then it retries");
}

TEST(session_reports_a_request_that_could_not_be_sent) {
    FakeEnv env;
    env.failSendFrom = 0;
    UplinkSession s(ucfg(), env);
    s.step(true);
    TEST_ASSERT(s.state() == UplinkSession::State::Backoff && env.closeCalls == 1, "the half-open socket is closed");
    TEST_ASSERT(env.logged(Level::Warn, "connected to the relay at 192.168.4.9:8080 but could not send it the uplink request"), "and the log says exactly that");
}

// ── when the relay refuses or does not answer properly ───────────────────

TEST(session_explains_a_wrong_key) {
    FakeEnv env;
    UplinkSession s(ucfg(), env);
    s.step(true);
    env.relayRefuses(401, "Unauthorized", "wrong key: API_KEY on the board must equal camKey in the relay's config.js");
    s.step(true);
    TEST_ASSERT(s.state() == UplinkSession::State::Backoff && env.closeCalls == 1, "refused: closed, backing off");
    TEST_ASSERT(env.logged(Level::Warn, "refused the uplink (HTTP 401)") && env.logged(Level::Warn, "wrong key") && env.logged(Level::Warn, "camKey in the relay's config.js"), "a WARN with the relay's own reason and the fix");
    TEST_ASSERT(!env.logged(Level::Warn, "s3cret"), "the key itself is never logged");
}

TEST(session_recognises_a_relay_that_predates_the_uplink) {
    FakeEnv env;
    UplinkSession s(ucfg(), env);
    s.step(true);
    env.incoming = "HTTP/1.1 404 Not Found\r\nContent-Type: text/html\r\nContent-Length: 28\r\n\r\n<pre>Cannot GET /detector</pre>";
    env.peerClosed = true;
    s.step(true);
    TEST_ASSERT(env.logged(Level::Warn, "HTTP 404") && env.logged(Level::Warn, "older than this firmware") && env.logged(Level::Warn, "update and restart nodejs/camera-relay"), "an HTML 404 is explained as a too-old relay");
}

TEST(session_recognises_a_relay_that_just_hangs_up) {
    FakeEnv env;
    UplinkSession s(ucfg(), env);
    s.step(true);
    env.peerClosed = true;      // an old relay closes a connection it has no handler for, without a word
    s.step(true);
    TEST_ASSERT(env.logged(Level::Warn, "hung up without answering the uplink request") && env.logged(Level::Warn, "older than this firmware"), "named for what it is");
    TEST_ASSERT(s.state() == UplinkSession::State::Backoff, "and retried later");
}

TEST(session_gives_up_waiting_for_an_answer) {
    FakeEnv env;
    UplinkSession s(ucfg(), env);
    s.step(true);
    env.now += 4999; s.step(true);
    TEST_ASSERT(s.state() == UplinkSession::State::AwaitingAnswer, "still waiting after 4.999 s");
    env.now += 1; s.step(true);
    TEST_ASSERT(s.state() == UplinkSession::State::Backoff && env.closeCalls == 1, "after 5 s the connection is dropped");
    TEST_ASSERT(env.logged(Level::Warn, "did not answer the uplink request within 5 s") && env.logged(Level::Warn, "wrong HTTP_PORT, or a relay older than this firmware"), "and the log says what that usually means");
}

TEST(session_reports_an_answer_that_is_not_http) {
    FakeEnv env;
    UplinkSession s(ucfg(), env);
    s.step(true);
    env.incoming = "SSH-2.0-OpenSSH_9.2p1\r\n\r\n";
    s.step(true);
    TEST_ASSERT(env.logged(Level::Warn, "did not answer like a web server (not HTTP: 'SSH-2.0-OpenSSH_9.2p1") && env.logged(Level::Warn, "is HTTP_PORT really the relay's HTTP port?"), "the board quotes what it got and hints at a wrong port");
}

// ── losing the link ──────────────────────────────────────────────────────

TEST(session_logs_a_closed_connection_and_reconnects) {
    FakeEnv env;
    UplinkSession s(ucfg(), env);
    bringUp(s, env);
    env.now += 5 * 60000 + 7000;
    env.peerClosed = true;
    s.step(true);
    TEST_ASSERT(s.state() == UplinkSession::State::Backoff, "the close is noticed on the next pass");
    TEST_ASSERT(env.logged(Level::Warn, "lost the connection to the relay at 192.168.4.9:8080 after 5m 07s (the relay closed the connection); it had carried 1 picture — reconnecting"), "how long it was up, why it ended and how much it carried");
    TEST_ASSERT_EQ(s.stats().reconnects, 1u, "counted");

    env.now += 1999; s.step(true);
    TEST_ASSERT_EQ(env.openCalls, (size_t)1, "the first retry waits 2 s");
    env.now += 1; s.step(true);
    TEST_ASSERT_EQ(env.openCalls, (size_t)2, "then reconnects");
    env.relayAccepts(); s.step(true);
    TEST_ASSERT(s.streaming(), "streaming again");
    s.step(true);
    std::vector<Wire> m = messagesIn(env.sent.substr(env.sent.rfind("GET /detector")));
    TEST_ASSERT_EQ(m.size(), (size_t)1, "the first message on the new connection goes out at once, even for an old frame");
    TEST_ASSERT(has(wireAt(m, 0).status, "\"reconnects\":1"), "and tells the relay how often the link was lost");
    TEST_ASSERT(env.countLogged(Level::Info, "first picture") == 2, "each connection logs its first picture");
    TEST_ASSERT_EQ(env.reachable, 2, "the log learns the relay is reachable each time");
}

TEST(session_reports_a_write_that_stalls_or_is_cut_short) {
    {
        FakeEnv env;
        UplinkSession s(ucfg(), env);
        bringUp(s, env);
        env.failSendFrom = (int)env.sendCalls;     // the next send writes nothing
        env.snapshot.seq = 9; env.now += 200; s.step(true);
        TEST_ASSERT(s.state() == UplinkSession::State::Backoff && env.closeCalls == 1, "the link is dropped");
        TEST_ASSERT(env.logged(Level::Warn, "lost the connection") && env.logged(Level::Warn, "the relay stopped accepting data"), "a stalled write is named");
    }
    {
        FakeEnv env;
        UplinkSession s(ucfg(), env);
        bringUp(s, env);
        env.partialSendAt = (int)env.sendCalls;
        env.snapshot.seq = 9; env.now += 200; s.step(true);
        TEST_ASSERT(env.logged(Level::Warn, "only partly written"), "a half-written message means the stream is out of step: dropped, and said");
    }
}

TEST(session_second_failure_after_a_loss_waits_longer) {
    FakeEnv env;
    UplinkSession s(ucfg(), env);
    bringUp(s, env);
    env.peerClosed = true; s.step(true);                    // lost
    env.openScript.push_back(false);
    env.now += 2000; s.step(true);                          // retry fails
    TEST_ASSERT(has(env.lastLog(), "retrying in 4 s"), "the loss counted as the first failure, so the next wait is 4 s");
}

// ── Wi-Fi going away ─────────────────────────────────────────────────────

TEST(session_closes_the_link_when_wifi_drops_and_reconnects_at_once_when_it_is_back) {
    FakeEnv env;
    UplinkSession s(ucfg(), env);
    bringUp(s, env);
    env.now += 100;
    s.step(false);
    TEST_ASSERT(s.state() == UplinkSession::State::WaitingForWifi && env.closeCalls == 1, "the connection is closed");
    TEST_ASSERT(env.logged(Level::Warn, "Wi-Fi is down: the relay connection is closed"), "and the log says why");
    TEST_ASSERT_EQ(s.stats().reconnects, 1u, "counted as a loss");
    size_t logsBefore = env.logs.size();
    s.step(false);
    TEST_ASSERT_EQ(env.logs.size(), logsBefore, "said once, not on every pass");
    env.now += 20000;
    s.step(true);
    TEST_ASSERT_EQ(env.openCalls, (size_t)2, "Wi-Fi is back: reconnects immediately, no backoff (the relay did nothing wrong)");
}

TEST(session_wifi_drop_while_connecting_or_backing_off) {
    FakeEnv env;
    UplinkSession s(ucfg(), env);
    s.step(true);                      // AwaitingAnswer
    s.step(false);
    TEST_ASSERT(s.state() == UplinkSession::State::WaitingForWifi && env.closeCalls == 1, "a half-open attempt is closed");
    TEST_ASSERT_EQ(s.stats().reconnects, 0u, "that was never a link, so no loss");
    env.openScript.push_back(false);
    s.step(true);                      // fails -> Backoff
    s.step(false);
    TEST_ASSERT(s.state() == UplinkSession::State::WaitingForWifi, "backoff is dropped too");
    env.openScript.push_back(true);
    s.step(true);
    TEST_ASSERT_EQ(env.openCalls, (size_t)3, "and Wi-Fi returning starts a fresh attempt at once");
}

// ── the millis() wrap ────────────────────────────────────────────────────

TEST(session_works_across_the_millis_wrap) {
    FakeEnv env;
    env.now = 0xFFFFFF00u;                 // 256 ms before millis() wraps to zero
    env.openScript.push_back(false);
    env.openScript.push_back(true);
    UplinkSession s(ucfg(), env);
    s.step(true);
    TEST_ASSERT(s.state() == UplinkSession::State::Backoff, "failed just before the wrap");
    env.now += 1999; s.step(true);
    TEST_ASSERT_EQ(env.openCalls, (size_t)1, "waits 2 s, across the wrap");
    env.now += 1; s.step(true);
    TEST_ASSERT_EQ(env.openCalls, (size_t)2, "and then retries");
    env.relayAccepts(); s.step(true);
    TEST_ASSERT(s.streaming(), "streaming");
    s.step(true);
    TEST_ASSERT_EQ(messagesIn(env.sent).size(), (size_t)1, "the first message is out");
    env.now += 1000;                       // the clock is now past zero
    env.snapshot.seq = 99;
    s.step(true);
    TEST_ASSERT_EQ(messagesIn(env.sent).size(), (size_t)2, "a new frame is sent after the wrap");
    env.now += 1500;
    s.step(true);
    TEST_ASSERT_EQ(messagesIn(env.sent).size(), (size_t)3, "and a heartbeat follows when no new frame comes");
    TEST_ASSERT(s.streaming(), "all the way");
}

// ── describing the link ──────────────────────────────────────────────────

TEST(session_describes_itself_in_every_state) {
    FakeEnv env;
    UplinkSession s(ucfg(), env);
    TEST_ASSERT(has(s.describe(), "waiting for Wi-Fi"), "before Wi-Fi");
    s.step(true);
    TEST_ASSERT(has(s.describe(), "waiting for the relay's answer"), "while opening");
    env.relayAccepts(); s.step(true);
    s.step(true);                                         // the first picture
    env.snapshot.seq = 9; env.now += 3 * 3600000u + 12 * 60000u; s.step(true);   // and one more, hours later
    TEST_ASSERT(has(s.describe(), "relay link up for 3h 12m, 2 pictures sent, 0 JPEG failures, 0 reconnects"), "streaming: how long, how much, how many failures");
    env.peerClosed = true; s.step(true);
    TEST_ASSERT(has(s.describe(), "relay link down after 1 attempt: lost the connection after 3h 12m (the relay closed the connection)"), "after a loss");
    TEST_ASSERT(has(s.lastFailure(), "lost the connection"), "lastFailure() has it too");
}

int main() {
    RUN_TEST(json_strings_are_escaped);
    RUN_TEST(log_url);
    RUN_TEST(gate_names_and_mapping);
    RUN_TEST(status_json_carries_everything_the_dashboard_shows);
    RUN_TEST(status_json_scores);
    RUN_TEST(status_json_other_states);
    RUN_TEST(frame_message_layout_is_what_the_relay_reads);
    RUN_TEST(frame_message_without_a_picture_is_a_heartbeat);
    RUN_TEST(frame_message_refuses_what_the_relay_would_refuse);
    RUN_TEST(uplink_request_is_what_the_relay_expects);
    RUN_TEST(json_error_extraction);
    RUN_TEST(uplink_head_accepted);
    RUN_TEST(uplink_head_incomplete);
    RUN_TEST(uplink_head_refused_reads_the_relays_reason);
    RUN_TEST(uplink_head_refused_without_json);
    RUN_TEST(uplink_head_malformed);
    RUN_TEST(uplink_head_closed_silently);
    RUN_TEST(refusals_are_explained_with_what_to_do);
    RUN_TEST(wifi_status_names);
    RUN_TEST(camera_errors_come_with_the_likely_cure);
    RUN_TEST(durations);
    RUN_TEST(wifi_watch_turns_transitions_into_events);
    RUN_TEST(wifi_watch_connected_at_once);
    RUN_TEST(every_fires_once_per_period);
    RUN_TEST(send_policy_pacing);
    RUN_TEST(send_policy_reset_and_wrap);
    RUN_TEST(backoff_starts_short_doubles_and_caps);
    RUN_TEST(session_waits_for_wifi_and_then_connects_at_once);
    RUN_TEST(session_goes_streaming_when_the_relay_says_101);
    RUN_TEST(session_accepts_an_answer_that_arrives_in_pieces);
    RUN_TEST(session_ignores_bytes_after_the_head_and_drains_what_the_relay_sends);
    RUN_TEST(session_sends_a_frame_message_with_readings_and_picture);
    RUN_TEST(session_paces_frames_and_sends_heartbeats_without_pictures);
    RUN_TEST(session_status_carries_link_statistics);
    RUN_TEST(session_sends_nothing_before_the_first_frame_exists);
    RUN_TEST(session_without_a_jpeg_still_reports_the_numbers_and_says_why_there_is_no_picture);
    RUN_TEST(session_treats_an_oversized_jpeg_as_a_failure);
    RUN_TEST(session_logs_why_it_could_not_connect_and_retries_with_backoff);
    RUN_TEST(session_connects_when_the_relay_comes_back);
    RUN_TEST(session_blocking_connects_do_not_confuse_the_retry_clock);
    RUN_TEST(session_reports_a_request_that_could_not_be_sent);
    RUN_TEST(session_explains_a_wrong_key);
    RUN_TEST(session_recognises_a_relay_that_predates_the_uplink);
    RUN_TEST(session_recognises_a_relay_that_just_hangs_up);
    RUN_TEST(session_gives_up_waiting_for_an_answer);
    RUN_TEST(session_reports_an_answer_that_is_not_http);
    RUN_TEST(session_logs_a_closed_connection_and_reconnects);
    RUN_TEST(session_reports_a_write_that_stalls_or_is_cut_short);
    RUN_TEST(session_second_failure_after_a_loss_waits_longer);
    RUN_TEST(session_closes_the_link_when_wifi_drops_and_reconnects_at_once_when_it_is_back);
    RUN_TEST(session_wifi_drop_while_connecting_or_backing_off);
    RUN_TEST(session_works_across_the_millis_wrap);
    RUN_TEST(session_describes_itself_in_every_state);
    return test::summarize();
}
