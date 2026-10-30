// relay_find_logic.h — how a camera finds the relay again when the address it has stored
// (SERVER_HOST) stops working, e.g. because the router gave the Pi a new address.
//
// This file is plain, hardware-free C++11 (no Arduino includes) so it can be unit-tested on a
// desktop: tests/cpp/test_relay_find_logic.cpp. relay_find.h joins it to WiFiUDP and the flash
// store. Copied into every sketch folder that uses it (an Arduino sketch can only include files
// from its own folder); the copies must be identical.
//
// How it looks for the relay, cheapest first, stopping at the first answer that checks out:
//   1. the address it has now (one UDP probe, sent twice)      -> the relay is where it was
//   2. a broadcast probe                                         -> the relay moved, same Wi-Fi network
//   3. a probe to every other address of the subnet it was in    -> the relay moved, and this camera may
//      (the /24 of SERVER_HOST; its own /24 if SERVER_HOST       sit behind a NAT router (a Wi-Fi
//      is a name that no longer resolves)                        extender in router mode)
// Step 3 matters: broadcasts and mDNS (raspberrypi.local) never cross a NAT router, but ordinary
// unicast packets do, so only a sweep reaches a relay from the "other side".
//
// The probe carries no secret. The relay answers with a MAC only someone who knows the camera key
// can compute, over a fresh random number of the camera's (see nodejs/camera-relay/lib/discovery.js,
// which must agree with this file byte for byte), so
//   - the key is never sent to a printer or a stranger the sweep happens to hit, and
//   - an answer from a machine that does not know the key, or a replayed one, is ignored.
//
// What it changes: only SERVER_HOST, and only when the old address got no answer and the relay
// answered from another one. The board then restarts (the address is read once at boot by several
// tasks), so one address is in use everywhere.

#pragma once

#include <stddef.h>
#include <stdint.h>
#include <string>

namespace esp32cam_relayfind {

// ── SHA-256 and HMAC-SHA256 ─────────────────────────────────────────────
// Written out here (about 1.5 KB of flash) rather than taken from a library so this file stays free
// of hardware headers and its answers are testable on a desktop against the published test vectors.

class Sha256 {
 public:
  Sha256() { reset(); }

  void reset() {
    static const uint32_t init[8] = {0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
                                     0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19};
    for (int i = 0; i < 8; ++i) h_[i] = init[i];
    bytes_ = 0;
    fill_ = 0;
  }

  void update(const uint8_t* data, size_t n) {
    bytes_ += n;
    while (n > 0) {
      size_t take = 64 - fill_;
      if (take > n) take = n;
      for (size_t i = 0; i < take; ++i) buf_[fill_ + i] = data[i];
      fill_ += take;
      data += take;
      n -= take;
      if (fill_ == 64) {
        block(buf_);
        fill_ = 0;
      }
    }
  }

  void update(const std::string& s) { update(reinterpret_cast<const uint8_t*>(s.data()), s.size()); }

  void finish(uint8_t out[32]) {
    uint64_t bits = bytes_ * 8;
    uint8_t pad = 0x80;
    update(&pad, 1);
    uint8_t zero = 0;
    while (fill_ != 56) update(&zero, 1);
    uint8_t len[8];
    for (int i = 0; i < 8; ++i) len[i] = (uint8_t)(bits >> (56 - 8 * i));
    update(len, 8);
    for (int i = 0; i < 8; ++i) {
      out[4 * i] = (uint8_t)(h_[i] >> 24);
      out[4 * i + 1] = (uint8_t)(h_[i] >> 16);
      out[4 * i + 2] = (uint8_t)(h_[i] >> 8);
      out[4 * i + 3] = (uint8_t)h_[i];
    }
  }

 private:
  static uint32_t rotr(uint32_t x, int n) { return (x >> n) | (x << (32 - n)); }

  void block(const uint8_t* p) {
    static const uint32_t K[64] = {
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2};
    uint32_t w[64];
    for (int i = 0; i < 16; ++i) {
      w[i] = ((uint32_t)p[4 * i] << 24) | ((uint32_t)p[4 * i + 1] << 16) | ((uint32_t)p[4 * i + 2] << 8) | p[4 * i + 3];
    }
    for (int i = 16; i < 64; ++i) {
      uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
      uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
      w[i] = w[i - 16] + s0 + w[i - 7] + s1;
    }
    uint32_t a = h_[0], b = h_[1], c = h_[2], d = h_[3], e = h_[4], f = h_[5], g = h_[6], h = h_[7];
    for (int i = 0; i < 64; ++i) {
      uint32_t t1 = h + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i];
      uint32_t t2 = (rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c));
      h = g; g = f; f = e; e = d + t1; d = c; c = b; b = a; a = t1 + t2;
    }
    h_[0] += a; h_[1] += b; h_[2] += c; h_[3] += d; h_[4] += e; h_[5] += f; h_[6] += g; h_[7] += h;
  }

  uint32_t h_[8];
  uint8_t buf_[64];
  size_t fill_;
  uint64_t bytes_;
};

inline std::string toHex(const uint8_t* d, size_t n) {
  static const char digits[] = "0123456789abcdef";
  std::string s;
  s.reserve(n * 2);
  for (size_t i = 0; i < n; ++i) {
    s += digits[d[i] >> 4];
    s += digits[d[i] & 15];
  }
  return s;
}

// HMAC-SHA256 (RFC 2104) as 64 lowercase hex characters.
inline std::string hmacSha256Hex(const std::string& key, const std::string& message) {
  uint8_t k[64];
  for (int i = 0; i < 64; ++i) k[i] = 0;
  if (key.size() > 64) {
    Sha256 s;
    s.update(key);
    s.finish(k);   // 32 bytes; the rest stays zero
  } else {
    for (size_t i = 0; i < key.size(); ++i) k[i] = (uint8_t)key[i];
  }
  uint8_t ipad[64], opad[64];
  for (int i = 0; i < 64; ++i) {
    ipad[i] = k[i] ^ 0x36;
    opad[i] = k[i] ^ 0x5c;
  }
  uint8_t inner[32], outer[32];
  Sha256 a;
  a.update(ipad, 64);
  a.update(message);
  a.finish(inner);
  Sha256 b;
  b.update(opad, 64);
  b.update(inner, 32);
  b.finish(outer);
  return toHex(outer, 32);
}

// ── The two datagrams ───────────────────────────────────────────────────
//   camera -> relay   "ESPCAM1?" + <nonce>                     nonce: 16 lowercase hex characters
//   relay  -> camera  "ESPCAM1!" + <nonce> + ":" + <mac>       mac: HMAC-SHA256(camKey, "ESPCAM1!" + <nonce>)

inline const char* probeTag() { return "ESPCAM1?"; }
inline const char* replyTag() { return "ESPCAM1!"; }

inline bool isNonce(const std::string& s) {
  if (s.size() != 16) return false;
  for (size_t i = 0; i < s.size(); ++i) {
    char c = s[i];
    if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false;
  }
  return true;
}

inline std::string buildProbe(const std::string& nonce) { return std::string(probeTag()) + nonce; }

// Same length and same bytes, taking the same time whatever the bytes are.
inline bool sameText(const std::string& a, const std::string& b) {
  if (a.size() != b.size()) return false;
  unsigned char diff = 0;
  for (size_t i = 0; i < a.size(); ++i) diff |= (unsigned char)(a[i] ^ b[i]);
  return diff == 0;
}

// true only for the relay's answer to THIS probe, from someone who knows `key`. An empty key never
// matches (a camera with no key could not tell a relay from anyone).
inline bool replyValid(const std::string& payload, const std::string& nonce, const std::string& key) {
  if (key.empty() || !isNonce(nonce)) return false;
  std::string signed_ = std::string(replyTag()) + nonce;
  return sameText(payload, signed_ + ":" + hmacSha256Hex(key, signed_));
}

// ── IPv4 text ───────────────────────────────────────────────────────────

// Strict dotted quad: four numbers 0..255, no leading zeros (010 is ambiguous), nothing else.
inline bool parseIpv4(const std::string& s, uint8_t out[4]) {
  size_t i = 0;
  for (int part = 0; part < 4; ++part) {
    unsigned v = 0;
    size_t digits = 0;
    while (i < s.size() && s[i] >= '0' && s[i] <= '9') {
      v = v * 10 + (unsigned)(s[i] - '0');
      ++digits;
      ++i;
      if (digits > 3 || v > 255) return false;
    }
    if (digits == 0) return false;
    if (digits > 1 && s[i - digits] == '0') return false;
    out[part] = (uint8_t)v;
    if (part < 3) {
      if (i >= s.size() || s[i] != '.') return false;
      ++i;
    }
  }
  return i == s.size();
}

// "a.b.c.<last>" for the subnet `base` is in.
inline std::string ipv4With(const uint8_t base[4], int last) {
  return std::to_string(base[0]) + "." + std::to_string(base[1]) + "." + std::to_string(base[2]) + "." +
         std::to_string(last);
}

// ── What the locator needs from the board ───────────────────────────────

class IFindEnv {
 public:
  virtual ~IFindEnv() {}
  virtual uint32_t nowMs() = 0;
  virtual void pauseMs(uint32_t ms) = 0;                    // lets other tasks and the radio run
  virtual std::string newNonce() = 0;                       // 16 lowercase hex characters, from the hardware RNG
  virtual bool resolve(const std::string& host, std::string& ip) = 0;   // an IPv4 literal as it is, a name by DNS
  virtual std::string ownIp() = 0;                          // this board's address, or "" if it has none
  virtual bool send(const std::string& ip, const std::string& payload) = 0;
  // Waits up to waitMs (0 = just look) for one datagram. false: none came.
  virtual bool receive(uint32_t waitMs, std::string& fromIp, std::string& payload) = 0;
};

struct Located {
  bool ok;
  std::string ip;        // where the relay answered from
  bool atConfigured;     // ... which is the address SERVER_HOST already leads to
  Located() : ok(false), atConfigured(false) {}
};

class RelayLocator {
 public:
  explicit RelayLocator(IFindEnv& env) : env_(env) {}

  // `host` is SERVER_HOST. Takes up to about 4 seconds when nothing answers (most of it is the sweep's
  // pauses and the wait for the last answers), so call it from a background task only.
  Located locate(const std::string& host, const std::string& key) {
    Located r;
    if (key.empty()) return r;
    std::string nonce = env_.newNonce();
    if (!isNonce(nonce)) return r;
    std::string probe = buildProbe(nonce);
    std::string from;

    std::string configured;
    bool haveConfigured = env_.resolve(host, configured);

    // 1. where it was
    if (haveConfigured) {
      for (int i = 0; i < UNICAST_TRIES; ++i) {
        env_.send(configured, probe);
        if (await(nonce, key, UNICAST_WAIT_MS, from)) return found(from, configured);
      }
    }

    // 2. anywhere on this Wi-Fi network
    for (int i = 0; i < BROADCAST_TRIES; ++i) {
      env_.send("255.255.255.255", probe);
      if (await(nonce, key, BROADCAST_WAIT_MS, from)) return found(from, configured);
    }

    // 3. every other address of the subnet the relay was in
    std::string self = env_.ownIp();
    uint8_t base[4];
    if (parseIpv4(haveConfigured ? configured : self, base)) {
      for (int last = 1; last <= 254; ++last) {
        std::string target = ipv4With(base, last);
        if (target == self) continue;
        env_.send(target, probe);
        env_.pauseMs(SWEEP_GAP_MS);                     // also keeps the ARP table and the radio from being flooded
        if (await(nonce, key, 0, from)) return found(from, configured);   // an answer may already be in
      }
      if (await(nonce, key, SWEEP_TAIL_MS, from)) return found(from, configured);
    }
    return r;
  }

  enum {
    UNICAST_TRIES = 2,
    UNICAST_WAIT_MS = 400,
    BROADCAST_TRIES = 2,
    BROADCAST_WAIT_MS = 350,
    SWEEP_GAP_MS = 6,
    SWEEP_TAIL_MS = 800
  };

 private:
  static Located found(const std::string& from, const std::string& configured) {
    Located r;
    r.ok = true;
    r.ip = from;
    r.atConfigured = (from == configured);
    return r;
  }

  // Waits for the first answer that checks out; datagrams that do not (other devices, old answers,
  // wrong key) are dropped. At most 64 are looked at, so noise on the port cannot hold this up.
  bool await(const std::string& nonce, const std::string& key, uint32_t waitMs, std::string& from) {
    uint32_t start = env_.nowMs();
    for (int looked = 0; looked < 64; ++looked) {
      uint32_t used = env_.nowMs() - start;
      uint32_t left = used >= waitMs ? 0 : waitMs - used;
      std::string src, payload;
      if (!env_.receive(left, src, payload)) return false;
      if (replyValid(payload, nonce, key)) {
        from = src;
        return true;
      }
    }
    return false;
  }

  IFindEnv& env_;
};

// ── When to look, and what to do with the answer ────────────────────────

class IAddressStore {
 public:
  virtual ~IAddressStore() {}
  virtual bool saveHost(const std::string& host) = 0;       // stores SERVER_HOST
};

class RelayFinder {
 public:
  enum Result {
    Idle,       // nothing was due
    Healthy,    // the relay answers at the stored address: nothing to change
    NotFound,   // nobody answered (relay off, or no discovery port open): try again later
    Moved       // the relay answered from another address and SERVER_HOST now holds it: restart
  };

  // firstMs after the first call, then every okMs while the relay answers; when it does not, again after
  // retryMinMs, doubling up to retryMaxMs (a sweep is not free, and a relay that is simply switched off
  // should not be hunted for every few seconds).
  RelayFinder(IFindEnv& env, IAddressStore& store, uint32_t firstMs, uint32_t okMs, uint32_t retryMinMs,
              uint32_t retryMaxMs)
      : env_(env), locator_(env), store_(store), firstMs_(firstMs), okMs_(okMs), retryMinMs_(retryMinMs),
        retryMaxMs_(retryMaxMs), armed_(false), next_(0), failures_(0) {}

  Result tick(bool online, const std::string& host, const std::string& key) {
    if (!online) return Idle;
    if (!armed_) {
      armed_ = true;
      next_ = env_.nowMs() + firstMs_;
    }
    if ((int32_t)(env_.nowMs() - next_) < 0) return Idle;

    Located l = locator_.locate(host, key);
    if (!l.ok) return failed();

    if (l.atConfigured || l.ip == host) {
      failures_ = 0;
      next_ = env_.nowMs() + okMs_;
      return Healthy;
    }
    if (!store_.saveHost(l.ip)) return failed();   // cannot keep it, so cannot act on it
    failures_ = 0;
    found_ = l.ip;
    return Moved;
  }

  const std::string& found() const { return found_; }         // after Moved: the address now stored
  uint32_t failures() const { return failures_; }             // in a row

 private:
  Result failed() {
    ++failures_;
    uint32_t wait = retryMinMs_;
    for (uint32_t i = 1; i < failures_ && wait < retryMaxMs_; ++i) wait *= 2;
    if (wait > retryMaxMs_) wait = retryMaxMs_;
    next_ = env_.nowMs() + wait;
    return NotFound;
  }

  IFindEnv& env_;
  RelayLocator locator_;
  IAddressStore& store_;
  uint32_t firstMs_, okMs_, retryMinMs_, retryMaxMs_;
  bool armed_;
  uint32_t next_;
  uint32_t failures_;
  std::string found_;
};

}  // namespace esp32cam_relayfind
