// remote_log.h — the brains of the camera's remote logging, as plain,
// hardware-free C++ (no Arduino, no FreeRTOS, no WiFi) so it can be unit
// tested on a desktop with g++ — see tests/cpp/test_remote_log.cpp.
//
// WHY: assembled cameras have no serial monitor attached, so when something
// goes wrong there is nobody to read what the board printed. Instead each
// message is also sent to the relay's POST /log endpoint, which appends it to
// a log file on the Pi. This file decides WHAT to send and WHEN; the sketch
// (ESP32_CAM_Recorder.ino) only supplies the clock, the network call and the
// serial port.
//
// What it does, in the order a message travels:
//   1. REPEAT SUPPRESSION: the same message repeating inside a time window
//      (e.g. "Push connect failed" every half second) is shown once, then
//      summarised as "(last message repeated N more times)".
//   2. TRACE: every entry carries its call site (file:line function()); a
//      WARN or ERROR also carries the last few events leading up to it —
//      the closest thing to a call stack an embedded board without a
//      debugger can offer, and usually exactly what is needed to see how
//      it got there.
//   3. A BOUNDED IN-MEMORY QUEUE (nothing is lost just because the network is
//      slow). If it fills up, the least important entries go first — never an
//      ERROR while a lesser entry can be dropped instead — and the number lost
//      is reported to the relay.
//   4. DELIVERY: batches are sent when something urgent (WARN/ERROR) is waiting
//      or after a short flush interval. If sending fails, the entries stay in
//      memory and are retried after a retry period (5 minutes by default), at
//      most N times (3 by default); after that the board gives up on remote
//      logging — serial only — until the relay is reachable again.
//
// NOT thread-safe by itself: the sketch calls it from the main loop (to log)
// and from a background task (to send), under one mutex.

#ifndef REMOTE_LOG_H
#define REMOTE_LOG_H

#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <string>

namespace esp32cam_logic {

// ── Sizes (RAM is tight: the whole queue is a fixed block, no heap churn) ──
const size_t LOG_MSG_MAX          = 160;  // bytes per message, including the terminator
const size_t LOG_TRACE_MAX        = 320;  // bytes per trace
const size_t LOG_QUEUE_CAPACITY   = 16;   // entries waiting for delivery
const size_t LOG_BATCH_MAX        = 8;    // entries per HTTP request (keeps the body to a few KB)
const size_t LOG_BREADCRUMBS      = 6;    // recent events remembered for traces
const size_t LOG_BREADCRUMB_TEXT  = 56;   // bytes of each remembered event
const size_t LOG_SITE_MAX         = 96;   // bytes of "file:line function()"

enum class LogLevel : uint8_t { Debug = 0, Info = 1, Warn = 2, Error = 3 };

inline const char* logLevelName(LogLevel l) {
    switch (l) {
        case LogLevel::Debug: return "DEBUG";
        case LogLevel::Info:  return "INFO";
        case LogLevel::Warn:  return "WARN";
        case LogLevel::Error: return "ERROR";
    }
    return "INFO";
}

// config.h gives the minimum level as a plain number (0=DEBUG 1=INFO 2=WARN
// 3=ERROR); anything out of range is clamped rather than trusted.
inline LogLevel logLevelFromInt(int v) {
    if (v <= 0) return LogLevel::Debug;
    if (v == 1) return LogLevel::Info;
    if (v == 2) return LogLevel::Warn;
    return LogLevel::Error;
}

// ── Text helpers ──────────────────────────────────────────────────────

// Copies `src` into `dst` (capacity `dstSize`), and if it doesn't fit ends it
// with "..." — without ever cutting a multi-byte UTF-8 character in half (the
// sketch's messages contain characters like "—"; half of one would be invalid
// text in the log). Returns the resulting length.
inline size_t copyTruncatedUtf8(char* dst, size_t dstSize, const char* src) {
    if (dstSize == 0) return 0;
    size_t n = strlen(src);
    if (n < dstSize) { memcpy(dst, src, n + 1); return n; }
    if (dstSize < 5) { dst[0] = '\0'; return 0; } // no room even for one character and "..."
    size_t keep = dstSize - 1 - 3;
    // src[keep] is the first byte NOT copied; if it is a continuation byte
    // (10xxxxxx) the cut would fall inside a character, so back up to its start.
    while (keep > 0 && (static_cast<unsigned char>(src[keep]) & 0xC0) == 0x80) keep--;
    memcpy(dst, src, keep);
    memcpy(dst + keep, "...", 3);
    dst[keep + 3] = '\0';
    return keep + 3;
}

// The file name without its directory: __FILE__ is a long absolute path in
// Arduino builds, which would eat the whole trace.
inline const char* pathBasename(const char* path) {
    const char* base = path;
    for (const char* p = path; *p; ++p) {
        if (*p == '/' || *p == '\\') base = p + 1;
    }
    return base;
}

// "ESP32_CAM_Recorder.ino:405 loop()"
inline void formatCallSite(char* dst, size_t dstSize, const char* file, int line, const char* func) {
    char tmp[LOG_SITE_MAX * 2];
    snprintf(tmp, sizeof(tmp), "%s:%d %s()", pathBasename(file), line, func);
    copyTruncatedUtf8(dst, dstSize, tmp);
}

// Appends a printf-formatted piece to dst, but only if it fits ENTIRELY —
// a trace line is either there or not, never cut off halfway.
inline bool appendWhole(char* dst, size_t cap, size_t& len, const char* fmt, ...) {
    char tmp[160];
    va_list ap;
    va_start(ap, fmt);
    int n = vsnprintf(tmp, sizeof(tmp), fmt, ap);
    va_end(ap);
    if (n < 0 || static_cast<size_t>(n) >= sizeof(tmp)) return false;
    if (len + static_cast<size_t>(n) + 1 > cap) return false;
    memcpy(dst + len, tmp, static_cast<size_t>(n) + 1);
    len += static_cast<size_t>(n);
    return true;
}

// The ESP-IDF reset reasons by number (esp_reset_reason_t) — the numbers are stable across versions.
inline const char* resetReasonName(int reason) {
    switch (reason) {
        case 1:  return "power-on";
        case 2:  return "external reset pin";
        case 3:  return "software restart";
        case 4:  return "PANIC (crash / exception)";
        case 5:  return "interrupt watchdog";
        case 6:  return "task watchdog (a task hung)";
        case 7:  return "other watchdog";
        case 8:  return "deep sleep wake";
        case 9:  return "BROWNOUT (supply voltage dipped — check the power supply)";
        case 10: return "SDIO reset";
        default: return "unknown";
    }
}

// A restart that means something went wrong (as opposed to power being
// switched on, or a deliberate restart). Logged as an ERROR so it stands out.
inline bool isAbnormalReset(int reason) {
    return reason == 4 || reason == 5 || reason == 6 || reason == 7 || reason == 9;
}

// ── One log entry ─────────────────────────────────────────────────────

struct LogEntry {
    uint32_t seq;          // 1, 2, 3... — identifies an entry across the delivery attempt
    LogLevel level;
    uint32_t uptimeMs;     // millis() when it happened (the board has no real clock)
    int32_t  freeHeap;     // bytes of free heap at that moment — a falling number means a leak
    int32_t  rssi;         // WiFi signal strength in dBm (0 if not connected)
    char     message[LOG_MSG_MAX];
    char     trace[LOG_TRACE_MAX];
};

// ── Recent events, for traces ─────────────────────────────────────────

class BreadcrumbRing {
public:
    BreadcrumbRing() : count_(0), head_(0) {}

    void add(uint32_t atMs, LogLevel level, const char* text) {
        Crumb& c = items_[head_];
        c.atMs = atMs;
        c.level = level;
        // One line only: a message with a line break (or tab) must not break the
        // trace layout — keep its first line, and turn other control characters into spaces.
        char oneLine[LOG_MSG_MAX];
        size_t n = 0;
        for (const char* p = text; *p && *p != '\n' && *p != '\r' && n < sizeof(oneLine) - 1; ++p) {
            oneLine[n++] = (static_cast<unsigned char>(*p) < 0x20) ? ' ' : *p;
        }
        oneLine[n] = '\0';
        copyTruncatedUtf8(c.text, sizeof(c.text), oneLine);
        head_ = (head_ + 1) % LOG_BREADCRUMBS;
        if (count_ < LOG_BREADCRUMBS) count_++;
    }

    size_t size() const { return count_; }

    // Appends the remembered events, oldest first, as "  -12.3s INFO text" lines.
    void appendTo(char* dst, size_t cap, size_t& len, uint32_t now) const {
        if (count_ == 0) return;
        if (!appendWhole(dst, cap, len, "\nrecent events (oldest first):")) return;
        size_t start = (head_ + LOG_BREADCRUMBS - count_) % LOG_BREADCRUMBS;
        for (size_t i = 0; i < count_; i++) {
            const Crumb& c = items_[(start + i) % LOG_BREADCRUMBS];
            uint32_t ageMs = static_cast<uint32_t>(now - c.atMs);
            if (!appendWhole(dst, cap, len, "\n  -%u.%us %s %s",
                             static_cast<unsigned>(ageMs / 1000), static_cast<unsigned>((ageMs % 1000) / 100),
                             logLevelName(c.level), c.text)) return;
        }
    }

private:
    struct Crumb { uint32_t atMs; LogLevel level; char text[LOG_BREADCRUMB_TEXT]; };
    Crumb items_[LOG_BREADCRUMBS];
    size_t count_;
    size_t head_;
};

// ── The in-memory queue ───────────────────────────────────────────────

class LogQueue {
public:
    LogQueue() : count_(0) {}

    size_t size() const { return count_; }
    bool empty() const { return count_ == 0; }
    const LogEntry& at(size_t i) const { return items_[i]; }           // 0 = oldest
    const LogEntry* data() const { return items_; }                    // contiguous, oldest first

    // Adds an entry. When full, the OLDEST entry below ERROR is dropped to make
    // room (an ERROR is only ever dropped to make room for another ERROR, and
    // then it is the oldest one that goes). Returns how many were dropped (0 or 1).
    size_t push(const LogEntry& e) {
        size_t dropped = 0;
        if (count_ == LOG_QUEUE_CAPACITY) {
            size_t victim = 0;
            for (size_t i = 0; i < count_; i++) {
                if (items_[i].level != LogLevel::Error) { victim = i; break; }
            }
            removeAt(victim);
            dropped = 1;
        }
        items_[count_++] = e;
        return dropped;
    }

    // Removes every entry up to and including `seq` — what a successful
    // delivery of a batch ending at `seq` means. (Entries dropped meanwhile
    // are simply not there to remove.)
    void removeThroughSeq(uint32_t seq) {
        size_t k = 0;
        while (k < count_ && static_cast<int32_t>(items_[k].seq - seq) <= 0) k++;
        if (k == 0) return;
        memmove(&items_[0], &items_[k], (count_ - k) * sizeof(LogEntry));
        count_ -= k;
    }

    // Empties the queue; returns how many entries were discarded.
    size_t clear() { size_t n = count_; count_ = 0; return n; }

    bool hasAtLeast(LogLevel level) const {
        for (size_t i = 0; i < count_; i++) {
            if (static_cast<uint8_t>(items_[i].level) >= static_cast<uint8_t>(level)) return true;
        }
        return false;
    }

private:
    void removeAt(size_t idx) {
        memmove(&items_[idx], &items_[idx + 1], (count_ - idx - 1) * sizeof(LogEntry));
        count_--;
    }
    LogEntry items_[LOG_QUEUE_CAPACITY];
    size_t count_;
};

// ── Delivery state: when to send, when to retry, when to give up ──────

class LogUplink {
public:
    enum State { Healthy, Backoff, GaveUp };

    LogUplink(uint32_t flushIntervalMs, uint32_t retryPeriodMs, uint8_t maxRetries)
        : flushMs_(flushIntervalMs), retryMs_(retryPeriodMs), maxRetries_(maxRetries),
          state_(Healthy), failed_(0), nextAttemptAt_(0) {}

    State state() const { return state_; }
    uint8_t failedAttempts() const { return failed_; }
    // False once the board has given up: new entries aren't queued (serial only).
    bool accepting() const { return state_ != GaveUp; }

    // May a delivery attempt be made right now?
    //   Healthy: yes if something urgent is waiting, the queue is getting full,
    //            or the oldest entry has waited a full flush interval.
    //   Backoff: only once the retry period since the last failure has passed —
    //            urgent entries do NOT shorten it (that's the point of a period).
    //   GaveUp:  never.
    // No attempt is made while WiFi is down; that is not a delivery failure.
    bool due(uint32_t now, size_t pending, bool urgent, uint32_t oldestAgeMs, bool nearlyFull, bool wifiUp) const {
        if (!wifiUp || pending == 0 || state_ == GaveUp) return false;
        if (state_ == Backoff) return static_cast<int32_t>(now - nextAttemptAt_) >= 0;
        return urgent || nearlyFull || oldestAgeMs >= flushMs_;
    }

    void onSuccess() { state_ = Healthy; failed_ = 0; }

    // A delivery attempt failed. The first attempt plus `maxRetries` retries
    // are allowed in total; the failure of the last one means giving up.
    // Returns true in exactly that case.
    bool onFailure(uint32_t now) {
        failed_++;
        if (failed_ > maxRetries_) { state_ = GaveUp; return true; }
        state_ = Backoff;
        nextAttemptAt_ = now + retryMs_;
        return false;
    }

    // The relay is known to be reachable again (the camera's push connection
    // came back): start afresh — but only if we had given up. A board that is
    // merely backing off keeps its retry schedule, so a flapping connection
    // can't turn into a retry storm.
    bool rearm() {
        if (state_ != GaveUp) return false;
        state_ = Healthy;
        failed_ = 0;
        return true;
    }

private:
    uint32_t flushMs_, retryMs_;
    uint8_t maxRetries_;
    State state_;
    uint8_t failed_;
    uint32_t nextAttemptAt_;
};

// ── JSON for the HTTP body ────────────────────────────────────────────

// Appends `s` as a quoted JSON string. Bytes >= 0x80 pass through untouched so
// UTF-8 text stays UTF-8.
inline void appendJsonString(std::string& out, const char* s) {
    out += '"';
    for (const unsigned char* p = reinterpret_cast<const unsigned char*>(s); *p; ++p) {
        switch (*p) {
            case '"':  out += "\\\""; break;
            case '\\': out += "\\\\"; break;
            case '\n': out += "\\n";  break;
            case '\r': out += "\\r";  break;
            case '\t': out += "\\t";  break;
            default:
                if (*p < 0x20) {
                    char u[8];
                    snprintf(u, sizeof(u), "\\u%04x", *p);
                    out += u;
                } else {
                    out += static_cast<char>(*p);
                }
        }
    }
    out += '"';
}

// The request body for POST /log. Each entry carries how long AGO it happened
// (the board has no clock): the relay files it under the time it really
// happened, even if it sat in memory for minutes while the relay was
// unreachable. `attempt` counts failed deliveries so far (0 = first try) and
// `dropped` is how many entries were lost before this batch.
inline void appendBatchJson(std::string& out, const LogEntry* entries, size_t count, uint32_t now,
                            const char* cameraId, const char* fw, uint32_t attempt, uint32_t dropped) {
    char num[48];
    out += "{\"camera\":";  appendJsonString(out, cameraId);
    out += ",\"fw\":";      appendJsonString(out, fw);
    snprintf(num, sizeof(num), ",\"attempt\":%u,\"dropped\":%u,\"entries\":[", static_cast<unsigned>(attempt), static_cast<unsigned>(dropped));
    out += num;
    for (size_t i = 0; i < count; i++) {
        const LogEntry& e = entries[i];
        if (i) out += ',';
        snprintf(num, sizeof(num), "{\"seq\":%u,\"level\":\"%s\",", static_cast<unsigned>(e.seq), logLevelName(e.level));
        out += num;
        snprintf(num, sizeof(num), "\"ageMs\":%u,\"uptimeMs\":%u,", static_cast<unsigned>(static_cast<uint32_t>(now - e.uptimeMs)), static_cast<unsigned>(e.uptimeMs));
        out += num;
        snprintf(num, sizeof(num), "\"heap\":%d,\"rssi\":%d,\"message\":", static_cast<int>(e.freeHeap), static_cast<int>(e.rssi));
        out += num;
        appendJsonString(out, e.message);
        out += ",\"trace\":";
        appendJsonString(out, e.trace);
        out += '}';
    }
    out += "]}";
}

// ── Putting it together ───────────────────────────────────────────────

typedef void (*LogEchoFn)(void* user, LogLevel level, const char* line);

struct RemoteLogConfig {
    bool     remoteEnabled;     // false: nothing is ever queued or sent (serial only)
    LogLevel remoteMinLevel;    // entries below this stay on the serial port
    bool     echoAlways;        // true: everything is also printed to serial; false: only what isn't sent remotely
    uint32_t flushIntervalMs;   // how long routine entries wait so they go out together
    uint32_t retryPeriodMs;     // wait after a failed delivery before retrying
    uint8_t  maxRetries;        // retries after the first failed attempt, before giving up
    uint32_t repeatWindowMs;    // an identical message inside this window counts as a repeat
};

class RemoteLog {
public:
    RemoteLog(const RemoteLogConfig& cfg, LogEchoFn echo, void* echoUser)
        : cfg_(cfg), uplink_(cfg.flushIntervalMs, cfg.retryPeriodMs, cfg.maxRetries),
          echo_(echo), echoUser_(echoUser), nextSeq_(1), dropped_(0), droppedInFlight_(0),
          haveLast_(false), lastLevel_(LogLevel::Info), lastAt_(0), suppressed_(0) {
        lastMsg_[0] = '\0';
        lastSite_[0] = '\0';
    }

    // Records one message. `site` is "file:line function()".
    void log(LogLevel level, uint32_t now, const char* site, const char* msg, int32_t freeHeap, int32_t rssi) {
        if (haveLast_ && level == lastLevel_ && strcmp(msg, lastMsg_) == 0 &&
            static_cast<uint32_t>(now - lastAt_) < cfg_.repeatWindowMs) {
            suppressed_++; // the same thing again, soon after: counted, not repeated
            return;
        }
        flushRepeatSummary(now, freeHeap, rssi);
        record(level, now, site, msg, freeHeap, rssi);
        haveLast_ = true;
        lastLevel_ = level;
        lastAt_ = now;
        suppressed_ = 0;
        copyTruncatedUtf8(lastMsg_, sizeof(lastMsg_), msg);
        copyTruncatedUtf8(lastSite_, sizeof(lastSite_), site);
    }

    // Call now and then: writes out the "repeated N more times" note once the
    // repetition has stopped (otherwise it would wait for the next message).
    void tick(uint32_t now, int32_t freeHeap, int32_t rssi) {
        if (suppressed_ > 0 && static_cast<uint32_t>(now - lastAt_) >= cfg_.repeatWindowMs) {
            flushRepeatSummary(now, freeHeap, rssi);
            lastAt_ = now; // anything identical from here on is suppressed for another window
        }
    }

    // If a delivery should be attempted now, fills `body` (the JSON for
    // POST /log) and `lastSeq` (to hand back to onSendResult) and returns true.
    bool prepareBatch(uint32_t now, bool wifiUp, const char* cameraId, const char* fw,
                      std::string& body, uint32_t& lastSeq) {
        size_t n = queue_.size() < LOG_BATCH_MAX ? queue_.size() : LOG_BATCH_MAX;
        if (n == 0) return false;
        uint32_t oldestAge = static_cast<uint32_t>(now - queue_.at(0).uptimeMs);
        bool urgent = queue_.hasAtLeast(LogLevel::Warn);
        bool nearlyFull = queue_.size() >= LOG_QUEUE_CAPACITY / 2;
        if (!uplink_.due(now, queue_.size(), urgent, oldestAge, nearlyFull, wifiUp)) return false;
        body.clear();
        appendBatchJson(body, queue_.data(), n, now, cameraId, fw, uplink_.failedAttempts(), dropped_);
        lastSeq = queue_.at(n - 1).seq;
        droppedInFlight_ = dropped_;
        return true;
    }

    // The outcome of the delivery prepareBatch() asked for.
    void onSendResult(uint32_t now, bool ok, uint32_t lastSeq) {
        if (ok) {
            uplink_.onSuccess();
            queue_.removeThroughSeq(lastSeq);
            dropped_ -= (droppedInFlight_ <= dropped_) ? droppedInFlight_ : dropped_; // those were reported now
            droppedInFlight_ = 0;
        } else if (uplink_.onFailure(now)) {
            dropped_ += static_cast<uint32_t>(queue_.clear()); // gave up: serial only from here on
            droppedInFlight_ = 0;
        }
    }

    // The relay is reachable again (see LogUplink::rearm).
    bool onRelayReachable() { return uplink_.rearm(); }

    // For the sketch and the tests.
    size_t   pending() const { return queue_.size(); }
    uint32_t dropped() const { return dropped_; }
    const LogQueue& queue() const { return queue_; }
    LogUplink::State uplinkState() const { return uplink_.state(); }
    uint8_t  failedAttempts() const { return uplink_.failedAttempts(); }

private:
    // Is this level going to the relay right now?
    bool sendsRemotely(LogLevel level) const {
        return cfg_.remoteEnabled && static_cast<uint8_t>(level) >= static_cast<uint8_t>(cfg_.remoteMinLevel);
    }

    void flushRepeatSummary(uint32_t now, int32_t freeHeap, int32_t rssi) {
        if (suppressed_ == 0) return;
        char msg[LOG_MSG_MAX];
        snprintf(msg, sizeof(msg), "(last message repeated %u more time%s)", static_cast<unsigned>(suppressed_), suppressed_ == 1 ? "" : "s");
        suppressed_ = 0;
        record(lastLevel_, now, lastSite_, msg, freeHeap, rssi);
    }

    void record(LogLevel level, uint32_t now, const char* site, const char* msg, int32_t freeHeap, int32_t rssi) {
        bool toRelay = sendsRemotely(level);
        bool toQueue = toRelay && uplink_.accepting();

        // 1. serial: always, or — if configured quieter — only what isn't going to the relay
        if (echo_ && (cfg_.echoAlways || !toQueue)) {
            char line[LOG_MSG_MAX + LOG_SITE_MAX + 32];
            snprintf(line, sizeof(line), "[%u.%us %s] %s  (%s)", static_cast<unsigned>(now / 1000), static_cast<unsigned>((now % 1000) / 100),
                     logLevelName(level), msg, site);
            echo_(echoUser_, level, line);
        }

        // 2. the entry, with its trace: where it came from, and — for a WARN or
        //    ERROR — what happened just before
        if (toQueue || toRelay) {
            LogEntry e;
            e.seq = nextSeq_++;
            e.level = level;
            e.uptimeMs = now;
            e.freeHeap = freeHeap;
            e.rssi = rssi;
            copyTruncatedUtf8(e.message, sizeof(e.message), msg);
            size_t tlen = 0;
            e.trace[0] = '\0';
            appendWhole(e.trace, sizeof(e.trace), tlen, "at %s", site);
            if (static_cast<uint8_t>(level) >= static_cast<uint8_t>(LogLevel::Warn)) crumbs_.appendTo(e.trace, sizeof(e.trace), tlen, now);

            if (toQueue) dropped_ += static_cast<uint32_t>(queue_.push(e));
            else dropped_++; // gave up on remote logging: this one is serial-only, and counts as not delivered
        }

        // 3. remember it as context for later traces (routine DEBUG chatter would just push the useful events out)
        if (static_cast<uint8_t>(level) >= static_cast<uint8_t>(LogLevel::Info)) crumbs_.add(now, level, msg);
    }

    RemoteLogConfig cfg_;
    LogQueue queue_;
    LogUplink uplink_;
    BreadcrumbRing crumbs_;
    LogEchoFn echo_;
    void* echoUser_;
    uint32_t nextSeq_;
    uint32_t dropped_;
    uint32_t droppedInFlight_;

    bool haveLast_;
    LogLevel lastLevel_;
    char lastMsg_[LOG_MSG_MAX];
    char lastSite_[LOG_SITE_MAX];
    uint32_t lastAt_;
    uint32_t suppressed_;
};

}  // namespace esp32cam_logic

#endif  // REMOTE_LOG_H
