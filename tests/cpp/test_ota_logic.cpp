// Tests for ota_logic.h — the decisions of the over-the-air firmware update: what the
// relay's answer means, the URLs, when to ask and what to report.

#include "framework.h"
#include "../../Arduino/ESP32_CAM_Recorder/ota_logic.h"

using namespace esp32cam_ota;

static const char* MD5 = "900150983cd24fb0d6963f7d28e17f72";

TEST(parse_good_reply) {
  VersionReply r;
  TEST_ASSERT(parseVersionReply(std::string("f5959f7-dirty.t1760000000\n") + MD5 + "\n", r), "a normal answer parses");
  TEST_ASSERT_EQ(r.version, std::string("f5959f7-dirty.t1760000000"), "the version");
  TEST_ASSERT_EQ(r.md5, std::string(MD5), "the md5");
  TEST_ASSERT(parseVersionReply(std::string("v1\n") + MD5, r), "the final newline is optional");
}

TEST(parse_refuses_anything_else) {
  VersionReply r;
  const std::string md5 = MD5;
  TEST_ASSERT(!parseVersionReply("", r), "empty");
  TEST_ASSERT(!parseVersionReply("no firmware published", r), "an error text (no newline)");
  TEST_ASSERT(!parseVersionReply("v1\n", r), "no md5");
  TEST_ASSERT(!parseVersionReply("\n" + md5 + "\n", r), "no version");
  TEST_ASSERT(!parseVersionReply("v1\n" + md5.substr(1) + "\n", r), "a short md5");
  TEST_ASSERT(!parseVersionReply("v1\n" + md5 + "0\n", r), "a long md5");
  TEST_ASSERT(!parseVersionReply("v1\n" + std::string("ABCDEF0123456789ABCDEF0123456789") + "\n", r), "upper-case md5");
  TEST_ASSERT(!parseVersionReply("v1\n" + std::string(32, 'g') + "\n", r), "non-hex md5");
  TEST_ASSERT(!parseVersionReply("v 1\n" + md5 + "\n", r), "a space in the version");
  TEST_ASSERT(!parseVersionReply("v+1\n" + md5 + "\n", r), "a + in the version");
  TEST_ASSERT(!parseVersionReply(std::string(65, 'a') + "\n" + md5 + "\n", r), "a version over 64 characters");
  TEST_ASSERT(!parseVersionReply("v1\n" + md5 + "\nextra\n", r), "trailing lines");
  TEST_ASSERT(r.version.empty(), "a refused answer leaves the output untouched");
}

TEST(update_needed_is_difference_not_newness) {
  VersionReply r; r.version = "bbb"; r.md5 = MD5;
  TEST_ASSERT(updateNeeded("aaa", r), "a different version is an update");
  TEST_ASSERT(!updateNeeded("bbb", r), "the same version is not");
  TEST_ASSERT(updateNeeded("zzz", r), "an 'older' one is too (downgrade)");
  TEST_ASSERT(updateNeeded("dev", r), "a hand-built sketch is replaced");
}

TEST(urls) {
  TEST_ASSERT_EQ(buildVersionUrl("192.168.1.5", 8080, "recorder", "cam1", "abc", ""),
                 std::string("http://192.168.1.5:8080/ota/recorder/version?id=cam1&fw=abc"), "version url");
  TEST_ASSERT_EQ(buildVersionUrl("pi.local", 80, "detector", "cam2-human", "abc", "md5_failed"),
                 std::string("http://pi.local:80/ota/detector/version?id=cam2-human&fw=abc&err=md5_failed"), "with an error to report");
  TEST_ASSERT_EQ(buildFirmwareUrl("192.168.1.5", 8080, "recorder", "cam1"),
                 std::string("http://192.168.1.5:8080/ota/recorder/firmware.bin?id=cam1"), "firmware url");
}

TEST(error_tokens) {
  TEST_ASSERT_EQ(errToken("md5_failed"), std::string("md5_failed"), "a clean token is unchanged");
  TEST_ASSERT_EQ(errToken("Not Enough Space"), std::string("Not_Enough_Space"), "spaces become _");
  TEST_ASSERT_EQ(errToken("a&b=c\n"), std::string("a_b_c_"), "URL characters become _");
  TEST_ASSERT_EQ(errToken(std::string(100, 'x')).size(), (size_t)40, "cut at 40 characters");
  TEST_ASSERT_EQ(httpErrToken(404), std::string("http_404"), "an HTTP status");
  TEST_ASSERT_EQ(httpErrToken(-1), std::string("http_err1"), "the client's own error");
}

TEST(defaults_are_the_agreed_ones) {
  OtaTiming t = defaultTiming();
  TEST_ASSERT_EQ(t.firstCheckMs, 20000u, "first check 20 s after Wi-Fi");
  TEST_ASSERT_EQ(t.checkMs, 60000u, "then every 60 s");
  TEST_ASSERT_EQ(t.retryMs, 300000u, "300 s after a failed update");
}

TEST(policy_waits_for_wifi_then_the_first_delay) {
  OtaPolicy p;
  TEST_ASSERT(!p.due(0, false, 0), "no Wi-Fi: never");
  TEST_ASSERT(!p.due(100000, false, 0), "still no Wi-Fi");
  TEST_ASSERT(!p.due(100000, true, 0), "Wi-Fi just came up: not at once");
  TEST_ASSERT(!p.due(119999, true, 0), "...not before 20 s");
  TEST_ASSERT(p.due(120000, true, 0), "...at 20 s");
  TEST_ASSERT(p.due(125000, true, 0), "...and it stays due until a result is reported");
}

TEST(policy_jitter_is_added_and_capped) {
  OtaPolicy p;
  p.due(0, true, 10000);                          // Wi-Fi up, +10 s jitter
  TEST_ASSERT(!p.due(29999, true, 0), "20 s + 10 s jitter");
  TEST_ASSERT(p.due(30000, true, 0), "due after the jitter");
  p.onResult(30000, true, "", 999999);            // an absurd jitter is capped at timing.jitterMs
  TEST_ASSERT(!p.due(30000 + 60000 + 14999, true, 0), "jitter capped at 15 s");
  TEST_ASSERT(p.due(30000 + 60000 + 15000, true, 0), "due when the capped jitter is over");
}

TEST(policy_next_check_after_a_good_result) {
  OtaPolicy p;
  p.due(0, true, 0);
  TEST_ASSERT(p.due(20000, true, 0), "first check");
  p.onResult(20000, true, "", 0);
  TEST_ASSERT(!p.due(79999, true, 0), "next one 60 s later");
  TEST_ASSERT(p.due(80000, true, 0), "...there");
}

TEST(policy_failed_update_waits_300s_and_reports_once_received) {
  OtaPolicy p;
  p.due(0, true, 0);
  p.due(20000, true, 0);
  p.onResult(20000, false, "md5_failed", 0);
  TEST_ASSERT(!p.due(319999, true, 0), "5 minutes before trying again");
  TEST_ASSERT(p.due(320000, true, 0), "...then due");
  TEST_ASSERT_EQ(p.pendingError(), std::string("md5_failed"), "the token waits to be reported with that poll");
  p.onResult(320000, true, "", 0);
  TEST_ASSERT_EQ(p.pendingError(), std::string("md5_failed"), "an unreported error survives a poll that got no answer");
  p.clearError();
  TEST_ASSERT(p.pendingError().empty(), "cleared once the relay has it");
}

TEST(policy_survives_the_millis_wraparound) {
  OtaPolicy p;
  uint32_t t = 0xFFFFFFFFu - 5000u;
  p.due(t, true, 0);                              // due at t + 20000, which wraps past zero
  TEST_ASSERT(!p.due(t + 19999u, true, 0), "not yet, across the wrap");
  TEST_ASSERT(p.due(t + 20000u, true, 0), "due, across the wrap");
}

TEST(policy_restarts_the_first_delay_when_wifi_returns) {
  OtaPolicy p;
  p.due(0, true, 0);
  p.onResult(20000, true, "", 0);
  p.due(30000, false, 0);                         // Wi-Fi lost
  TEST_ASSERT(!p.due(90000, true, 0), "back up: a fresh settle delay, not an immediate check");
  TEST_ASSERT(p.due(110000, true, 0), "...20 s after it came back");
}

// ── nextReadStep: when is a response body over? ──────────────────────────
// The regression that matters: an OPEN connection with nothing left to read must not be "keep going
// for ever" — the reader spun without yielding and the task watchdog rebooted the board.

TEST(read_step_done_when_all_announced_bytes_are_in_even_if_the_connection_stays_open) {
  TEST_ASSERT(nextReadStep(50, 50, 256, true, 0, 5000) == ReadStep::Done, "50 of 50 bytes: done, keep-alive or not");
  TEST_ASSERT(nextReadStep(0, 0, 256, true, 0, 5000) == ReadStep::Done, "an empty body announced as empty is done");
}

TEST(read_step_continues_while_bytes_are_missing_and_recent) {
  TEST_ASSERT(nextReadStep(10, 50, 256, true, 0, 5000) == ReadStep::Continue, "waiting for the rest");
  TEST_ASSERT(nextReadStep(10, 50, 256, true, 4999, 5000) == ReadStep::Continue, "still inside the idle limit");
  TEST_ASSERT(nextReadStep(0, -1, 256, true, 100, 5000) == ReadStep::Continue, "unknown length, connection up: wait");
}

TEST(read_step_gives_up_when_nothing_arrives_for_too_long) {
  TEST_ASSERT(nextReadStep(10, 50, 256, true, 5000, 5000) == ReadStep::Incomplete, "idle limit reached");
  TEST_ASSERT(nextReadStep(0, -1, 256, true, 9000, 5000) == ReadStep::Incomplete, "unknown length and silent: give up");
}

TEST(read_step_closed_connection) {
  TEST_ASSERT(nextReadStep(10, 50, 256, false, 0, 5000) == ReadStep::Incomplete, "closed before the announced length");
  TEST_ASSERT(nextReadStep(10, -1, 256, false, 0, 5000) == ReadStep::Done, "closed = the end of a body of unknown length");
  TEST_ASSERT(nextReadStep(50, 50, 256, false, 0, 5000) == ReadStep::Done, "closed after the last byte");
}

TEST(read_step_refuses_what_is_too_large) {
  TEST_ASSERT(nextReadStep(0, 1000, 256, true, 0, 5000) == ReadStep::TooLarge, "the announced length is over the cap: refuse at once");
  TEST_ASSERT(nextReadStep(0, 256, 256, true, 0, 5000) == ReadStep::TooLarge, "a body of exactly the cap is refused too");
  TEST_ASSERT(nextReadStep(256, -1, 256, true, 0, 5000) == ReadStep::TooLarge, "unknown length growing past the cap");
  TEST_ASSERT(nextReadStep(255, 255, 256, true, 0, 5000) == ReadStep::Done, "one byte under the cap is fine");
}

int main() {
  RUN_TEST(parse_good_reply);
  RUN_TEST(parse_refuses_anything_else);
  RUN_TEST(update_needed_is_difference_not_newness);
  RUN_TEST(urls);
  RUN_TEST(error_tokens);
  RUN_TEST(defaults_are_the_agreed_ones);
  RUN_TEST(policy_waits_for_wifi_then_the_first_delay);
  RUN_TEST(policy_jitter_is_added_and_capped);
  RUN_TEST(policy_next_check_after_a_good_result);
  RUN_TEST(policy_failed_update_waits_300s_and_reports_once_received);
  RUN_TEST(policy_survives_the_millis_wraparound);
  RUN_TEST(policy_restarts_the_first_delay_when_wifi_returns);
  RUN_TEST(read_step_done_when_all_announced_bytes_are_in_even_if_the_connection_stays_open);
  RUN_TEST(read_step_continues_while_bytes_are_missing_and_recent);
  RUN_TEST(read_step_gives_up_when_nothing_arrives_for_too_long);
  RUN_TEST(read_step_closed_connection);
  RUN_TEST(read_step_refuses_what_is_too_large);
  return test::summarize();
}
