// Tests for ota.h — the Arduino half of the over-the-air update — compiled for real
// against fakes of the core (ota_fakes/): millis, Serial, WiFi, HTTPClient, Update, ESP.
// What this proves: the header compiles, makes the right requests (URL, X-Api-Key), flashes
// only when the relay's answer says so, reports the right error token after a failure and
// retries after the right wait, and restarts only after a good flash. It can NOT prove the
// real flash and radio work: that needs a board (see the hardware checklist in INSTALL.md).

#include "framework.h"

#define FW_GIT "cur123"
#include "ota.h"

static const std::string MD5 = "900150983cd24fb0d6963f7d28e17f72";
static const std::string IMAGE(2000, 'x');

static void resetWorld() {
  fake::g() = fake::State();
  fake::g().wifiUp = true;
}

static void route(const std::string& part, int code, const std::string& body = "", const std::string& image = "") {
  fake::Route r; r.part = part; r.code = code; r.body = body; r.image = image;
  fake::g().routes.push_back(r);
}

// Drives the updater like the sketch's task: a tick per second of fake time, up to `untilMs`.
static void runUntil(OtaUpdater& ota, uint32_t untilMs) {
  while (fake::g().now < untilMs) {
    fake::g().now += 1000;
    ota.tick("relay.lan", 8080, "KEY123", "cam1");
  }
}

static size_t countRequests(const std::string& part) {
  size_t n = 0;
  for (size_t i = 0; i < fake::g().requests.size(); i++) if (fake::g().requests[i].find(part) != std::string::npos) n++;
  return n;
}

TEST(no_wifi_no_request) {
  resetWorld();
  fake::g().wifiUp = false;
  OtaUpdater ota("recorder");
  runUntil(ota, 200000);
  TEST_ASSERT_EQ(fake::g().requests.size(), (size_t)0, "nothing is asked while Wi-Fi is down");
}

TEST(first_check_comes_20s_after_wifi) {
  resetWorld();
  route("/version", 200, "cur123\n" + MD5 + "\n");
  OtaUpdater ota("recorder");
  runUntil(ota, 20000);
  TEST_ASSERT_EQ(fake::g().requests.size(), (size_t)0, "nothing before 20 s (the first tick starts the clock)");
  runUntil(ota, 22000);
  TEST_ASSERT_EQ(fake::g().requests.size(), (size_t)1, "the first check goes out soon after");
}

TEST(a_check_sends_id_version_and_key) {
  resetWorld();
  route("/version", 200, "cur123\n" + MD5 + "\n");
  OtaUpdater ota("detector");
  runUntil(ota, 25000);
  TEST_ASSERT_EQ(fake::g().requests[0], std::string("http://relay.lan:8080/ota/detector/version?id=cam1&fw=cur123"), "the version url");
  TEST_ASSERT_EQ(fake::g().headers[0]["X-Api-Key"], std::string("KEY123"), "with the camera key as a header");
}

TEST(same_version_no_download_and_checks_every_minute) {
  resetWorld();
  route("/version", 200, "cur123\n" + MD5 + "\n");
  OtaUpdater ota("recorder");
  runUntil(ota, 200000);
  TEST_ASSERT(countRequests("/version") >= 3 && countRequests("/version") <= 4, "about one check a minute");
  TEST_ASSERT_EQ(countRequests("firmware.bin"), (size_t)0, "never a download");
  TEST_ASSERT(!fake::g().restarted, "never a restart");
}

TEST(a_different_version_is_downloaded_flashed_and_restarts) {
  resetWorld();
  route("/version", 200, "new456\n" + MD5 + "\n");
  route("firmware.bin?id=cam1", 200, "", IMAGE);
  OtaUpdater ota("recorder");
  runUntil(ota, 25000);
  TEST_ASSERT_EQ(countRequests("/ota/recorder/firmware.bin?id=cam1"), (size_t)1, "the image is downloaded");
  TEST_ASSERT_EQ(fake::g().updateSize, IMAGE.size(), "Update.begin gets the Content-Length");
  TEST_ASSERT_EQ(fake::g().updateMd5, MD5, "the announced md5 is set before writing");
  TEST_ASSERT_EQ(fake::g().bytesFlashed, IMAGE.size(), "every byte is written");
  TEST_ASSERT(fake::g().restarted, "and the board restarts");
  TEST_ASSERT(!fake::g().aborted, "without an abort");
  TEST_ASSERT_EQ(fake::g().headers.back()["X-Api-Key"], std::string("KEY123"), "the download carries the key too");
}

TEST(nothing_published_404_does_nothing) {
  resetWorld();
  route("/version", 404, "no firmware published");
  OtaUpdater ota("recorder");
  runUntil(ota, 200000);
  TEST_ASSERT_EQ(countRequests("firmware.bin"), (size_t)0, "no download");
  TEST_ASSERT(!fake::g().restarted, "no restart");
  TEST_ASSERT(countRequests("/version") >= 3, "it keeps asking on the normal schedule");
}

TEST(a_garbled_answer_is_ignored) {
  resetWorld();
  route("/version", 200, "<html>captive portal</html>");
  OtaUpdater ota("recorder");
  runUntil(ota, 100000);
  TEST_ASSERT_EQ(countRequests("firmware.bin"), (size_t)0, "no download from an answer it does not understand");
  TEST_ASSERT(!fake::g().restarted, "no restart");
}

TEST(relay_unreachable_is_quiet) {
  resetWorld();                                   // no routes: every request fails with -1
  OtaUpdater ota("recorder");
  runUntil(ota, 100000);
  TEST_ASSERT(!fake::g().restarted, "nothing happens");
  TEST_ASSERT_EQ(fake::g().serial.size(), (size_t)0, "and nothing is shouted about it");
}

TEST(md5_mismatch_is_reported_next_poll_and_retried_after_5_minutes) {
  resetWorld();
  route("/version", 200, "new456\n" + MD5 + "\n");
  route("firmware.bin", 200, "", IMAGE);
  fake::g().endOk = false;                        // Update.end() fails with the md5 error
  OtaUpdater ota("recorder");
  runUntil(ota, 25000);
  TEST_ASSERT(!fake::g().restarted, "no restart after a failed flash");
  TEST_ASSERT_EQ(countRequests("firmware.bin"), (size_t)1, "one attempt");
  TEST_ASSERT(fake::g().aborted, "the failed update is aborted");
  size_t before = fake::g().requests.size();
  runUntil(ota, 300000);
  TEST_ASSERT_EQ(fake::g().requests.size(), before, "nothing for 5 minutes");
  fake::g().endOk = true;
  runUntil(ota, 360000);
  size_t versionIdx = 0;
  for (size_t i = before; i < fake::g().requests.size(); i++) if (fake::g().requests[i].find("/version") != std::string::npos) { versionIdx = i; break; }
  TEST_ASSERT(versionIdx != 0, "then it asks again");
  TEST_ASSERT(fake::g().requests[versionIdx].find("&err=md5_failed") != std::string::npos, "and reports why the last attempt failed");
  TEST_ASSERT(fake::g().restarted, "the retry succeeds and restarts");
}

TEST(the_error_is_reported_once) {
  resetWorld();
  route("/version", 200, "new456\n" + MD5 + "\n");
  route("firmware.bin", 500);
  OtaUpdater ota("recorder");
  runUntil(ota, 25000);                           // attempt 1 fails: HTTP 500
  route("/version", 200, "cur123\n" + MD5 + "\n");   // (first matching route wins, so replace below)
  fake::g().routes.erase(fake::g().routes.begin());
  runUntil(ota, 330000);                          // the poll that carries the error
  runUntil(ota, 500000);                          // a later poll
  size_t withErr = 0;
  for (size_t i = 0; i < fake::g().requests.size(); i++) if (fake::g().requests[i].find("err=http_500") != std::string::npos) withErr++;
  TEST_ASSERT_EQ(withErr, (size_t)1, "err=http_500 is sent exactly once");
}

TEST(each_failure_has_its_token) {
  resetWorld();
  route("/version", 200, "new456\n" + MD5 + "\n");
  route("firmware.bin", 404);
  OtaUpdater a("recorder");
  runUntil(a, 25000);
  TEST_ASSERT(fake::g().serial.size() > 0 && fake::g().serial.back().find("http_404") != std::string::npos, "download 404 -> http_404");

  resetWorld();
  route("/version", 200, "new456\n" + MD5 + "\n");
  route("firmware.bin", 200, "", IMAGE);
  fake::g().beginOk = false;
  OtaUpdater b("recorder");
  runUntil(b, 25000);
  TEST_ASSERT(fake::g().serial.back().find("no_ota_partition") != std::string::npos, "no room / partition -> no_ota_partition");
  TEST_ASSERT(!fake::g().restarted, "no restart");

  resetWorld();
  route("/version", 200, "new456\n" + MD5 + "\n");
  route("firmware.bin", 200, "", IMAGE);
  fake::g().shortWrite = true;
  OtaUpdater c("recorder");
  runUntil(c, 25000);
  TEST_ASSERT(fake::g().serial.back().find("short_write") != std::string::npos, "a download that stops half way -> short_write");
  TEST_ASSERT(fake::g().aborted, "and is aborted, so the old firmware stays");
  TEST_ASSERT(!fake::g().restarted, "no restart");

  resetWorld();
  route("/version", 200, "new456\n" + MD5 + "\n");
  route("firmware.bin", 200, "", "");             // empty body: no length
  OtaUpdater d("recorder");
  runUntil(d, 25000);
  TEST_ASSERT(fake::g().serial.back().find("no_length") != std::string::npos, "no Content-Length -> no_length");
}

int main() {
  RUN_TEST(no_wifi_no_request);
  RUN_TEST(first_check_comes_20s_after_wifi);
  RUN_TEST(a_check_sends_id_version_and_key);
  RUN_TEST(same_version_no_download_and_checks_every_minute);
  RUN_TEST(a_different_version_is_downloaded_flashed_and_restarts);
  RUN_TEST(nothing_published_404_does_nothing);
  RUN_TEST(a_garbled_answer_is_ignored);
  RUN_TEST(relay_unreachable_is_quiet);
  RUN_TEST(md5_mismatch_is_reported_next_poll_and_retried_after_5_minutes);
  RUN_TEST(the_error_is_reported_once);
  RUN_TEST(each_failure_has_its_token);
  return test::summarize();
}
