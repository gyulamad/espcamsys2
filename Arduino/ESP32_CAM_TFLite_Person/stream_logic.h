// stream_logic.h — the decision-making behind the person detector's live view,
// as plain, hardware-free C++ (no Arduino, no WiFi, no FreeRTOS) so it can be
// unit tested on a desktop with g++ — see tests/cpp/test_person_stream_logic.cpp.
//
// WHY: to install and aim a detector you want to SEE what it sees, from a
// browser. The sketch serves an authenticated MJPEG stream, and tells the
// relay (POST /log, the same endpoint the recorder uses) which IP address it
// got — a detector may join any of several Wi-Fi networks, so its address is
// not known in advance. Nothing is registered anywhere: the relay just
// writes a line to its log file, and you open the address it names.
//
// This file decides WHAT to send and WHEN; ESP32_CAM_TFLite_Person.ino only
// supplies the sockets, the camera frame and the clock.
//
// Must stay valid C++11 (the ESP32 toolchain's dialect) — run_tests.sh checks.

#ifndef PERSON_STREAM_LOGIC_H
#define PERSON_STREAM_LOGIC_H

#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string>

namespace person_stream {

// ── Credentials ───────────────────────────────────────────────────────

// The stream is only ever served when someone has set a real password:
// an empty or still-the-template one would make "authenticated" meaningless.
// (A ':' in the user name would be unparseable in Basic auth.)
inline bool credentialsUsable(const char* user, const char* password) {
    if (!user || !password) return false;
    std::string u(user), p(password);
    if (u.empty() || u.find(':') != std::string::npos) return false;
    if (p.empty() || p == "change-me") return false;
    return true;
}

// ── Basic authentication ──────────────────────────────────────────────

inline std::string base64Encode(const std::string& in) {
    static const char* T = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string out;
    size_t i = 0;
    for (; i + 2 < in.size(); i += 3) {
        uint32_t v = ((uint8_t)in[i] << 16) | ((uint8_t)in[i + 1] << 8) | (uint8_t)in[i + 2];
        out += T[(v >> 18) & 63]; out += T[(v >> 12) & 63]; out += T[(v >> 6) & 63]; out += T[v & 63];
    }
    if (i + 1 == in.size()) {
        uint32_t v = (uint8_t)in[i] << 16;
        out += T[(v >> 18) & 63]; out += T[(v >> 12) & 63]; out += "==";
    } else if (i + 2 == in.size()) {
        uint32_t v = ((uint8_t)in[i] << 16) | ((uint8_t)in[i + 1] << 8);
        out += T[(v >> 18) & 63]; out += T[(v >> 12) & 63]; out += T[(v >> 6) & 63]; out += '=';
    }
    return out;
}

// What a browser sends in its Authorization header for this user/password.
inline std::string expectedAuthHeader(const char* user, const char* password) {
    return "Basic " + base64Encode(std::string(user) + ":" + password);
}

// Compares in time that depends only on the LONGER length, not on where the
// first difference is, so response timing can't be used to guess the password
// a character at a time.
inline bool constantTimeEquals(const std::string& a, const std::string& b) {
    size_t n = a.size() > b.size() ? a.size() : b.size();
    unsigned char diff = (a.size() != b.size()) ? 1 : 0;
    for (size_t i = 0; i < n; i++) {
        unsigned char ca = i < a.size() ? (unsigned char)a[i] : 0;
        unsigned char cb = i < b.size() ? (unsigned char)b[i] : 0;
        diff |= (unsigned char)(ca ^ cb);
    }
    return diff == 0;
}

// ── Parsing one HTTP request ──────────────────────────────────────────

// True once the whole request head (up to the blank line) has arrived.
inline bool requestHeadComplete(const std::string& buf) {
    return buf.find("\r\n\r\n") != std::string::npos || buf.find("\n\n") != std::string::npos;
}

struct Request {
    bool valid;
    std::string method;
    std::string path;           // without the query string
    std::string authorization;  // the Authorization header's value, "" if absent
    Request() : valid(false) {}
};

inline char lowerAscii(char c) { return (c >= 'A' && c <= 'Z') ? (char)(c - 'A' + 'a') : c; }

inline Request parseRequest(const std::string& head) {
    Request r;
    size_t eol = head.find('\n');
    if (eol == std::string::npos) return r;
    std::string line = head.substr(0, eol);
    if (!line.empty() && line[line.size() - 1] == '\r') line.erase(line.size() - 1);

    size_t sp1 = line.find(' ');
    if (sp1 == std::string::npos || sp1 == 0) return r;
    size_t sp2 = line.find(' ', sp1 + 1);
    if (sp2 == std::string::npos) return r;
    r.method = line.substr(0, sp1);
    std::string target = line.substr(sp1 + 1, sp2 - sp1 - 1);
    if (target.empty() || target[0] != '/') return r;
    size_t q = target.find('?');
    r.path = (q == std::string::npos) ? target : target.substr(0, q);

    size_t pos = eol + 1;
    while (pos < head.size()) {
        size_t e = head.find('\n', pos);
        std::string h = head.substr(pos, e == std::string::npos ? std::string::npos : e - pos);
        if (!h.empty() && h[h.size() - 1] == '\r') h.erase(h.size() - 1);
        if (h.empty()) break;
        size_t colon = h.find(':');
        if (colon != std::string::npos) {
            std::string name = h.substr(0, colon);
            for (size_t i = 0; i < name.size(); i++) name[i] = lowerAscii(name[i]);
            if (name == "authorization") {
                size_t v = colon + 1;
                while (v < h.size() && (h[v] == ' ' || h[v] == '\t')) v++;
                r.authorization = h.substr(v);
            }
        }
        if (e == std::string::npos) break;
        pos = e + 1;
    }
    r.valid = true;
    return r;
}

enum class Route { BadRequest, Unauthorized, MethodNotAllowed, NotFound, Index, Stream };

// What to do with a request. Authentication comes BEFORE anything else is
// revealed — an unauthenticated client can't even tell which paths exist.
inline Route routeFor(const Request& r, const std::string& expectedAuth) {
    if (!r.valid) return Route::BadRequest;
    if (!constantTimeEquals(r.authorization, expectedAuth)) return Route::Unauthorized;
    if (r.method != "GET") return Route::MethodNotAllowed;
    if (r.path == "/" || r.path == "/index.html") return Route::Index;
    if (r.path == "/stream") return Route::Stream;
    return Route::NotFound;
}

// ── Responses ─────────────────────────────────────────────────────────

inline std::string simpleResponse(int code, const char* reason, const char* body, const char* extraHeaders = "") {
    std::string b(body);
    char head[256];
    snprintf(head, sizeof(head),
             "HTTP/1.1 %d %s\r\nContent-Type: text/plain\r\nContent-Length: %u\r\nCache-Control: no-store\r\nConnection: close\r\n%s\r\n",
             code, reason, (unsigned)b.size(), extraHeaders);
    return std::string(head) + b;
}

inline std::string unauthorizedResponse() {
    return simpleResponse(401, "Unauthorized", "authentication required",
                          "WWW-Authenticate: Basic realm=\"Human detector\"\r\n");
}
inline std::string badRequestResponse()       { return simpleResponse(400, "Bad Request", "bad request"); }
inline std::string notFoundResponse()         { return simpleResponse(404, "Not Found", "not found"); }
inline std::string methodNotAllowedResponse() { return simpleResponse(405, "Method Not Allowed", "GET only", "Allow: GET\r\n"); }

// A tiny page that shows the stream enlarged. The detector's model sees a
// 96x96 grayscale picture — which is exactly what is streamed, so you are
// looking at what the detector "sees". Pixelated scaling keeps it honest.
inline std::string indexPage() {
    const char* html =
        "<!doctype html><meta charset=utf-8>"
        "<meta name=viewport content=\"width=device-width,initial-scale=1\">"
        "<title>Human detector</title>"
        "<body style=\"margin:0;background:#111;color:#ccc;font:14px sans-serif;text-align:center\">"
        "<p>What the human detector sees (96&times;96, grayscale)</p>"
        "<img src=/stream alt=\"live view\" "
        "style=\"width:min(92vmin,576px);image-rendering:pixelated;background:#000\">";
    std::string b(html);
    char head[200];
    snprintf(head, sizeof(head),
             "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: %u\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
             (unsigned)b.size());
    return std::string(head) + b;
}

inline const char* streamBoundary() { return "frame"; }

// Sent once when a stream starts.
inline std::string streamResponseHead() {
    return std::string("HTTP/1.1 200 OK\r\nContent-Type: multipart/x-mixed-replace;boundary=") + streamBoundary() +
           "\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n";
}

// Sent before each JPEG; the JPEG's bytes and a "\r\n" follow.
inline std::string streamPartHead(size_t jpegLen) {
    char buf[128];
    snprintf(buf, sizeof(buf), "--%s\r\nContent-Type: image/jpeg\r\nContent-Length: %u\r\n\r\n",
             streamBoundary(), (unsigned)jpegLen);
    return buf;
}

// ── Telling the relay where the stream is ─────────────────────────────

inline std::string buildLogUrl(const std::string& host, int httpPort) {
    return "http://" + host + ":" + std::to_string(httpPort) + "/log";
}

// "http://192.168.4.37/" (port 80 is left out)
inline std::string buildStreamUrl(const std::string& ip, int port) {
    std::string u = "http://" + ip;
    if (port != 80) u += ":" + std::to_string(port);
    return u + "/";
}

// Appends `s` as a quoted JSON string (bytes >= 0x80 pass through so UTF-8 stays UTF-8).
inline void appendJsonString(std::string& out, const std::string& s) {
    out += '"';
    for (size_t i = 0; i < s.size(); i++) {
        unsigned char c = (unsigned char)s[i];
        switch (c) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (c < 0x20) { char u[8]; snprintf(u, sizeof(u), "\\u%04x", c); out += u; }
                else out += (char)c;
        }
    }
    out += '"';
}

enum class AnnounceReason { None, NewAddress, Heartbeat };

// The log line. It names the address first so `grep "human detector stream"`
// on the relay's log file, then reading the newest line, is all it takes.
// The password is never part of it.
inline std::string buildAnnounceMessage(AnnounceReason reason, const std::string& url, const std::string& user,
                                        const std::string& ssid, const std::string& ip, int rssi, uint32_t uptimeSeconds) {
    // "WiFi '<ssid>', IP <ip>" is spelled exactly as in the recorder's log lines,
    // so one grep lists both kinds of camera.
    char tail[200];
    snprintf(tail, sizeof(tail), " (WiFi '%s', IP %s, %d dBm, up %us)", ssid.c_str(), ip.c_str(), rssi, (unsigned)uptimeSeconds);
    std::string m = (reason == AnnounceReason::Heartbeat) ? "human detector stream still at " : "human detector stream available at ";
    m += url + " — user '" + user + "'" + tail;
    return m;
}

// The body for POST /log: the same shape the recorder sends (see the relay's
// lib/logentry.js) — one INFO entry.
inline std::string buildAnnounceJson(const std::string& detectorId, const std::string& fw, const std::string& message,
                                     uint32_t uptimeMs, int32_t freeHeap, int32_t rssi, uint32_t seq) {
    std::string out = "{\"camera\":";
    appendJsonString(out, detectorId);
    out += ",\"fw\":";
    appendJsonString(out, fw);
    char num[96];
    snprintf(num, sizeof(num), ",\"attempt\":0,\"dropped\":0,\"entries\":[{\"seq\":%u,\"level\":\"INFO\",", (unsigned)seq);
    out += num;
    snprintf(num, sizeof(num), "\"ageMs\":0,\"uptimeMs\":%u,\"heap\":%d,\"rssi\":%d,\"message\":",
             (unsigned)uptimeMs, (int)freeHeap, (int)rssi);
    out += num;
    appendJsonString(out, message);
    out += "}]}";
    return out;
}

// When to tell the relay. An announcement is due when
//   - this Wi-Fi network + address pair hasn't been announced yet (first connect
//     after boot, another network, another DHCP lease — an access point change
//     that happens to hand out the same address still counts), or
//   - Wi-Fi was lost and came back (invalidate()), so the log shows every
//     reconnect the way the recorder's does, or
//   - the last successful one is older than the heartbeat period (so the log
//     keeps a recent line even if the relay was restarted or its log rotated).
// A failed delivery is retried after retryMs — not every loop.
// No attempt while Wi-Fi is down (that is not a delivery failure).
class AnnouncePolicy {
public:
    AnnouncePolicy(uint32_t heartbeatMs, uint32_t retryMs)
        : heartbeatMs_(heartbeatMs), retryMs_(retryMs), haveOk_(false), okAt_(0), haveFail_(false), failAt_(0) {}

    AnnounceReason due(uint32_t now, bool wifiUp, const std::string& ip, const std::string& ssid) const {
        if (!wifiUp || ip.empty()) return AnnounceReason::None;
        if (haveFail_ && (uint32_t)(now - failAt_) < retryMs_) return AnnounceReason::None;
        if (!haveOk_ || ip != okIp_ || ssid != okSsid_) return AnnounceReason::NewAddress;
        if ((uint32_t)(now - okAt_) >= heartbeatMs_) return AnnounceReason::Heartbeat;
        return AnnounceReason::None;
    }

    void onResult(uint32_t now, bool ok, const std::string& ip, const std::string& ssid) {
        if (ok) { haveOk_ = true; okAt_ = now; okIp_ = ip; okSsid_ = ssid; haveFail_ = false; }
        else    { haveFail_ = true; failAt_ = now; }
    }

    // Wi-Fi dropped and came back: whatever was announced before is stale.
    // (A pending retry wait is kept — a relay that just refused us is not asked again at once.)
    void invalidate() { haveOk_ = false; }

private:
    uint32_t heartbeatMs_, retryMs_;
    bool haveOk_;
    uint32_t okAt_;
    std::string okIp_, okSsid_;
    bool haveFail_;
    uint32_t failAt_;
};

}  // namespace person_stream

#endif  // PERSON_STREAM_LOGIC_H
