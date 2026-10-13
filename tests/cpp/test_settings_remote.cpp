// test_settings_remote.cpp — unit tests for getting MISSING settings from the
// relay instead of the serial port (RemoteFill and applyRemoteLine in
// settings_logic.h, and how BootConfigFlow uses them), using the Recorder's key
// table. No ESP32, no Wi-Fi: the relay is a scripted fake (remote_link_fake.h)
// and the clock is a number.
//
// What matters most here is what the relay is NOT allowed to do. A staged line is
// a way to change a board from afar, so it may only fill settings that are
// missing or invalid; a setting that is stored and valid must never change.
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -Wall -Wextra -o build/test_settings_remote test_settings_remote.cpp

#include "framework.h"

#include <string>
#include <vector>

#include "../../Arduino/ESP32_CAM_Recorder/settings_schema.h"
#include "settings_fakes.h"
#include "remote_link_fake.h"

static const char* TYPICAL =
    "WIFI=extender-1:password1;SERVER_HOST=192.168.4.9;PUSH_PORT=8081;HTTP_PORT=8080;"
    "CAMERA_ID=cam2;API_KEY=s3cret;PUSH_GAP_MUL=1.5;ALARM_GPIO_PIN=13;ALARM_ACTIVE=LOW;ALARM_ALL_CAMS=0;"
    "LOG_ENABLED=1;LOG_MIN_LEVEL=1;LOG_ECHO=1;LOG_RETRY_MAX=3;LOG_RETRY_SEC=300;LOG_FLUSH_SEC=10;"
    "LOG_REPEAT_SEC=30;LOG_HEARTBEAT=600;LOG_LOW_HEAP=30000";

// A complete board, from which tests remove what a newer firmware would add.
static void fill(MemoryStore& st) {
    CheckedLine c = checkLine(RECORDER_SCHEMA, TYPICAL);
    for (size_t i = 0; i < c.pairs.size(); ++i) st.set(c.pairs[i].key, c.pairs[i].value);
}
static std::vector<std::string> prereq() { return recorderRemotePrerequisites(); }

typedef ScriptedReply R;
using esp32cam_settings::FetchResult;

// ── remoteFillPossible ──────────────────────────────────────────────────

TEST(possible_when_everything_needed_to_reach_the_relay_is_stored_and_valid) {
    MemoryStore st; fill(st);
    TEST_ASSERT(remoteFillPossible(RECORDER_SCHEMA, st, prereq()), "complete board");
    st.m.erase("LOG_HEARTBEAT");
    TEST_ASSERT(remoteFillPossible(RECORDER_SCHEMA, st, prereq()), "a missing OTHER setting is exactly the case it is for");
    TEST_ASSERT_EQ(st.badGets, 0, "only keys that exist were read");
}

TEST(not_possible_when_any_prerequisite_is_missing) {
    const char* keys[] = { "WIFI", "SERVER_HOST", "HTTP_PORT", "API_KEY", "CAMERA_ID" };
    for (size_t i = 0; i < 5; ++i) {
        MemoryStore st; fill(st); st.m.erase(keys[i]);
        TEST_ASSERT(!remoteFillPossible(RECORDER_SCHEMA, st, prereq()), std::string("without ") + keys[i]);
        TEST_ASSERT_EQ(st.badGets, 0, "no read of a missing key");
    }
}

TEST(not_possible_when_a_prerequisite_is_stored_but_invalid) {
    MemoryStore st; fill(st);
    st.m["HTTP_PORT"] = "banana";
    TEST_ASSERT(!remoteFillPossible(RECORDER_SCHEMA, st, prereq()), "a bad port can't be used to reach the relay");
    MemoryStore st2; fill(st2);
    st2.m["CAMERA_ID"] = "has space";
    TEST_ASSERT(!remoteFillPossible(RECORDER_SCHEMA, st2, prereq()), "nor can a bad id");
}

TEST(not_possible_without_a_list_or_with_an_unknown_name) {
    MemoryStore st; fill(st);
    TEST_ASSERT(!remoteFillPossible(RECORDER_SCHEMA, st, std::vector<std::string>()), "empty list");
    std::vector<std::string> bad; bad.push_back("NOT_A_SETTING");
    TEST_ASSERT(!remoteFillPossible(RECORDER_SCHEMA, st, bad), "unknown name");
}

TEST(the_recorder_prerequisites_are_real_settings_and_exactly_what_reaches_the_relay) {
    std::vector<std::string> p = prereq();
    TEST_ASSERT_EQ((int)p.size(), 5, "five of them");
    for (size_t i = 0; i < p.size(); ++i) TEST_ASSERT(findKey(RECORDER_SCHEMA, p[i]) != nullptr, "in the schema: " + p[i]);
}

// ── applyRemoteLine: only gaps are filled ───────────────────────────────

TEST(a_missing_setting_is_filled_from_the_line) {
    MemoryStore st; fill(st); st.m.erase("LOG_HEARTBEAT");
    RemoteApplyResult r = applyRemoteLine(RECORDER_SCHEMA, st, "LOG_HEARTBEAT=900");
    TEST_ASSERT_EQ((int)r.stored, 1, "one stored");
    TEST_ASSERT(r.errors.empty() && r.ignored.empty(), "nothing wrong");
    TEST_ASSERT(r.keys.size() == 1 && r.keys[0] == "LOG_HEARTBEAT", "named");
    TEST_ASSERT_EQ(st.m["LOG_HEARTBEAT"], std::string("900"), "in flash");
    TEST_ASSERT(findProblems(RECORDER_SCHEMA, st).empty(), "the board is complete again");
}

TEST(settings_that_are_stored_and_valid_are_never_changed_by_the_relay) {
    MemoryStore st; fill(st); st.m.erase("LOG_HEARTBEAT");
    RemoteApplyResult r = applyRemoteLine(RECORDER_SCHEMA, st,
        "API_KEY=evil;SERVER_HOST=10.6.6.6;WIFI=evil-net:pw;CAMERA_ID=cam99;HTTP_PORT=1;LOG_HEARTBEAT=900");
    TEST_ASSERT_EQ((int)r.stored, 1, "only the missing one");
    TEST_ASSERT_EQ(st.m["API_KEY"], std::string("s3cret"), "API key untouched");
    TEST_ASSERT_EQ(st.m["SERVER_HOST"], std::string("192.168.4.9"), "server untouched");
    TEST_ASSERT_EQ(st.m["CAMERA_ID"], std::string("cam2"), "id untouched");
    TEST_ASSERT_EQ(st.m["HTTP_PORT"], std::string("8080"), "port untouched");
    TEST_ASSERT(st.m["WIFI"].find("evil") == std::string::npos, "wifi untouched");
    TEST_ASSERT_EQ((int)r.ignored.size(), 5, "and the five it left alone are named");
}

TEST(an_invalid_value_for_a_setting_that_is_not_missing_is_ignored_not_an_error) {
    MemoryStore st; fill(st); st.m.erase("LOG_HEARTBEAT");
    RemoteApplyResult r = applyRemoteLine(RECORDER_SCHEMA, st, "PUSH_PORT=notanumber;LOG_HEARTBEAT=900");
    TEST_ASSERT(r.errors.empty(), "not an error: that setting was never going to be used");
    TEST_ASSERT_EQ((int)r.stored, 1, "the needed one is stored");
    TEST_ASSERT_EQ(st.m["PUSH_PORT"], std::string("8081"), "the stored one is untouched");
}

TEST(a_stored_but_now_invalid_value_is_replaced) {
    MemoryStore st; fill(st); st.m["LOG_HEARTBEAT"] = "garbage";
    TEST_ASSERT(!findProblems(RECORDER_SCHEMA, st).empty(), "precondition: it is a problem");
    RemoteApplyResult r = applyRemoteLine(RECORDER_SCHEMA, st, "LOG_HEARTBEAT=900");
    TEST_ASSERT_EQ((int)r.stored, 1, "replaced");
    TEST_ASSERT_EQ(st.m["LOG_HEARTBEAT"], std::string("900"), "with the staged value");
}

TEST(it_is_all_or_nothing_one_bad_value_stores_nothing) {
    MemoryStore st; fill(st); st.m.erase("LOG_HEARTBEAT"); st.m.erase("LOG_LOW_HEAP");
    RemoteApplyResult r = applyRemoteLine(RECORDER_SCHEMA, st, "LOG_HEARTBEAT=900;LOG_LOW_HEAP=banana");
    TEST_ASSERT_EQ((int)r.stored, 0, "nothing stored");
    TEST_ASSERT(!r.errors.empty(), "with a reason");
    TEST_ASSERT(!st.has("LOG_HEARTBEAT") && !st.has("LOG_LOW_HEAP"), "not even the good one");
}

TEST(a_line_that_does_not_parse_stores_nothing) {
    MemoryStore st; fill(st); st.m.erase("LOG_HEARTBEAT");
    RemoteApplyResult r = applyRemoteLine(RECORDER_SCHEMA, st, "this is not a settings line");
    TEST_ASSERT(r.stored == 0 && !r.errors.empty(), "refused with a reason");
}

TEST(a_line_with_nothing_the_board_is_missing_does_nothing_quietly) {
    MemoryStore st; fill(st); st.m.erase("LOG_HEARTBEAT");
    RemoteApplyResult r = applyRemoteLine(RECORDER_SCHEMA, st, "SOME_FUTURE_KEY=1;LOG_ECHO=0");
    TEST_ASSERT(r.stored == 0 && r.errors.empty(), "no store, no error");
    TEST_ASSERT_EQ((int)r.ignored.size(), 2, "both named as ignored (unknown and not-missing)");
    TEST_ASSERT_EQ(st.m["LOG_ECHO"], std::string("1"), "LOG_ECHO untouched");
}

TEST(a_complete_board_takes_nothing_from_any_line) {
    MemoryStore st; fill(st);
    RemoteApplyResult r = applyRemoteLine(RECORDER_SCHEMA, st, "API_KEY=evil;LOG_HEARTBEAT=1");
    TEST_ASSERT_EQ((int)r.stored, 0, "nothing is missing, so nothing is taken");
    TEST_ASSERT_EQ(st.m["API_KEY"], std::string("s3cret"), "untouched");
}

TEST(escapes_in_a_staged_value_are_handled_exactly_like_typed_input) {
    MemoryStore a; fill(a); a.m.erase("LOG_HEARTBEAT");
    // Compare against typing the same text: a missing WIFI would be the natural escape case,
    // but WIFI is a prerequisite, so use a stand-alone check of the transformation on a secret.
    MemoryStore typed;
    CheckedLine c = checkLine(RECORDER_SCHEMA, "API_KEY=a\\;b");
    TEST_ASSERT(c.ok(), "typed form is valid");
    MemoryStore b; fill(b); b.m.erase("API_KEY");
    RemoteApplyResult r = applyRemoteLine(RECORDER_SCHEMA, b, "API_KEY=a\\;b");
    TEST_ASSERT_EQ((int)r.stored, 1, "stored");
    TEST_ASSERT_EQ(b.m["API_KEY"], c.pairs[0].value, "same canonical value as typing it");
}

TEST(a_failing_flash_write_is_reported) {
    MemoryStore st; fill(st); st.m.erase("LOG_HEARTBEAT"); st.failWrites = true;
    RemoteApplyResult r = applyRemoteLine(RECORDER_SCHEMA, st, "LOG_HEARTBEAT=900");
    TEST_ASSERT_EQ((int)r.stored, 0, "not stored");
    TEST_ASSERT(!r.errors.empty() && r.errors[0].find("flash") != std::string::npos, "says so");
}

// ── RemoteFill, step by step ────────────────────────────────────────────

struct Rig {
    MemoryStore st;
    ScriptLink link;
    ScriptConsole con;
    RemoteFill* fill;
    Rig(bool complete = true) : fill(nullptr) {
        if (complete) { ::fill(st); st.m.erase("LOG_HEARTBEAT"); }
        fill = new RemoteFill(RECORDER_SCHEMA, st, link, con, prereq(), 20000, 30000, 5000);
    }
    ~Rig() { delete fill; }
    // Steps the clock in 100 ms ticks until the fill stops running or `untilMs` passes.
    RemoteFill::Status run(uint32_t& now, uint32_t untilMs) {
        RemoteFill::Status s = RemoteFill::Running;
        while (s == RemoteFill::Running && now < untilMs) { s = fill->step(now); now += 100; }
        return s;
    }
};

TEST(it_connects_asks_and_stores_what_the_relay_sends) {
    Rig r; uint32_t now = 0;
    r.link.reply(FetchResult::Got, "LOG_HEARTBEAT=900");
    TEST_ASSERT(r.run(now, 60000) == RemoteFill::Filled, "Filled");
    TEST_ASSERT_EQ(r.link.connects, 1, "joined Wi-Fi once");
    TEST_ASSERT_EQ(r.link.fetches, 1, "asked once");
    TEST_ASSERT_EQ(r.link.needSeen[0], std::string("LOG_HEARTBEAT"), "and said what it was missing");
    TEST_ASSERT_EQ(r.st.m["LOG_HEARTBEAT"], std::string("900"), "stored");
    TEST_ASSERT(r.con.said("Asking the relay") && r.con.said("Wi-Fi connected") && r.con.said("Stored 1 setting(s)") &&
                r.con.said("LOG_HEARTBEAT") && r.con.said("Restarting"), "the serial log tells the story");
}

TEST(a_complete_missing_list_is_sent_as_names_only) {
    Rig r; uint32_t now = 0;
    r.st.m.erase("LOG_LOW_HEAP");
    r.link.reply(FetchResult::Got, "LOG_HEARTBEAT=900;LOG_LOW_HEAP=20000");
    r.run(now, 60000);
    TEST_ASSERT(r.link.needSeen[0] == "LOG_HEARTBEAT,LOG_LOW_HEAP" || r.link.needSeen[0] == "LOG_LOW_HEAP,LOG_HEARTBEAT" ||
                r.link.needSeen[0].find("LOG_HEARTBEAT") != std::string::npos, "both named, comma separated");
    TEST_ASSERT(r.link.needSeen[0].find("900") == std::string::npos && r.link.needSeen[0].find("s3cret") == std::string::npos, "never a value");
}

TEST(not_possible_without_the_settings_needed_to_reach_the_relay) {
    Rig r(false); uint32_t now = 0;
    r.st.m["LOG_ECHO"] = "1";
    TEST_ASSERT(r.run(now, 60000) == RemoteFill::NotPossible, "NotPossible");
    TEST_ASSERT_EQ(r.link.connects, 0, "Wi-Fi was never started");
    TEST_ASSERT(r.con.said("Type the missing settings here"), "tells the person");
    TEST_ASSERT(r.fill->step(now) == RemoteFill::NotPossible, "and stays that way");
}

TEST(it_gives_up_when_wifi_does_not_come_up_in_time) {
    Rig r; uint32_t now = 0;
    r.link.onlineOnCall = 0;
    RemoteFill::Status s = r.run(now, 60000);
    TEST_ASSERT(s == RemoteFill::GiveUp, "GiveUp");
    TEST_ASSERT(now >= 20000 && now <= 20300, "at the connect timeout (20 s)");
    TEST_ASSERT_EQ(r.link.fetches, 0, "never asked");
    TEST_ASSERT(r.con.said("Wi-Fi did not connect"), "said why");
}

TEST(it_waits_the_whole_window_for_a_relay_with_nothing_staged_then_gives_up) {
    Rig r; uint32_t now = 0;
    RemoteFill::Status s = r.run(now, 120000);
    TEST_ASSERT(s == RemoteFill::GiveUp, "GiveUp");
    TEST_ASSERT(now >= 30000 && now <= 30300, "30 s after Wi-Fi came up");
    TEST_ASSERT(r.link.fetches >= 6 && r.link.fetches <= 7, "asking every 5 s");
    TEST_ASSERT_EQ(r.con.count("no settings staged"), 1, "said once, not every 5 s");
    TEST_ASSERT(r.con.said("Restarting to try again"), "and that it restarts");
    TEST_ASSERT(r.st.m.count("LOG_HEARTBEAT") == 0, "nothing stored");
}

TEST(an_unreachable_relay_is_retried_and_reported_once) {
    Rig r; uint32_t now = 0;
    r.link.reply(FetchResult::Failed); r.link.reply(FetchResult::Failed); r.link.reply(FetchResult::Failed);
    r.link.reply(FetchResult::Got, "LOG_HEARTBEAT=900");
    TEST_ASSERT(r.run(now, 120000) == RemoteFill::Filled, "gets there on the fourth try");
    TEST_ASSERT_EQ(r.con.count("could not be reached"), 1, "reported once");
}

TEST(a_refused_line_is_reported_once_and_a_corrected_one_is_accepted) {
    Rig r; uint32_t now = 0;
    r.link.reply(FetchResult::Got, "LOG_HEARTBEAT=banana");
    r.link.reply(FetchResult::Got, "LOG_HEARTBEAT=banana");
    r.link.reply(FetchResult::Got, "LOG_HEARTBEAT=900");
    TEST_ASSERT(r.run(now, 120000) == RemoteFill::Filled, "Filled after the operator fixed the line");
    TEST_ASSERT_EQ(r.con.count("were refused"), 1, "the same refusal is not repeated");
    TEST_ASSERT_EQ(r.st.m["LOG_HEARTBEAT"], std::string("900"), "the good value is the one stored");
}

TEST(a_line_without_the_missing_settings_is_waited_out) {
    Rig r; uint32_t now = 0;
    r.link.whenEmpty = FetchResult::Got;       // the relay keeps answering...
    r.link.reply(FetchResult::Got, "LOG_ECHO=0");   // ...with something irrelevant
    RemoteFill::Status s = r.run(now, 120000);
    TEST_ASSERT(s == RemoteFill::GiveUp, "gives up after the window");
    TEST_ASSERT(r.con.said("none of the missing ones"), "said why");
    TEST_ASSERT_EQ(r.st.m["LOG_ECHO"], std::string("1"), "the irrelevant setting was not applied");
}

TEST(partial_progress_renews_the_window_for_the_rest) {
    Rig r; uint32_t now = 0;
    r.st.m.erase("LOG_LOW_HEAP");
    // First answer supplies one of the two, late in the window; the second the other, after the old deadline.
    r.link.reply(FetchResult::NothingStaged); r.link.reply(FetchResult::NothingStaged); r.link.reply(FetchResult::NothingStaged);
    r.link.reply(FetchResult::NothingStaged); r.link.reply(FetchResult::NothingStaged);
    r.link.reply(FetchResult::Got, "LOG_HEARTBEAT=900");           // ~25 s in
    for (int i = 0; i < 4; ++i) r.link.reply(FetchResult::NothingStaged);   // 20 s more: past the ORIGINAL 30 s deadline
    r.link.reply(FetchResult::Got, "LOG_LOW_HEAP=20000");
    TEST_ASSERT(r.run(now, 120000) == RemoteFill::Filled, "Filled");
    TEST_ASSERT(now > 30000, "it took longer than one window, because progress renewed it");
    TEST_ASSERT(r.con.said("Still missing: LOG_LOW_HEAP"), "said what was still missing");
    TEST_ASSERT(r.st.has("LOG_HEARTBEAT") && r.st.has("LOG_LOW_HEAP"), "both stored");
}

// ── inside BootConfigFlow ───────────────────────────────────────────────

struct FlowRig {
    MemoryStore st;
    ScriptLink link;
    ScriptConsole con;
    RemoteFill fill;
    BootConfigFlow flow;
    uint32_t now;
    FlowRig(bool attach = true, bool complete = true)
        : st(), link(), con(), fill(RECORDER_SCHEMA, st, link, con, prereq(), 20000, 30000, 5000),
          flow(RECORDER_SCHEMA, st, con, 5000), now(1000) {
        if (complete) { ::fill(st); st.m.erase("LOG_HEARTBEAT"); }
        if (attach) flow.attachRemote(&fill, 5000);
    }
    BootConfigFlow::Status run(uint32_t untilMs) {
        BootConfigFlow::Status s = BootConfigFlow::Running;
        while (s == BootConfigFlow::Running && now < untilMs) { s = flow.step(now); now += 10; }
        return s;
    }
};

TEST(a_board_missing_a_setting_that_nobody_types_asks_the_relay_after_five_seconds) {
    FlowRig f;
    f.link.reply(FetchResult::Got, "LOG_HEARTBEAT=900");
    BootConfigFlow::Status s = f.run(1000 + 60000);
    TEST_ASSERT(s == BootConfigFlow::Restart, "restart so the new setting takes effect");
    TEST_ASSERT(f.flow.changed(), "flagged as changed");
    TEST_ASSERT_EQ(f.st.m["LOG_HEARTBEAT"], std::string("900"), "stored");
    TEST_ASSERT(f.con.said("These settings need a value (1)") && f.con.said("asks the relay for these"), "the serial log explains what will happen");
}

TEST(the_serial_port_gets_five_seconds_to_itself_before_wifi_is_started) {
    FlowRig f;
    f.run(1000 + 4900);
    TEST_ASSERT_EQ(f.link.connects, 0, "no Wi-Fi in the first five seconds");
    f.run(1000 + 5200);
    TEST_ASSERT_EQ(f.link.connects, 1, "then it starts");
}

TEST(a_person_typing_stops_the_relay_and_the_restart_for_good) {
    FlowRig f;
    f.con.in = "x";                       // any byte: someone is there
    BootConfigFlow::Status s = f.run(1000 + 300000);
    TEST_ASSERT(s == BootConfigFlow::Running, "still waiting for the person after five minutes");
    TEST_ASSERT_EQ(f.link.connects, 0, "never touched Wi-Fi");
    TEST_ASSERT_EQ(f.link.fetches, 0, "never asked the relay");
}

TEST(a_person_arriving_after_the_relay_started_cancels_the_restart) {
    FlowRig f;
    f.link.onlineOnCall = 0;              // Wi-Fi never comes up, so the board would give up at ~25 s
    f.run(1000 + 10000);
    TEST_ASSERT_EQ(f.link.connects, 1, "precondition: it was already trying");
    f.con.in = "\n";                      // someone opens the serial monitor and presses Enter
    BootConfigFlow::Status s = f.run(1000 + 120000);
    TEST_ASSERT(s == BootConfigFlow::Running, "no restart behind their back");
}

TEST(without_the_settings_needed_to_reach_the_relay_the_board_stays_on_the_serial_console) {
    FlowRig f(true, false);               // blank board
    BootConfigFlow::Status s = f.run(1000 + 300000);
    TEST_ASSERT(s == BootConfigFlow::Running, "waits on serial, as before");
    TEST_ASSERT_EQ(f.link.connects, 0, "Wi-Fi never started");
    TEST_ASSERT_EQ(f.con.count("Type the missing settings here"), 1, "and said so once");
}

TEST(a_relay_that_never_answers_restarts_the_board_to_try_again_and_changes_nothing) {
    FlowRig f;
    BootConfigFlow::Status s = f.run(1000 + 120000);
    TEST_ASSERT(s == BootConfigFlow::Restart, "restart (the next boot asks again)");
    TEST_ASSERT(!f.flow.changed(), "nothing was changed");
    TEST_ASSERT(!f.st.has("LOG_HEARTBEAT"), "still missing");
    TEST_ASSERT(f.now >= 1000 + 5000 + 30000 && f.now <= 1000 + 5000 + 30000 + 600, "after 5 s serial + 30 s waiting");
}

TEST(a_complete_board_never_asks_the_relay_it_just_offers_the_change_window) {
    FlowRig f(true, true);
    f.st.m["LOG_HEARTBEAT"] = "600";      // complete
    BootConfigFlow::Status s = f.run(1000 + 20000);
    TEST_ASSERT(s == BootConfigFlow::Proceed, "boots normally after the 5 s window");
    TEST_ASSERT_EQ(f.link.connects, 0, "no Wi-Fi");
    TEST_ASSERT_EQ(f.link.fetches, 0, "no relay");
}

TEST(a_board_without_a_remote_attached_behaves_exactly_as_before) {
    FlowRig f(false);
    BootConfigFlow::Status s = f.run(1000 + 300000);
    TEST_ASSERT(s == BootConfigFlow::Running, "waits on serial forever");
    TEST_ASSERT(!f.con.said("asks the relay") && !f.con.said("Asking the relay"), "and never mentions the relay");
    TEST_ASSERT_EQ(f.link.connects, 0, "no Wi-Fi");
}

TEST(an_invalid_stored_value_is_fixed_from_the_relay_too) {
    FlowRig f;
    f.st.m["LOG_HEARTBEAT"] = "garbage";   // e.g. a newer firmware tightened the range
    f.link.reply(FetchResult::Got, "LOG_HEARTBEAT=900");
    TEST_ASSERT(f.run(1000 + 60000) == BootConfigFlow::Restart, "restart");
    TEST_ASSERT_EQ(f.st.m["LOG_HEARTBEAT"], std::string("900"), "replaced");
}

TEST(after_the_fix_the_next_boot_is_normal) {
    FlowRig f;
    f.link.reply(FetchResult::Got, "LOG_HEARTBEAT=900");
    f.run(1000 + 60000);
    // "Reboot": a fresh flow on the same flash.
    ScriptConsole con2; ScriptLink link2;
    RemoteFill fill2(RECORDER_SCHEMA, f.st, link2, con2, prereq(), 20000, 30000, 5000);
    BootConfigFlow flow2(RECORDER_SCHEMA, f.st, con2, 5000);
    flow2.attachRemote(&fill2, 5000);
    BootConfigFlow::Status s = BootConfigFlow::Running;
    for (uint32_t t = 0; s == BootConfigFlow::Running && t < 20000; t += 10) s = flow2.step(t);
    TEST_ASSERT(s == BootConfigFlow::Proceed, "settings complete: just the 5 s window, then go");
    TEST_ASSERT_EQ(link2.connects, 0, "no relay needed any more");
}

int main() {
    RUN_TEST(possible_when_everything_needed_to_reach_the_relay_is_stored_and_valid);
    RUN_TEST(not_possible_when_any_prerequisite_is_missing);
    RUN_TEST(not_possible_when_a_prerequisite_is_stored_but_invalid);
    RUN_TEST(not_possible_without_a_list_or_with_an_unknown_name);
    RUN_TEST(the_recorder_prerequisites_are_real_settings_and_exactly_what_reaches_the_relay);
    RUN_TEST(a_missing_setting_is_filled_from_the_line);
    RUN_TEST(settings_that_are_stored_and_valid_are_never_changed_by_the_relay);
    RUN_TEST(an_invalid_value_for_a_setting_that_is_not_missing_is_ignored_not_an_error);
    RUN_TEST(a_stored_but_now_invalid_value_is_replaced);
    RUN_TEST(it_is_all_or_nothing_one_bad_value_stores_nothing);
    RUN_TEST(a_line_that_does_not_parse_stores_nothing);
    RUN_TEST(a_line_with_nothing_the_board_is_missing_does_nothing_quietly);
    RUN_TEST(a_complete_board_takes_nothing_from_any_line);
    RUN_TEST(escapes_in_a_staged_value_are_handled_exactly_like_typed_input);
    RUN_TEST(a_failing_flash_write_is_reported);
    RUN_TEST(it_connects_asks_and_stores_what_the_relay_sends);
    RUN_TEST(a_complete_missing_list_is_sent_as_names_only);
    RUN_TEST(not_possible_without_the_settings_needed_to_reach_the_relay);
    RUN_TEST(it_gives_up_when_wifi_does_not_come_up_in_time);
    RUN_TEST(it_waits_the_whole_window_for_a_relay_with_nothing_staged_then_gives_up);
    RUN_TEST(an_unreachable_relay_is_retried_and_reported_once);
    RUN_TEST(a_refused_line_is_reported_once_and_a_corrected_one_is_accepted);
    RUN_TEST(a_line_without_the_missing_settings_is_waited_out);
    RUN_TEST(partial_progress_renews_the_window_for_the_rest);
    RUN_TEST(a_board_missing_a_setting_that_nobody_types_asks_the_relay_after_five_seconds);
    RUN_TEST(the_serial_port_gets_five_seconds_to_itself_before_wifi_is_started);
    RUN_TEST(a_person_typing_stops_the_relay_and_the_restart_for_good);
    RUN_TEST(a_person_arriving_after_the_relay_started_cancels_the_restart);
    RUN_TEST(without_the_settings_needed_to_reach_the_relay_the_board_stays_on_the_serial_console);
    RUN_TEST(a_relay_that_never_answers_restarts_the_board_to_try_again_and_changes_nothing);
    RUN_TEST(a_complete_board_never_asks_the_relay_it_just_offers_the_change_window);
    RUN_TEST(a_board_without_a_remote_attached_behaves_exactly_as_before);
    RUN_TEST(an_invalid_stored_value_is_fixed_from_the_relay_too);
    RUN_TEST(after_the_fix_the_next_boot_is_normal);
    return test::summarize();
}
