// Tests for relay_find.h — the Arduino half of finding the relay again: compiled for real against the
// fakes of the Arduino core (tests/cpp/ota_fakes/), with the network played by `fake::g().udpHook`.
// What it decides is tested in test_relay_find_logic.cpp; this checks the joins: the packets that go out
// (port, size, text), the socket that is opened and closed, what is stored and when the board restarts.

#include <map>

#include "fake_core.h"
#include "framework.h"
#include "relay_find.h"

using namespace esp32cam_relayfind;

static const char* KEY = "change-me";

struct MemoryStore : esp32cam_settings::ISettingsStore {
  std::map<std::string, std::string> v;
  bool writable = true;
  bool has(const std::string& k) override { return v.count(k) != 0; }
  std::string get(const std::string& k) override { return v[k]; }
  bool set(const std::string& k, const std::string& value) override {
    if (!writable) return false;
    v[k] = value;
    return true;
  }
  void clearAll() override { v.clear(); }
};

// Resets the fake world and plays a network where `relays` (address -> key) answer a probe sent to
// them, or sent to the broadcast address when `broadcast` is true.
static std::map<std::string, std::string> g_relays;
static bool g_broadcast = true;
static void world(const std::map<std::string, std::string>& relays, bool broadcast = true) {
  fake::g() = fake::State();
  fake::g().now = 5000;
  fake::g().randomValue = 10;   // the "random" digit: every nonce digit is 'a'
  g_relays = relays;
  g_broadcast = broadcast;
  fake::g().udpHook = [](const std::string& ip, int, const std::string& payload) {
    if (payload.size() != 24 || payload.compare(0, 8, "ESPCAM1?") != 0) return;
    std::string signedText = "ESPCAM1!" + payload.substr(8);
    for (std::map<std::string, std::string>::const_iterator r = g_relays.begin(); r != g_relays.end(); ++r) {
      if (ip == r->first || (ip == "255.255.255.255" && g_broadcast)) {
        fake::g().udpInbox.push_back(std::make_pair(r->first, signedText + ":" + hmacSha256Hex(r->second, signedText)));
      }
    }
  };
}

static bool logged(const std::string& part) {
  for (size_t i = 0; i < fake::g().serial.size(); ++i) if (fake::g().serial[i].find(part) != std::string::npos) return true;
  return false;
}

// One tick that is due: arm it, let the first delay pass, tick again.
static bool dueTick(RelayFind& f, const std::string& host, bool relayDown = true) {
  f.tick(host, KEY, relayDown);
  fake::g().now += (uint32_t)RELAY_FIND_FIRST_SECONDS * 1000UL;
  return f.tick(host, KEY, relayDown);
}

TEST(nothing_is_sent_while_the_relay_works) {
  MemoryStore store;
  world({{"192.168.1.9", KEY}});
  RelayFind f(store);
  for (int i = 0; i < 5; ++i) {
    fake::g().now += 120000;
    TEST_ASSERT(!f.tick("192.168.1.9", KEY, false), "no restart");
  }
  TEST_ASSERT(fake::g().udpSent.empty() && fake::g().udpOpens == 0, "not one packet, not even a socket");
}

TEST(nothing_is_sent_without_wifi) {
  MemoryStore store;
  world({{"192.168.1.9", KEY}});
  fake::g().wifiUp = false;
  RelayFind f(store);
  TEST_ASSERT(!dueTick(f, "192.168.1.9"), "no restart");
  TEST_ASSERT(fake::g().udpSent.empty(), "no packet");
}

TEST(a_relay_that_answers_where_it_was_changes_nothing) {
  MemoryStore store;
  store.v["SERVER_HOST"] = "192.168.1.9";
  world({{"192.168.1.9", KEY}});
  RelayFind f(store);
  TEST_ASSERT(!dueTick(f, "192.168.1.9"), "no restart");
  TEST_ASSERT_EQ(store.v["SERVER_HOST"], std::string("192.168.1.9"), "SERVER_HOST untouched");
  TEST_ASSERT_EQ(fake::g().udpSent.size(), (size_t)1, "one probe");
  TEST_ASSERT(fake::g().udpSent[0].compare(0, 25, "192.168.1.9:8082 ESPCAM1?") == 0, "to the stored address, on the discovery port, with the probe tag");
  TEST_ASSERT_EQ(fake::g().udpSent[0].size(), (size_t)(16 + 1 + 24), "a 24-byte probe");
  TEST_ASSERT(fake::g().udpSent[0].substr(25) == "aaaaaaaaaaaaaaaa", "whose nonce came from the random generator");
  TEST_ASSERT(fake::g().udpOpens == 1 && fake::g().udpCloses == 1 && !fake::g().udpOpen, "the socket was opened and closed again");
}

TEST(a_moved_relay_is_stored_and_the_board_restarts) {
  MemoryStore store;
  store.v["SERVER_HOST"] = "192.168.1.9";
  store.v["API_KEY"] = KEY;
  world({{"192.168.1.77", KEY}});
  RelayFind f(store);
  TEST_ASSERT(dueTick(f, "192.168.1.9"), "restart");
  TEST_ASSERT_EQ(store.v["SERVER_HOST"], std::string("192.168.1.77"), "SERVER_HOST holds the new address");
  TEST_ASSERT_EQ(store.v["API_KEY"], std::string(KEY), "nothing else was touched");
  TEST_ASSERT(logged("192.168.1.77") && logged("192.168.1.9"), "the log says from where to where");
  TEST_ASSERT(!fake::g().udpOpen, "socket closed");
}

TEST(behind_a_nat_router_only_the_sweep_gets_through) {
  MemoryStore store;
  store.v["SERVER_HOST"] = "192.168.1.9";
  fake::g() = fake::State();
  world({{"192.168.1.200", KEY}}, /*broadcast=*/false);
  fake::g().ownIp = "192.168.2.40";   // the extender's own network
  RelayFind f(store);
  TEST_ASSERT(dueTick(f, "192.168.1.9"), "restart");
  TEST_ASSERT_EQ(store.v["SERVER_HOST"], std::string("192.168.1.200"), "found across the NAT");
}

TEST(a_machine_that_does_not_know_the_key_is_never_stored) {
  MemoryStore store;
  store.v["SERVER_HOST"] = "192.168.1.9";
  world({{"192.168.1.20", "not-the-key"}});
  RelayFind f(store);
  TEST_ASSERT(!dueTick(f, "192.168.1.9"), "no restart");
  TEST_ASSERT_EQ(store.v["SERVER_HOST"], std::string("192.168.1.9"), "SERVER_HOST untouched");
}

TEST(a_name_is_resolved_and_a_dead_name_still_leads_to_a_search) {
  MemoryStore store;
  store.v["SERVER_HOST"] = "raspberrypi.local";
  world({{"192.168.1.77", KEY}});
  RelayFind f(store);
  TEST_ASSERT(dueTick(f, "raspberrypi.local"), "the name does not resolve, the relay is found by broadcast");
  TEST_ASSERT_EQ(store.v["SERVER_HOST"], std::string("192.168.1.77"), "and the name is replaced by its address");

  MemoryStore store2;
  world({{"192.168.1.77", KEY}});
  fake::g().dns["raspberrypi.local"] = "192.168.1.77";
  RelayFind f2(store2);
  TEST_ASSERT(!dueTick(f2, "raspberrypi.local"), "a name that resolves to where the relay is: nothing to change");
  TEST_ASSERT(store2.v.empty(), "nothing stored");
}

TEST(nobody_answering_is_logged_the_first_time_then_rarely) {
  MemoryStore store;
  world({});
  RelayFind f(store);
  f.tick("192.168.1.9", KEY, true);
  fake::g().now += 10000;
  int warnings = 0;
  for (int i = 0; i < 13; ++i) {
    size_t before = fake::g().serial.size();
    TEST_ASSERT(!f.tick("192.168.1.9", KEY, true), "no restart");
    if (fake::g().serial.size() > before) ++warnings;
    fake::g().now += 300000;
  }
  TEST_ASSERT_EQ(warnings, 2, "the 1st and the 12th of 13 tries");
  TEST_ASSERT(logged("relay not found") && logged("UDP 8082"), "and it says what to check");
  TEST_ASSERT(store.v.empty(), "nothing stored");
}

TEST(an_address_that_cannot_be_saved_does_not_restart_the_board) {
  MemoryStore store;
  store.writable = false;
  world({{"192.168.1.77", KEY}});
  RelayFind f(store);
  TEST_ASSERT(!dueTick(f, "192.168.1.9"), "no restart (it would only loop)");
}

int main() {
  RUN_TEST(nothing_is_sent_while_the_relay_works);
  RUN_TEST(nothing_is_sent_without_wifi);
  RUN_TEST(a_relay_that_answers_where_it_was_changes_nothing);
  RUN_TEST(a_moved_relay_is_stored_and_the_board_restarts);
  RUN_TEST(behind_a_nat_router_only_the_sweep_gets_through);
  RUN_TEST(a_machine_that_does_not_know_the_key_is_never_stored);
  RUN_TEST(a_name_is_resolved_and_a_dead_name_still_leads_to_a_search);
  RUN_TEST(nobody_answering_is_logged_the_first_time_then_rarely);
  RUN_TEST(an_address_that_cannot_be_saved_does_not_restart_the_board);
  return test::summarize();
}
