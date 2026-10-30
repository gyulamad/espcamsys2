// relay_find_tool.cpp — the firmware's REAL relay search (relay_find_logic.h's RelayLocator: the probe, the
// check of the answer, the order broadcast / unicast / sweep) compiled into a desktop program, with real
// UDP sockets instead of WiFiUDP. tests/e2e/test_discovery_e2e.js runs it against a real relay (server.js),
// which is what proves the firmware (C++) and the relay (JavaScript) agree byte for byte.
//
// Build (as C++11, like the board's toolchain):  g++ -std=c++11 -Wall -Wextra -o relay_find_tool relay_find_tool.cpp
// Usage:  relay_find_tool <SERVER_HOST> <key> <udp-port> <own-ip> [nat]
//   SERVER_HOST  an IPv4 address, or any other text = "a name that does not resolve"
//   own-ip       the address this "board" claims to have (the sweep skips it and, for a name, sweeps its /24)
//   nat          pretend a NAT router sits in between: the broadcast goes nowhere (only unicast gets through)
// Prints  FOUND ip=<address> atConfigured=<0|1>  and exits 0, or prints NOT_FOUND and exits 3.

#include <arpa/inet.h>
#include <netinet/in.h>
#include <poll.h>
#include <sys/socket.h>
#include <unistd.h>

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <random>
#include <string>
#include <thread>

#include "../../Arduino/ESP32_CAM_Recorder/relay_find_logic.h"

using namespace esp32cam_relayfind;

class PosixEnv : public IFindEnv {
 public:
  PosixEnv(int port, const std::string& own, bool nat) : port_(port), nat_(nat), own_(own) {
    fd_ = socket(AF_INET, SOCK_DGRAM, 0);
    int on = 1;
    setsockopt(fd_, SOL_SOCKET, SO_BROADCAST, &on, sizeof(on));
  }
  ~PosixEnv() { if (fd_ >= 0) close(fd_); }

  uint32_t nowMs() override {
    return (uint32_t)std::chrono::duration_cast<std::chrono::milliseconds>(
               std::chrono::steady_clock::now().time_since_epoch()).count();
  }
  void pauseMs(uint32_t ms) override { std::this_thread::sleep_for(std::chrono::milliseconds(ms)); }
  std::string newNonce() override {
    static const char digits[] = "0123456789abcdef";
    std::random_device rd;
    std::string s;
    for (int i = 0; i < 16; ++i) s += digits[rd() % 16];
    return s;
  }
  bool resolve(const std::string& host, std::string& ip) override {
    uint8_t a[4];
    if (!parseIpv4(host, a)) return false;
    ip = host;
    return true;
  }
  std::string ownIp() override { return own_; }
  bool send(const std::string& ip, const std::string& payload) override {
    if (nat_ && ip == "255.255.255.255") return true;   // a broadcast never crosses a NAT router
    sockaddr_in to;
    to.sin_family = AF_INET;
    to.sin_port = htons((uint16_t)port_);
    if (inet_pton(AF_INET, ip.c_str(), &to.sin_addr) != 1) return false;
    return sendto(fd_, payload.data(), payload.size(), 0, reinterpret_cast<sockaddr*>(&to), sizeof(to)) == (ssize_t)payload.size();
  }
  bool receive(uint32_t waitMs, std::string& fromIp, std::string& payload) override {
    pollfd p;
    p.fd = fd_;
    p.events = POLLIN;
    p.revents = 0;
    if (poll(&p, 1, (int)waitMs) <= 0) return false;
    char buf[160];
    sockaddr_in from;
    socklen_t len = sizeof(from);
    ssize_t n = recvfrom(fd_, buf, sizeof(buf), 0, reinterpret_cast<sockaddr*>(&from), &len);
    if (n <= 0) return false;
    char text[INET_ADDRSTRLEN];
    inet_ntop(AF_INET, &from.sin_addr, text, sizeof(text));
    fromIp = text;
    payload.assign(buf, (size_t)n);
    return true;
  }

 private:
  int fd_, port_;
  bool nat_;
  std::string own_;
};

int main(int argc, char** argv) {
  if (argc != 5 && argc != 6) {
    std::fprintf(stderr, "usage: %s <SERVER_HOST> <key> <udp-port> <own-ip> [nat]\n", argv[0]);
    return 2;
  }
  PosixEnv env(std::atoi(argv[3]), argv[4], argc == 6 && std::string(argv[5]) == "nat");
  Located l = RelayLocator(env).locate(argv[1], argv[2]);
  if (!l.ok) {
    std::printf("NOT_FOUND\n");
    return 3;
  }
  std::printf("FOUND ip=%s atConfigured=%d\n", l.ip.c_str(), l.atConfigured ? 1 : 0);
  return 0;
}
