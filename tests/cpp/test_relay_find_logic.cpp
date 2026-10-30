// Tests for relay_find_logic.h — how a camera finds the relay when its stored address stops working:
// the hash and MAC it checks answers with, the order it looks in (where it was, a broadcast, a sweep of
// the subnet), what it refuses to believe, and when it looks and what it changes.
//
// A scripted fake network stands in for the Wi-Fi: relays live at addresses (with a key), probes reach
// them or not (a broadcast does not cross a NAT router; a unicast does), and every address the camera
// sent to is recorded.

#include <deque>
#include <map>
#include <set>
#include <vector>

#include "framework.h"
#include "../../Arduino/ESP32_CAM_Recorder/relay_find_logic.h"

using namespace esp32cam_relayfind;

static const char* NONCE = "0123456789abcdef";
static const char* KEY = "change-me";

static std::string digestHex(const std::string& s) {
  Sha256 h;
  h.update(s);
  uint8_t d[32];
  h.finish(d);
  return toHex(d, 32);
}

// ── SHA-256 / HMAC against published vectors (also checked with sha256sum / openssl) ──

TEST(sha256_known_answers) {
  TEST_ASSERT_EQ(digestHex(""), std::string("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"), "empty");
  TEST_ASSERT_EQ(digestHex("abc"), std::string("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"), "abc");
  TEST_ASSERT_EQ(digestHex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
                 std::string("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"), "two blocks (FIPS 180-4)");
  TEST_ASSERT_EQ(digestHex(std::string(1000000, 'a')),
                 std::string("cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"), "a million a's");
}

TEST(sha256_padding_edges) {
  // 55, 56, 63, 64, 65 bytes straddle the padding rules (the length goes in the last 8 bytes of a block, so
  // 55 still fits in one block and 56 needs a second). Digests worked out with
  //   head -c N /dev/zero | tr '\0' 'x' | sha256sum
  TEST_ASSERT_EQ(digestHex(std::string(55, 'x')), std::string("d5e285683cd4efc02d021a5c62014694958901005d6f71e89e0989fac77e4072"), "55 bytes");
  TEST_ASSERT_EQ(digestHex(std::string(56, 'x')), std::string("04c26261370ee7541549d16dee320c723e3fd14671e66a099afe0a377c16888e"), "56 bytes");
  TEST_ASSERT_EQ(digestHex(std::string(63, 'x')), std::string("75220b47218278e656f2013bb8f0c455a25eaf01e86c64924e9d48d89776d6f2"), "63 bytes");
  TEST_ASSERT_EQ(digestHex(std::string(64, 'x')), std::string("7ce100971f64e7001e8fe5a51973ecdfe1ced42befe7ee8d5fd6219506b5393c"), "64 bytes");
  TEST_ASSERT_EQ(digestHex(std::string(65, 'x')), std::string("9537c5fdf120482f7d58d25e9ed583f52c02b4e304ea814db1633ad565aed7e9"), "65 bytes");
  // ...and the same input fed in odd-sized pieces gives the same digest (the buffering across blocks).
  const size_t sizes[] = {55, 56, 63, 64, 65, 119, 120, 127, 128, 129};
  for (size_t i = 0; i < sizeof(sizes) / sizeof(sizes[0]); ++i) {
    std::string s(sizes[i], 'q');
    Sha256 pieces;
    for (size_t at = 0; at < s.size();) {
      size_t n = (at % 7) + 1;
      if (at + n > s.size()) n = s.size() - at;
      pieces.update(reinterpret_cast<const uint8_t*>(s.data()) + at, n);
      at += n;
    }
    uint8_t d[32];
    pieces.finish(d);
    TEST_ASSERT_EQ(toHex(d, 32), digestHex(s), "fed in pieces = fed at once, " + std::to_string(sizes[i]) + " bytes");
  }
}

TEST(hmac_rfc4231_vectors) {
  TEST_ASSERT_EQ(hmacSha256Hex(std::string(20, '\x0b'), "Hi There"),
                 std::string("b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7"), "RFC 4231 case 1");
  TEST_ASSERT_EQ(hmacSha256Hex("Jefe", "what do ya want for nothing?"),
                 std::string("5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"), "RFC 4231 case 2");
  TEST_ASSERT_EQ(hmacSha256Hex(std::string(20, '\xaa'), std::string(50, '\xdd')),
                 std::string("773ea91e36800e46854db8ebd09181a72959098b3ef8c122d9635514ced565fe"), "RFC 4231 case 3");
  TEST_ASSERT_EQ(hmacSha256Hex(std::string(131, '\xaa'), "Test Using Larger Than Block-Size Key - Hash Key First"),
                 std::string("60e431591ee0b67f0d8a26aacbf5b77f8e0bc6213728c5140546040f0ee37f54"), "RFC 4231 case 6 (key longer than a block)");
}

TEST(the_mac_the_relay_makes_is_the_mac_the_camera_expects) {
  // The same fixed vector tests/node/test_discovery.js checks the relay's side against; it was worked out
  // with: printf 'ESPCAM1!0123456789abcdef' | openssl dgst -sha256 -hmac 'change-me'
  const std::string vector = "fcdee8782d8d0f678cca8814cd2737bcb2b302d2ca3d15a95bf916b08f6b5286";
  TEST_ASSERT_EQ(hmacSha256Hex(KEY, std::string("ESPCAM1!") + NONCE), vector, "HMAC of the signed text");
  TEST_ASSERT(replyValid(std::string("ESPCAM1!") + NONCE + ":" + vector, NONCE, KEY), "the relay's real answer is accepted");
}

// ── What a camera believes ──

TEST(reply_validation) {
  const std::string mac = hmacSha256Hex(KEY, std::string("ESPCAM1!") + NONCE);
  const std::string good = std::string("ESPCAM1!") + NONCE + ":" + mac;
  TEST_ASSERT(replyValid(good, NONCE, KEY), "the real answer");
  TEST_ASSERT(!replyValid(good, NONCE, "other-key"), "checked with another key");
  TEST_ASSERT(!replyValid(good, "fedcba9876543210", KEY), "an answer to a different probe (replay)");
  TEST_ASSERT(!replyValid(good + "0", NONCE, KEY), "longer");
  TEST_ASSERT(!replyValid(good.substr(0, good.size() - 1), NONCE, KEY), "shorter");
  std::string flipped = good;
  flipped[flipped.size() - 1] = flipped[flipped.size() - 1] == '0' ? '1' : '0';
  TEST_ASSERT(!replyValid(flipped, NONCE, KEY), "one changed character");
  std::string upper = good;
  for (size_t i = 0; i < upper.size(); ++i) if (upper[i] >= 'a' && upper[i] <= 'f') upper[i] = (char)(upper[i] - 32);
  TEST_ASSERT(!replyValid(upper, NONCE, KEY), "upper-case");
  TEST_ASSERT(!replyValid(std::string("ESPCAM1?") + NONCE + ":" + mac, NONCE, KEY), "the probe's tag is not the answer's");
  TEST_ASSERT(!replyValid(std::string("ESPCAM1!") + NONCE + ":" + hmacSha256Hex("wrong", std::string("ESPCAM1!") + NONCE), NONCE, KEY),
              "an answer made with the wrong key");
  TEST_ASSERT(!replyValid("yes I am the relay", NONCE, KEY), "an answer without proof");
  TEST_ASSERT(!replyValid("", NONCE, KEY), "empty");
  TEST_ASSERT(!replyValid(good, NONCE, ""), "no key: nothing can be checked, so nothing is believed");
  TEST_ASSERT(!replyValid(good, "short", KEY), "a malformed nonce");
}

TEST(probe_text) {
  TEST_ASSERT_EQ(buildProbe(NONCE), std::string("ESPCAM1?0123456789abcdef"), "the probe");
  TEST_ASSERT(isNonce("0123456789abcdef") && isNonce("ffffffffffffffff"), "16 lower-case hex");
  TEST_ASSERT(!isNonce("") && !isNonce("0123456789abcde") && !isNonce("0123456789abcdef0") &&
              !isNonce("0123456789ABCDEF") && !isNonce("0123456789abcdeg"), "anything else is not");
}

TEST(ipv4_parsing) {
  uint8_t a[4];
  TEST_ASSERT(parseIpv4("192.168.1.9", a) && a[0] == 192 && a[1] == 168 && a[2] == 1 && a[3] == 9, "a normal address");
  TEST_ASSERT(parseIpv4("0.0.0.0", a) && parseIpv4("255.255.255.255", a), "the extremes");
  const char* bad[] = {"", "1.2.3", "1.2.3.4.5", "256.1.1.1", "1.2.3.256", "01.2.3.4", "1.2.3.04", "1..3.4", "1.2.3.", ".1.2.3",
                       "a.b.c.d", "1.2.3.4 ", " 1.2.3.4", "raspberrypi.local", "1.2.3.4a", "-1.2.3.4", "1234.1.1.1", "1.2.3.0x4"};
  for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); ++i) TEST_ASSERT(!parseIpv4(bad[i], a), std::string("refused: '") + bad[i] + "'");
  uint8_t base[4] = {10, 0, 7, 99};
  TEST_ASSERT_EQ(ipv4With(base, 5), std::string("10.0.7.5"), "the subnet with another last number");
}

// ── A scripted network ──

struct FakeNet : IFindEnv {
  uint32_t now = 1000;
  std::string own = "192.168.1.50";
  std::map<std::string, std::string> dns;            // name -> address
  std::string nonce = NONCE;
  std::map<std::string, std::string> relays;         // address -> key it answers with (anyone with the wrong key is a rogue)
  bool broadcastReaches = true;                      // false: a NAT router in between
  bool unicastReaches = true;
  int dropFirstUnicasts = 0;                         // lose this many unicast probes (UDP is not reliable)
  std::vector<std::string> sentTo;
  std::deque<std::pair<std::string, std::string> > inbox;   // answers waiting to be read

  uint32_t nowMs() override { return now; }
  void pauseMs(uint32_t ms) override { now += ms; }
  std::string newNonce() override { return nonce; }
  bool resolve(const std::string& host, std::string& ip) override {
    uint8_t a[4];
    if (parseIpv4(host, a)) { ip = host; return true; }
    std::map<std::string, std::string>::const_iterator it = dns.find(host);
    if (it == dns.end()) return false;
    ip = it->second;
    return true;
  }
  std::string ownIp() override { return own; }
  std::string answer(const std::string& key, const std::string& n) {
    std::string signedText = std::string("ESPCAM1!") + n;
    return signedText + ":" + hmacSha256Hex(key, signedText);
  }
  bool send(const std::string& ip, const std::string& payload) override {
    sentTo.push_back(ip);
    if (payload.size() != 24 || payload.compare(0, 8, "ESPCAM1?") != 0) return false;
    std::string n = payload.substr(8);
    if (ip == "255.255.255.255") {
      if (!broadcastReaches) return true;
      for (std::map<std::string, std::string>::const_iterator r = relays.begin(); r != relays.end(); ++r)
        inbox.push_back(std::make_pair(r->first, answer(r->second, n)));
      return true;
    }
    if (!unicastReaches) return true;
    if (dropFirstUnicasts > 0) { --dropFirstUnicasts; return true; }
    std::map<std::string, std::string>::const_iterator r = relays.find(ip);
    if (r != relays.end()) inbox.push_back(std::make_pair(ip, answer(r->second, n)));
    return true;
  }
  bool receive(uint32_t waitMs, std::string& fromIp, std::string& payload) override {
    if (inbox.empty()) { now += waitMs; return false; }
    fromIp = inbox.front().first;
    payload = inbox.front().second;
    inbox.pop_front();
    return true;
  }
  int countTo(const std::string& ip) const {
    int n = 0;
    for (size_t i = 0; i < sentTo.size(); ++i) if (sentTo[i] == ip) ++n;
    return n;
  }
};

TEST(finds_it_where_it_was_with_one_probe) {
  FakeNet net;
  net.relays["192.168.1.9"] = KEY;
  Located l = RelayLocator(net).locate("192.168.1.9", KEY);
  TEST_ASSERT(l.ok && l.ip == "192.168.1.9" && l.atConfigured, "found at the stored address");
  TEST_ASSERT_EQ(net.sentTo.size(), (size_t)1, "one packet, no broadcast, no sweep");
}

TEST(a_lost_first_probe_is_tried_again) {
  FakeNet net;
  net.relays["192.168.1.9"] = KEY;
  net.dropFirstUnicasts = 1;
  Located l = RelayLocator(net).locate("192.168.1.9", KEY);
  TEST_ASSERT(l.ok && l.atConfigured, "found on the second try");
  TEST_ASSERT_EQ(net.sentTo.size(), (size_t)2, "two probes to it");
}

TEST(a_name_that_resolves_is_probed_first) {
  FakeNet net;
  net.dns["raspberrypi.local"] = "192.168.1.9";
  net.relays["192.168.1.9"] = KEY;
  Located l = RelayLocator(net).locate("raspberrypi.local", KEY);
  TEST_ASSERT(l.ok && l.ip == "192.168.1.9" && l.atConfigured, "the name's address answered: nothing to change");
  TEST_ASSERT_EQ(net.sentTo.size(), (size_t)1, "one packet");
}

TEST(a_relay_that_moved_on_the_same_wifi_is_found_by_broadcast) {
  FakeNet net;
  net.relays["192.168.1.77"] = KEY;   // the Pi got a new address
  Located l = RelayLocator(net).locate("192.168.1.9", KEY);
  TEST_ASSERT(l.ok && l.ip == "192.168.1.77" && !l.atConfigured, "found at the new address");
  TEST_ASSERT(net.countTo("255.255.255.255") == 1, "the broadcast did it");
  bool swept = false;
  for (size_t i = 0; i < net.sentTo.size(); ++i) if (net.sentTo[i] == "192.168.1.100") swept = true;
  TEST_ASSERT(!swept, "no sweep was needed");
}

TEST(behind_a_nat_router_the_sweep_of_the_stored_subnet_finds_it) {
  FakeNet net;
  net.own = "192.168.2.40";            // the camera sits on the extender's own network
  net.broadcastReaches = false;        // a broadcast stays on that network
  net.relays["192.168.1.57"] = KEY;    // the Pi, on the main router's network
  Located l = RelayLocator(net).locate("192.168.1.9", KEY);
  TEST_ASSERT(l.ok && l.ip == "192.168.1.57" && !l.atConfigured, "found across the NAT");
  TEST_ASSERT_EQ(net.sentTo.back(), std::string("192.168.1.57"), "and the sweep stopped at the answer instead of finishing");
  bool inOwn = false, outside = false;
  for (size_t i = 0; i < net.sentTo.size(); ++i) {
    const std::string& t = net.sentTo[i];
    if (t == "255.255.255.255") continue;
    if (t.compare(0, 10, "192.168.2.") == 0) inOwn = true;
    if (t.compare(0, 10, "192.168.1.") != 0) outside = true;
  }
  TEST_ASSERT(!inOwn && !outside, "it swept the relay's /24 (from SERVER_HOST), not its own");
}

TEST(the_sweep_covers_the_subnet_except_itself_and_the_ends) {
  FakeNet net;
  net.own = "192.168.1.50";
  Located l = RelayLocator(net).locate("192.168.1.9", KEY);   // nobody answers
  TEST_ASSERT(!l.ok, "nobody answered");
  std::set<std::string> swept;
  for (size_t i = 0; i < net.sentTo.size(); ++i) swept.insert(net.sentTo[i]);
  TEST_ASSERT(swept.count("192.168.1.1") && swept.count("192.168.1.254"), "both ends of the usable range");
  TEST_ASSERT(!swept.count("192.168.1.0") && !swept.count("192.168.1.255"), "not the network or broadcast address");
  TEST_ASSERT(!swept.count("192.168.1.50"), "not itself");
  TEST_ASSERT_EQ(swept.size(), (size_t)(253 + 1), "253 addresses plus the broadcast");
  TEST_ASSERT_EQ(net.sentTo.size(), (size_t)(2 + 2 + 253), "2 probes to the stored address, 2 broadcasts, then the 253 addresses of the sweep (the stored one is in it too)");
}

TEST(a_name_that_no_longer_resolves_sweeps_its_own_subnet) {
  FakeNet net;
  net.broadcastReaches = false;
  net.relays["192.168.1.33"] = KEY;
  Located l = RelayLocator(net).locate("raspberrypi.local", KEY);   // no DNS entry
  TEST_ASSERT(l.ok && l.ip == "192.168.1.33" && !l.atConfigured, "found in the camera's own subnet");
}

TEST(a_machine_without_the_key_is_not_believed) {
  FakeNet net;
  net.broadcastReaches = false;
  net.relays["192.168.1.20"] = "not-the-key";   // answers first, and says yes
  net.relays["192.168.1.57"] = KEY;
  Located l = RelayLocator(net).locate("192.168.1.9", KEY);
  TEST_ASSERT(l.ok && l.ip == "192.168.1.57", "the rogue at .20 was skipped, the real relay at .57 found");
  TEST_ASSERT(net.countTo("192.168.1.20") >= 1 && net.countTo("192.168.1.57") >= 1, "both were probed");
}

TEST(only_a_rogue_means_not_found) {
  FakeNet net;
  net.relays["192.168.1.20"] = "not-the-key";
  Located l = RelayLocator(net).locate("192.168.1.9", KEY);
  TEST_ASSERT(!l.ok, "never adopts an address that cannot prove it knows the key");
}

TEST(an_old_answer_is_not_believed) {
  FakeNet net;
  // An answer to some earlier probe is waiting in the socket; it is valid for ITS nonce, not this one.
  net.inbox.push_back(std::make_pair(std::string("192.168.1.66"), net.answer(KEY, "fedcba9876543210")));
  Located l = RelayLocator(net).locate("192.168.1.9", KEY);
  TEST_ASSERT(!l.ok, "a replayed answer proves nothing");
}

TEST(noise_on_the_port_cannot_hold_it_up) {
  FakeNet net;
  for (int i = 0; i < 5000; ++i) net.inbox.push_back(std::make_pair(std::string("192.168.1.66"), std::string("noise")));
  Located l = RelayLocator(net).locate("192.168.1.9", KEY);
  TEST_ASSERT(!l.ok, "and it returned");
  TEST_ASSERT(net.now < 1000 + 20000, "in bounded time");
}

TEST(no_key_no_search) {
  FakeNet net;
  net.relays["192.168.1.9"] = KEY;
  Located l = RelayLocator(net).locate("192.168.1.9", "");
  TEST_ASSERT(!l.ok && net.sentTo.empty(), "nothing is sent when no answer could be checked");
  FakeNet bad;
  bad.nonce = "not a nonce";
  TEST_ASSERT(!RelayLocator(bad).locate("192.168.1.9", KEY).ok && bad.sentTo.empty(), "nor with a broken random number");
}

TEST(a_failed_search_takes_a_bounded_few_seconds) {
  FakeNet net;
  uint32_t start = net.now;
  RelayLocator(net).locate("192.168.1.9", KEY);
  uint32_t took = net.now - start;
  TEST_ASSERT(took >= 2000 && took <= 5000, "between 2 and 5 seconds, was " + std::to_string(took) + " ms");
}

// ── When it looks, and what it changes ──

struct FakeStore : IAddressStore {
  std::vector<std::string> saved;
  bool ok = true;
  bool saveHost(const std::string& host) override {
    if (!ok) return false;
    saved.push_back(host);
    return true;
  }
};

static const uint32_t FIRST = 10000, OK = 60000, RMIN = 15000, RMAX = 300000;

TEST(finder_waits_for_wifi_and_the_first_delay) {
  FakeNet net; FakeStore store;
  net.relays["192.168.1.9"] = KEY;
  RelayFinder f(net, store, FIRST, OK, RMIN, RMAX);
  TEST_ASSERT(f.tick(false, "192.168.1.9", KEY) == RelayFinder::Idle, "no Wi-Fi: nothing");
  net.now += 100000;
  TEST_ASSERT(f.tick(false, "192.168.1.9", KEY) == RelayFinder::Idle, "still no Wi-Fi: the wait does not run out offline");
  TEST_ASSERT(f.tick(true, "192.168.1.9", KEY) == RelayFinder::Idle, "Wi-Fi is up: the first delay starts now");
  net.now += FIRST - 1;
  TEST_ASSERT(f.tick(true, "192.168.1.9", KEY) == RelayFinder::Idle, "not yet");
  net.now += 1;
  TEST_ASSERT(f.tick(true, "192.168.1.9", KEY) == RelayFinder::Healthy, "now");
  TEST_ASSERT(store.saved.empty(), "a relay that answers where it was changes nothing");
}

TEST(finder_checks_again_after_ok_seconds_and_never_rewrites_a_good_address) {
  FakeNet net; FakeStore store;
  net.relays["192.168.1.9"] = KEY;
  RelayFinder f(net, store, FIRST, OK, RMIN, RMAX);
  f.tick(true, "192.168.1.9", KEY);
  net.now += FIRST;
  TEST_ASSERT(f.tick(true, "192.168.1.9", KEY) == RelayFinder::Healthy, "first check");
  size_t sent = net.sentTo.size();
  net.now += OK - 1;
  TEST_ASSERT(f.tick(true, "192.168.1.9", KEY) == RelayFinder::Idle && net.sentTo.size() == sent, "a second before it is due: quiet");
  net.now += 1;
  TEST_ASSERT(f.tick(true, "192.168.1.9", KEY) == RelayFinder::Healthy, "due");
  TEST_ASSERT(store.saved.empty(), "still nothing written to flash");
}

TEST(finder_moves_to_the_new_address_and_says_restart) {
  FakeNet net; FakeStore store;
  net.relays["192.168.1.77"] = KEY;
  RelayFinder f(net, store, FIRST, OK, RMIN, RMAX);
  f.tick(true, "192.168.1.9", KEY);
  net.now += FIRST;
  TEST_ASSERT(f.tick(true, "192.168.1.9", KEY) == RelayFinder::Moved, "found elsewhere");
  TEST_ASSERT(store.saved.size() == 1 && store.saved[0] == "192.168.1.77", "SERVER_HOST now holds the new address");
  TEST_ASSERT_EQ(f.found(), std::string("192.168.1.77"), "and it can be named in the log");
}

TEST(finder_does_not_move_when_it_cannot_save) {
  FakeNet net; FakeStore store;
  store.ok = false;
  net.relays["192.168.1.77"] = KEY;
  RelayFinder f(net, store, FIRST, OK, RMIN, RMAX);
  f.tick(true, "192.168.1.9", KEY);
  net.now += FIRST;
  TEST_ASSERT(f.tick(true, "192.168.1.9", KEY) == RelayFinder::NotFound, "an address that cannot be kept is not acted on (no restart loop)");
  TEST_ASSERT_EQ(f.failures(), (uint32_t)1, "counted as a failure");
}

TEST(finder_backs_off_when_nobody_answers_and_starts_over_when_someone_does) {
  FakeNet net; FakeStore store;
  RelayFinder f(net, store, FIRST, OK, RMIN, RMAX);
  f.tick(true, "192.168.1.9", KEY);
  net.now += FIRST;
  const uint32_t expected[] = {15000, 30000, 60000, 120000, 240000, 300000, 300000};
  for (size_t i = 0; i < sizeof(expected) / sizeof(expected[0]); ++i) {
    TEST_ASSERT(f.tick(true, "192.168.1.9", KEY) == RelayFinder::NotFound, "not found, try " + std::to_string(i + 1));
    uint32_t after = net.now;
    net.now += expected[i] - 1;
    TEST_ASSERT(f.tick(true, "192.168.1.9", KEY) == RelayFinder::Idle, "still waiting " + std::to_string(expected[i]) + " ms");
    net.now += 1;
    (void)after;
  }
  net.relays["192.168.1.9"] = KEY;   // the relay is back, where it was
  TEST_ASSERT(f.tick(true, "192.168.1.9", KEY) == RelayFinder::Healthy, "back");
  TEST_ASSERT_EQ(f.failures(), (uint32_t)0, "the count starts over");
  net.relays.clear();
  net.now += OK;
  TEST_ASSERT(f.tick(true, "192.168.1.9", KEY) == RelayFinder::NotFound, "gone again");
  uint32_t t = net.now;
  net.now += RMIN - 1;
  TEST_ASSERT(f.tick(true, "192.168.1.9", KEY) == RelayFinder::Idle, "and the next try is after the short wait again");
  (void)t;
}

TEST(finder_survives_the_millis_wraparound) {
  FakeNet net; FakeStore store;
  net.now = 0xFFFFFFFFu - 5000;   // the counter wraps while it waits
  net.relays["192.168.1.9"] = KEY;
  RelayFinder f(net, store, FIRST, OK, RMIN, RMAX);
  f.tick(true, "192.168.1.9", KEY);
  net.now += FIRST - 1;
  TEST_ASSERT(f.tick(true, "192.168.1.9", KEY) == RelayFinder::Idle, "not yet, across the wrap");
  net.now += 1;
  TEST_ASSERT(f.tick(true, "192.168.1.9", KEY) == RelayFinder::Healthy, "due, across the wrap");
}

int main() {
  RUN_TEST(sha256_known_answers);
  RUN_TEST(sha256_padding_edges);
  RUN_TEST(hmac_rfc4231_vectors);
  RUN_TEST(the_mac_the_relay_makes_is_the_mac_the_camera_expects);
  RUN_TEST(reply_validation);
  RUN_TEST(probe_text);
  RUN_TEST(ipv4_parsing);
  RUN_TEST(finds_it_where_it_was_with_one_probe);
  RUN_TEST(a_lost_first_probe_is_tried_again);
  RUN_TEST(a_name_that_resolves_is_probed_first);
  RUN_TEST(a_relay_that_moved_on_the_same_wifi_is_found_by_broadcast);
  RUN_TEST(behind_a_nat_router_the_sweep_of_the_stored_subnet_finds_it);
  RUN_TEST(the_sweep_covers_the_subnet_except_itself_and_the_ends);
  RUN_TEST(a_name_that_no_longer_resolves_sweeps_its_own_subnet);
  RUN_TEST(a_machine_without_the_key_is_not_believed);
  RUN_TEST(only_a_rogue_means_not_found);
  RUN_TEST(an_old_answer_is_not_believed);
  RUN_TEST(noise_on_the_port_cannot_hold_it_up);
  RUN_TEST(no_key_no_search);
  RUN_TEST(a_failed_search_takes_a_bounded_few_seconds);
  RUN_TEST(finder_waits_for_wifi_and_the_first_delay);
  RUN_TEST(finder_checks_again_after_ok_seconds_and_never_rewrites_a_good_address);
  RUN_TEST(finder_moves_to_the_new_address_and_says_restart);
  RUN_TEST(finder_does_not_move_when_it_cannot_save);
  RUN_TEST(finder_backs_off_when_nobody_answers_and_starts_over_when_someone_does);
  RUN_TEST(finder_survives_the_millis_wraparound);
  return test::summarize();
}
