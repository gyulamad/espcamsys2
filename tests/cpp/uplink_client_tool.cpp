// uplink_client_tool.cpp — the person detector's REAL uplink code (report_logic.h's UplinkSession, the
// very header the sketch includes) running on a desktop against a REAL relay, over a real TCP
// socket. It exists for tests/e2e/test_detector_firmware_e2e.js: the unit tests prove the state
// machine against fakes and the relay's tests prove it against hand-built messages, but only this
// proves that what the firmware actually WRITES is what the relay actually READS — framing, JSON,
// handshake, and the text the board logs for each answer the relay can give.
//
// What stands in for the hardware: a POSIX socket for the WiFiClient, a canned real JPEG
// (uplink_test_jpeg.h) for fmt2jpg(), and a synthetic detection loop (a new frame every 50 ms with
// moving numbers) for the snapshot. Compiled as C++11, like the board's toolchain.
//
//   uplink_client_tool <host> <port> <detector-id> <api-key> <seconds> [--no-jpeg] [--fps N]
//
// Prints one line per event on stdout, flushed at once:
//   LOG <LEVEL> <message>        what the firmware would have logged (to serial and the relay's log)
//   REACHABLE                    the uplink came up (the board would let queued log entries out)
//   STATS key=value ...          once, at the end

#include <errno.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <time.h>
#include <unistd.h>
#include <fcntl.h>

#include <string>

#include "../../Arduino/ESP32_CAM_TFLite_Person/report_logic.h"
#include "uplink_test_jpeg.h"

using namespace person_report;

static uint32_t monotonicMs() {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (uint32_t)((uint64_t)ts.tv_sec * 1000ULL + (uint64_t)ts.tv_nsec / 1000000ULL);
}

class SocketEnv : public IUplinkEnv {
public:
    bool jpegWorks = true;
    uint32_t startMs = monotonicMs();

    uint32_t nowMs() override { return monotonicMs(); }

    bool open(const std::string& host, int port, uint32_t timeoutMs, std::string& why) override {
        close();
        struct addrinfo hints;
        memset(&hints, 0, sizeof(hints));
        hints.ai_family = AF_INET;
        hints.ai_socktype = SOCK_STREAM;
        struct addrinfo* res = nullptr;
        if (getaddrinfo(host.c_str(), std::to_string(port).c_str(), &hints, &res) != 0 || !res) {
            why = "cannot resolve '" + host + "'";
            return false;
        }
        fd_ = socket(res->ai_family, res->ai_socktype, res->ai_protocol);
        if (fd_ < 0) { freeaddrinfo(res); why = std::string("socket(): ") + strerror(errno); return false; }
        fcntl(fd_, F_SETFL, fcntl(fd_, F_GETFL, 0) | O_NONBLOCK);
        int rc = ::connect(fd_, res->ai_addr, res->ai_addrlen);
        freeaddrinfo(res);
        if (rc < 0 && errno != EINPROGRESS) { why = std::string("connect failed: ") + strerror(errno); ::close(fd_); fd_ = -1; return false; }
        if (rc < 0) {
            struct pollfd p = { fd_, POLLOUT, 0 };
            if (poll(&p, 1, (int)timeoutMs) <= 0) { why = "connect timed out"; ::close(fd_); fd_ = -1; return false; }
            int err = 0;
            socklen_t l = sizeof(err);
            getsockopt(fd_, SOL_SOCKET, SO_ERROR, &err, &l);
            if (err != 0) { why = std::string("connect failed: ") + strerror(err); ::close(fd_); fd_ = -1; return false; }
        }
        int one = 1;
        setsockopt(fd_, IPPROTO_TCP, TCP_NODELAY, &one, sizeof(one));
        return true;
    }

    // Like WiFiClient::connected(): open while the other end has not closed AND nothing is left unread.
    bool isOpen() override {
        if (fd_ < 0) return false;
        char c;
        ssize_t n = recv(fd_, &c, 1, MSG_PEEK | MSG_DONTWAIT);
        if (n > 0) return true;
        if (n == 0) return false;
        return errno == EAGAIN || errno == EWOULDBLOCK;
    }

    size_t send(const uint8_t* data, size_t len, uint32_t stallMs) override {
        if (fd_ < 0) return 0;
        size_t total = 0;
        uint32_t lastProgress = monotonicMs();
        while (total < len) {
            ssize_t n = ::send(fd_, data + total, len - total, MSG_NOSIGNAL);
            if (n > 0) { total += (size_t)n; lastProgress = monotonicMs(); continue; }
            if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK) break;
            if ((uint32_t)(monotonicMs() - lastProgress) >= stallMs) break;
            struct pollfd p = { fd_, POLLOUT, 0 };
            poll(&p, 1, 50);
        }
        return total;
    }

    size_t receive(uint8_t* buf, size_t cap) override {
        if (fd_ < 0) return 0;
        ssize_t n = recv(fd_, buf, cap, MSG_DONTWAIT);
        return n > 0 ? (size_t)n : 0;
    }

    void close() override {
        if (fd_ >= 0) { ::close(fd_); fd_ = -1; }
    }

    // The detection loop: a new frame every 50 ms, with numbers that move so a test can tell frames apart.
    bool takeSnapshot(Snapshot& s, uint8_t* frame, uint32_t haveSeq) override {
        uint32_t seq = 1 + (uint32_t)((monotonicMs() - startMs) / 50);
        s = Snapshot();
        s.valid = true;
        s.seq = seq;
        s.brightness = 100 + (int)(seq % 20);
        s.motion = 10u * (seq % 50);
        s.gate = Gate::Active;
        s.hasScore = true;
        s.score = 0.1f * (float)(seq % 10);
        s.scoreAtMs = monotonicMs();
        s.detected = ((seq / 20) % 2) == 1;
        if (seq != haveSeq) memset(frame, (int)(seq & 0xff), 96 * 96);
        return true;
    }

    bool encodeJpeg(const uint8_t*, std::string& out) override {
        if (!jpegWorks) return false;
        out.assign((const char*)UPLINK_TEST_JPEG, UPLINK_TEST_JPEG_LEN);
        return true;
    }

    Telemetry telemetry() override {
        Telemetry t;
        t.ip = "10.1.2.3";
        t.rssi = -61;
        t.heap = 77777;
        return t;
    }

    void log(Level level, const std::string& message) override {
        const char* name = level == Level::Debug ? "DEBUG" : level == Level::Info ? "INFO" : level == Level::Warn ? "WARN" : "ERROR";
        printf("LOG %s %s\n", name, message.c_str());
        fflush(stdout);
    }

    void relayReachable() override {
        printf("REACHABLE\n");
        fflush(stdout);
    }

private:
    int fd_ = -1;
};

int main(int argc, char** argv) {
    if (argc < 6) {
        fprintf(stderr, "usage: %s <host> <port> <detector-id> <api-key> <seconds> [--no-jpeg] [--fps N]\n", argv[0]);
        return 2;
    }
    UplinkConfig cfg;
    cfg.host = argv[1];
    cfg.port = atoi(argv[2]);
    cfg.detectorId = argv[3];
    cfg.apiKey = argv[4];
    unsigned seconds = (unsigned)atoi(argv[5]);
    SocketEnv env;
    int fps = 10;
    for (int i = 6; i < argc; i++) {
        if (strcmp(argv[i], "--no-jpeg") == 0) env.jpegWorks = false;
        else if (strcmp(argv[i], "--fps") == 0 && i + 1 < argc) fps = atoi(argv[++i]);
    }
    cfg.report.detectorId = cfg.detectorId;
    cfg.report.fw = "desktop-tool";
    cfg.report.gpioPin = 13;
    cfg.report.darkBelow = 40;
    cfg.report.motionAtLeast = 300;
    cfg.report.holdSec = 10;
    cfg.report.detectAt = 0.6f;
    cfg.report.clearAt = 0.5f;
    cfg.minFrameGapMs = fps > 0 ? (uint32_t)(1000 / fps) : 100;
    cfg.retryFirstMs = 2000;
    cfg.retryMaxMs = 30000;

    UplinkSession session(cfg, env);
    uint32_t start = monotonicMs();
    while ((uint32_t)(monotonicMs() - start) < seconds * 1000U) {
        session.step(true);
        usleep(10000);
    }
    const LinkStats& st = session.stats();
    printf("STATS streaming=%d attempts=%u frames=%u jpegFails=%u reconnects=%u\n", session.streaming() ? 1 : 0,
           (unsigned)session.attempts(), (unsigned)st.frames, (unsigned)st.jpegFails, (unsigned)st.reconnects);
    fflush(stdout);
    return 0;
}
