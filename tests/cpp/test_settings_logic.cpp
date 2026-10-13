// test_settings_logic.cpp — unit tests for settings_logic.h (the settings
// engine: line format, validation, missing-key detection, show/export, and the
// start-up conversation) and settings_schema.h (the Recorder's key table and
// its typed loader).
//
// Everything runs on a desktop against an in-memory store, a scripted serial
// console and a fake clock — no ESP32, no Arduino core.
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -Wall -Wextra -o build/test_settings_logic test_settings_logic.cpp

#include "framework.h"

#include <fstream>
#include <map>
#include <string>
#include <vector>

#include "../../Arduino/ESP32_CAM_Recorder/settings_schema.h"

using namespace esp32cam_settings;

#include "settings_fakes.h"

static bool has(const std::string& s, const char* part) { return s.find(part) != std::string::npos; }

// A complete, valid Recorder configuration as ONE line (the "template").
static const char* TYPICAL =
    "WIFI=extender-1:password1:extender-2:pass\\;word2;SERVER_HOST=192.168.4.9;PUSH_PORT=8081;HTTP_PORT=8080;"
    "CAMERA_ID=cam2;API_KEY=s3cret;PUSH_GAP_MUL=1.5;ALARM_GPIO_PIN=13;ALARM_ACTIVE=LOW;ALARM_ALL_CAMS=0;"
    "LOG_ENABLED=1;LOG_MIN_LEVEL=1;LOG_ECHO=1;LOG_RETRY_MAX=3;LOG_RETRY_SEC=300;LOG_FLUSH_SEC=10;"
    "LOG_REPEAT_SEC=30;LOG_HEARTBEAT=600;LOG_LOW_HEAP=30000";

// Stores a line the way the conversation would; returns whether it was valid.
static bool store(MemoryStore& st, const std::string& line) {
    CheckedLine c = checkLine(RECORDER_SCHEMA, line);
    if (!c.ok()) return false;
    for (size_t i = 0; i < c.pairs.size(); ++i) st.set(c.pairs[i].key, c.pairs[i].value);
    return true;
}

static bool anyError(const CheckedLine& c, const char* part) {
    for (size_t i = 0; i < c.errors.size(); ++i) if (has(c.errors[i], part)) return true;
    return false;
}

static std::string valueOf(const CheckedLine& c, const char* key) {
    for (size_t i = 0; i < c.pairs.size(); ++i) if (c.pairs[i].key == key) return c.pairs[i].value;
    return "<absent>";
}

// ── escaping ────────────────────────────────────────────────────────────

TEST(escape_round_trips_the_three_special_characters) {
    const char* samples[] = { "plain", "a;b", "a:b", "a\\b", ";:\\", "", "trailing\\", "x;;y::z" };
    for (size_t i = 0; i < sizeof(samples) / sizeof(samples[0]); ++i) {
        std::string raw = samples[i], back, err;
        TEST_ASSERT(unescapeText(escapeText(raw, true), back, err) && back == raw, samples[i]);
        TEST_ASSERT(unescapeText(escapeText(raw, false), back, err) && back == raw, samples[i]);
    }
    TEST_ASSERT(escapeText("a;b:c\\d", false) == "a\\;b:c\\\\d", "the colon is only escaped inside the WIFI list");
    TEST_ASSERT(escapeText("a;b:c\\d", true) == "a\\;b\\:c\\\\d", "...where it separates fields");
}

TEST(unescape_rejects_unknown_escapes_and_a_lone_backslash) {
    std::string out, err;
    TEST_ASSERT(!unescapeText("a\\x", out, err) && has(err, "unknown escape"), "unknown escape is an error, never silently accepted");
    err.clear();
    TEST_ASSERT(!unescapeText("abc\\", out, err) && has(err, "lone"), "a trailing backslash is an error");
    TEST_ASSERT(unescapeText("a\\;b\\:c\\\\", out, err) && out == "a;b:c\\", "the three valid escapes");
}

TEST(splitUnescaped_does_not_split_on_escaped_separators) {
    std::vector<std::string> parts;
    std::string err;
    TEST_ASSERT(splitUnescaped("a;b\\;c;d", ';', parts, err) && parts.size() == 3, "three pieces");
    TEST_ASSERT(parts.size() == 3 && parts[1] == "b\\;c", "the escaped ; stays inside its piece, escape intact");
    TEST_ASSERT(splitUnescaped("", ';', parts, err) && parts.size() == 1 && parts[0].empty(), "empty text is one empty piece");
    TEST_ASSERT(splitUnescaped("a;", ';', parts, err) && parts.size() == 2, "a trailing separator gives an empty last piece");
    TEST_ASSERT(!splitUnescaped("a\\", ';', parts, err), "lone trailing backslash");
}

// ── number parsing ──────────────────────────────────────────────────────

TEST(parseInt_is_strict) {
    long long v = 0;
    TEST_ASSERT(parseInt("8081", v) && v == 8081, "plain");
    TEST_ASSERT(parseInt("-1", v) && v == -1, "negative");
    TEST_ASSERT(parseInt("0", v) && v == 0, "zero");
    const char* bad[] = { "", "-", "+5", " 5", "5 ", "5x", "0x10", "1.5", "99999999999999999999" };
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); ++i) TEST_ASSERT(!parseInt(bad[i], v), bad[i]);
}

TEST(parseFloat_is_strict) {
    double d = 0;
    TEST_ASSERT(parseFloat("1.5", d) && d == 1.5, "plain");
    TEST_ASSERT(parseFloat(".5", d) && d == 0.5, "leading dot");
    TEST_ASSERT(parseFloat("1e-1", d) && d > 0.0999 && d < 0.1001, "exponent");
    const char* bad[] = { "", " 1", "1 ", "abc", "nan", "inf", "0x1p3", "1.2.3", "--1", "1,5" };
    for (size_t i = 0; i < sizeof(bad) / sizeof(bad[0]); ++i) TEST_ASSERT(!parseFloat(bad[i], d), bad[i]);
}

// ── parsing a typed line ────────────────────────────────────────────────

TEST(a_line_of_pairs_is_split_on_semicolons_and_the_first_equals_sign) {
    ParsedLine p = parseLine("KEY1=value1;KEY2=a=b;KEY3=x");
    TEST_ASSERT(p.errors.empty() && p.pairs.size() == 3, "three pairs");
    TEST_ASSERT(p.pairs[0].key == "KEY1" && p.pairs[0].value == "value1", "first");
    TEST_ASSERT(p.pairs[1].value == "a=b", "a value may contain '='");
}

TEST(keys_are_trimmed_and_upper_cased_but_values_are_left_alone) {
    ParsedLine p = parseLine("  camera_id = cam2 ;api_key=  sp ace  ");
    TEST_ASSERT(p.errors.empty() && p.pairs.size() == 2, "two pairs");
    TEST_ASSERT(p.pairs[0].key == "CAMERA_ID", "upper-cased and trimmed");
    TEST_ASSERT(p.pairs[0].value == " cam2 ", "value spaces are kept (a password may have them)");
    TEST_ASSERT(p.pairs[1].value == "  sp ace  ", "including leading and trailing ones");
}

TEST(trailing_semicolon_empty_pieces_and_line_endings_are_tolerated) {
    TEST_ASSERT(parseLine("A=1;").pairs.size() == 1 && parseLine("A=1;").errors.empty(), "trailing ;");
    TEST_ASSERT(parseLine(";;A=1;;B=2;;").pairs.size() == 2, "empty pieces");
    TEST_ASSERT(parseLine("A=1\r\n").pairs[0].value == "1", "CRLF stripped");
    TEST_ASSERT(parseLine("").pairs.empty() && parseLine("").errors.empty(), "an empty line is nothing, not an error");
}

TEST(an_escaped_semicolon_stays_in_its_value) {
    ParsedLine p = parseLine("A=x\\;y;B=2");
    TEST_ASSERT(p.errors.empty() && p.pairs.size() == 2, "two pairs");
    TEST_ASSERT(p.pairs[0].value == "x\\;y", "the escape is still in the raw value");
}

TEST(syntax_errors_are_reported_with_the_offending_piece) {
    ParsedLine p = parseLine("justtext;A=1");
    TEST_ASSERT(p.errors.size() == 1 && has(p.errors[0], "justtext") && has(p.errors[0], "KEY=value"), "no '='");
    p = parseLine("BAD KEY=1");
    TEST_ASSERT(p.errors.size() == 1 && has(p.errors[0], "not a valid setting name"), "space in a key");
    p = parseLine("=1");
    TEST_ASSERT(p.errors.size() == 1, "empty key");
    p = parseLine("A=1\\");
    TEST_ASSERT(p.errors.size() == 1 && has(p.errors[0], "lone"), "lone backslash at the end");
    p = parseLine("justtext_that_is_quite_long_and_might_be_a_password_xyz");
    TEST_ASSERT(p.errors.size() == 1 && has(p.errors[0], "...") && !has(p.errors[0], "password_xyz"),
                "a long wrong piece is shortened, not echoed in full");
}

TEST(a_line_over_the_limit_is_refused_whole) {
    std::string longLine = "A=" + std::string(MAX_LINE_LENGTH, 'x');
    ParsedLine p = parseLine(longLine);
    TEST_ASSERT(p.pairs.empty() && p.errors.size() == 1 && has(p.errors[0], "too long"), "refused");
    std::string exactly = "A=" + std::string(MAX_LINE_LENGTH - 2, 'x');
    TEST_ASSERT(parseLine(exactly).errors.empty(), "exactly at the limit is fine");
}

// ── the WIFI list ───────────────────────────────────────────────────────

TEST(wifi_list_one_three_and_sixteen_networks) {
    std::vector<WifiNet> n;
    std::string err;
    TEST_ASSERT(parseWifiList("home:password1", n, err) && n.size() == 1 && n[0].ssid == "home" && n[0].pass == "password1", "one");
    TEST_ASSERT(parseWifiList("a:password1:b:password2:c:password3", n, err) && n.size() == 3 && n[2].ssid == "c", "three");
    std::string most;
    for (int i = 0; i < 16; i++) most += (i ? ":" : "") + std::string("net") + std::to_string(i) + ":password" + std::to_string(i);
    TEST_ASSERT(parseWifiList(most, n, err) && n.size() == 16, "sixteen is the limit");
    TEST_ASSERT(!parseWifiList(most + ":net16:password16", n, err) && has(err, "more than 16"), "seventeen is refused");
}

TEST(wifi_list_errors) {
    std::vector<WifiNet> n;
    std::string err;
    TEST_ASSERT(!parseWifiList("", n, err) && has(err, "empty"), "empty");
    TEST_ASSERT(!parseWifiList("home", n, err) && has(err, "odd number"), "an ssid without a password field");
    TEST_ASSERT(!parseWifiList("a:password1:b", n, err) && has(err, "odd number"), "odd count");
    TEST_ASSERT(!parseWifiList("a:password1:", n, err), "trailing colon makes it odd");
    TEST_ASSERT(!parseWifiList(":password1", n, err) && has(err, "network 1"), "empty ssid");
    TEST_ASSERT(!parseWifiList(std::string(33, 'x') + ":password1", n, err) && has(err, "1 to 32"), "33-byte ssid");
    TEST_ASSERT(parseWifiList(std::string(32, 'x') + ":password1", n, err), "32-byte ssid");
    TEST_ASSERT(!parseWifiList("a:short", n, err) && has(err, "8 to 63"), "7-char password");
    TEST_ASSERT(parseWifiList("a:12345678", n, err), "8-char password");
    TEST_ASSERT(parseWifiList("a:" + std::string(63, 'p'), n, err), "63-char password");
    TEST_ASSERT(!parseWifiList("a:" + std::string(64, 'p'), n, err), "64-char password");
    TEST_ASSERT(!parseWifiList("a:password1:b:bad\tpass1", n, err) && has(err, "network 2") && has(err, "control"), "tab in a password; says which network");
    TEST_ASSERT(!parseWifiList("a\x01:password1", n, err) && has(err, "control"), "control character in a name");
    TEST_ASSERT(!parseWifiList("a:pass\\xword1", n, err) && has(err, "network 1") && has(err, "unknown escape"), "bad escape in a password");
}

TEST(wifi_open_network_has_an_empty_password) {
    std::vector<WifiNet> n;
    std::string err;
    TEST_ASSERT(parseWifiList("guest:", n, err) && n.size() == 1 && n[0].pass.empty(), "ssid: is an open network");
    TEST_ASSERT(parseWifiList("home:password1:guest:", n, err) && n.size() == 2 && n[1].pass.empty(), "mixed with a protected one");
}

TEST(wifi_passwords_and_names_may_contain_semicolons_colons_and_backslashes) {
    std::vector<WifiNet> n;
    std::string err;
    TEST_ASSERT(parseWifiList("my\\:net:pa\\:ss\\;wo\\\\rd", n, err), "parsed");
    TEST_ASSERT(n.size() == 1 && n[0].ssid == "my:net" && n[0].pass == "pa:ss;wo\\rd", "decoded");
    std::string joined = joinWifiList(n);
    std::vector<WifiNet> again;
    TEST_ASSERT(parseWifiList(joined, again, err) && again.size() == 1 && again[0].ssid == n[0].ssid && again[0].pass == n[0].pass,
                "join then parse gives the same network");
}

TEST(a_wifi_line_with_an_escaped_semicolon_is_one_setting) {
    CheckedLine c = checkLine(RECORDER_SCHEMA, "WIFI=a:pass\\;word1:b:password2;CAMERA_ID=cam1");
    TEST_ASSERT(c.ok() && c.pairs.size() == 2, "two settings, the ; in the password did not split");
    TEST_ASSERT(valueOf(c, "WIFI") == "a:pass\\;word1:b:password2", "stored canonical (escaped) form");
}

// ── validating values (through checkLine, as the conversation does) ─────

TEST(ports_must_be_whole_numbers_from_1_to_65535) {
    const char* good[] = { "1", "80", "8081", "65535" };
    for (size_t i = 0; i < 4; ++i) TEST_ASSERT(checkLine(RECORDER_SCHEMA, std::string("PUSH_PORT=") + good[i]).ok(), good[i]);
    const char* bad[] = { "0", "65536", "-1", "abc", "80x", "", "1.5", " 80" };
    for (size_t i = 0; i < 8; ++i) TEST_ASSERT(!checkLine(RECORDER_SCHEMA, std::string("PUSH_PORT=") + bad[i]).ok(), bad[i]);
    CheckedLine c = checkLine(RECORDER_SCHEMA, "PUSH_PORT=70000");
    TEST_ASSERT(anyError(c, "PUSH_PORT must be a whole number from 1 to 65535"), "the message says what is allowed");
}

TEST(numbers_are_stored_in_canonical_form) {
    CheckedLine c = checkLine(RECORDER_SCHEMA, "HTTP_PORT=0080;LOG_MIN_LEVEL=02");
    TEST_ASSERT(c.ok() && valueOf(c, "HTTP_PORT") == "80" && valueOf(c, "LOG_MIN_LEVEL") == "2", "leading zeros dropped");
}

TEST(camera_id_charset_and_length) {
    TEST_ASSERT(checkLine(RECORDER_SCHEMA, "CAMERA_ID=cam2").ok(), "plain");
    TEST_ASSERT(checkLine(RECORDER_SCHEMA, "CAMERA_ID=Cam_2.garage-1").ok(), "A-Z a-z 0-9 _ . -");
    TEST_ASSERT(checkLine(RECORDER_SCHEMA, "CAMERA_ID=" + std::string(64, 'a')).ok(), "64 characters");
    TEST_ASSERT(!checkLine(RECORDER_SCHEMA, "CAMERA_ID=" + std::string(65, 'a')).ok(), "65 characters");
    TEST_ASSERT(!checkLine(RECORDER_SCHEMA, "CAMERA_ID=").ok(), "empty");
    TEST_ASSERT(!checkLine(RECORDER_SCHEMA, "CAMERA_ID=cam 2").ok(), "space");
    TEST_ASSERT(!checkLine(RECORDER_SCHEMA, "CAMERA_ID=cam/2").ok(), "slash");
    TEST_ASSERT(!checkLine(RECORDER_SCHEMA, "CAMERA_ID=cam\\;2").ok(), "an escaped ; is not a name character");
}

TEST(server_host_is_a_hostname_or_ip) {
    TEST_ASSERT(checkLine(RECORDER_SCHEMA, "SERVER_HOST=192.168.4.9").ok(), "IPv4");
    TEST_ASSERT(checkLine(RECORDER_SCHEMA, "SERVER_HOST=pi.local").ok(), "hostname");
    TEST_ASSERT(!checkLine(RECORDER_SCHEMA, "SERVER_HOST=").ok(), "empty");
    TEST_ASSERT(!checkLine(RECORDER_SCHEMA, "SERVER_HOST=http://pi").ok(), "a URL is not a host");
    TEST_ASSERT(!checkLine(RECORDER_SCHEMA, "SERVER_HOST=pi local").ok(), "space");
    TEST_ASSERT(!checkLine(RECORDER_SCHEMA, "SERVER_HOST=" + std::string(254, 'a')).ok(), "too long");
}

TEST(api_key_must_be_real_and_may_contain_special_characters) {
    TEST_ASSERT(checkLine(RECORDER_SCHEMA, "API_KEY=s3cret").ok(), "plain");
    CheckedLine c = checkLine(RECORDER_SCHEMA, "API_KEY=a\\;b\\\\c d");
    TEST_ASSERT(c.ok() && valueOf(c, "API_KEY") == "a;b\\c d", "escapes decoded, spaces kept");
    TEST_ASSERT(anyError(checkLine(RECORDER_SCHEMA, "API_KEY=change-me"), "placeholder"), "the example placeholder is refused");
    TEST_ASSERT(!checkLine(RECORDER_SCHEMA, "API_KEY=").ok(), "empty");
    TEST_ASSERT(!checkLine(RECORDER_SCHEMA, "API_KEY=" + std::string(129, 'k')).ok(), "129 characters");
    TEST_ASSERT(!checkLine(RECORDER_SCHEMA, "API_KEY=a\tb").ok(), "a tab would break the relay's <id>TAB<key> auth line");
}

TEST(bool_spellings_are_normalised_to_1_and_0) {
    const char* yes[] = { "1", "true", "TRUE", "Yes", "on" };
    const char* no[] = { "0", "false", "No", "OFF" };
    for (size_t i = 0; i < 5; ++i) TEST_ASSERT(valueOf(checkLine(RECORDER_SCHEMA, std::string("LOG_ENABLED=") + yes[i]), "LOG_ENABLED") == "1", yes[i]);
    for (size_t i = 0; i < 4; ++i) TEST_ASSERT(valueOf(checkLine(RECORDER_SCHEMA, std::string("LOG_ENABLED=") + no[i]), "LOG_ENABLED") == "0", no[i]);
    TEST_ASSERT(!checkLine(RECORDER_SCHEMA, "LOG_ENABLED=2").ok() && !checkLine(RECORDER_SCHEMA, "LOG_ENABLED=maybe").ok(), "anything else");
}

TEST(alarm_level_is_low_or_high) {
    TEST_ASSERT(valueOf(checkLine(RECORDER_SCHEMA, "ALARM_ACTIVE=low"), "ALARM_ACTIVE") == "LOW", "case-insensitive");
    TEST_ASSERT(valueOf(checkLine(RECORDER_SCHEMA, "ALARM_ACTIVE=HIGH"), "ALARM_ACTIVE") == "HIGH", "HIGH");
    TEST_ASSERT(valueOf(checkLine(RECORDER_SCHEMA, "ALARM_ACTIVE=0"), "ALARM_ACTIVE") == "LOW", "0 is LOW");
    TEST_ASSERT(valueOf(checkLine(RECORDER_SCHEMA, "ALARM_ACTIVE=1"), "ALARM_ACTIVE") == "HIGH", "1 is HIGH");
    TEST_ASSERT(!checkLine(RECORDER_SCHEMA, "ALARM_ACTIVE=maybe").ok(), "anything else");
}

TEST(gpio_pins_must_be_ones_the_board_leaves_free) {
    const long long free[] = { 2, 4, 13, 14, 15 };
    for (size_t i = 0; i < 5; ++i) TEST_ASSERT(isUsableGpio(free[i]), "free pin");
    const long long taken[] = { 0, 1, 3, 5, 6, 11, 12, 16, 18, 19, 21, 22, 23, 25, 26, 27, 32, 33, 34, 35, 36, 39, 40, -1, 99 };
    for (size_t i = 0; i < sizeof(taken) / sizeof(taken[0]); ++i) TEST_ASSERT(!isUsableGpio(taken[i]), "reserved or missing pin");

    TEST_ASSERT(checkLine(RECORDER_SCHEMA, "ALARM_GPIO_PIN=13").ok(), "13 is fine");
    TEST_ASSERT(valueOf(checkLine(RECORDER_SCHEMA, "ALARM_GPIO_PIN=-1"), "ALARM_GPIO_PIN") == "-1", "-1 switches the alarm off");
    CheckedLine c = checkLine(RECORDER_SCHEMA, "ALARM_GPIO_PIN=12");
    TEST_ASSERT(anyError(c, "GPIO 12 can't be used") && anyError(c, "or -1 for off"), "the message names the pin and the way out");
    TEST_ASSERT(!checkLine(RECORDER_SCHEMA, "ALARM_GPIO_PIN=abc").ok(), "not a number");
}

TEST(push_gap_multiplier_is_a_number_in_range) {
    TEST_ASSERT(valueOf(checkLine(RECORDER_SCHEMA, "PUSH_GAP_MUL=1.5"), "PUSH_GAP_MUL") == "1.5", "typical");
    TEST_ASSERT(checkLine(RECORDER_SCHEMA, "PUSH_GAP_MUL=0.1").ok() && checkLine(RECORDER_SCHEMA, "PUSH_GAP_MUL=10").ok(), "limits");
    TEST_ASSERT(!checkLine(RECORDER_SCHEMA, "PUSH_GAP_MUL=0").ok() && !checkLine(RECORDER_SCHEMA, "PUSH_GAP_MUL=10.1").ok(), "outside");
    TEST_ASSERT(!checkLine(RECORDER_SCHEMA, "PUSH_GAP_MUL=fast").ok() && !checkLine(RECORDER_SCHEMA, "PUSH_GAP_MUL=nan").ok(), "not numbers");
}

TEST(control_characters_are_refused_in_every_value) {
    TEST_ASSERT(!checkLine(RECORDER_SCHEMA, "CAMERA_ID=a\x01" "b").ok(), "control character");
    TEST_ASSERT(anyError(checkLine(RECORDER_SCHEMA, "API_KEY=a\x7f" "b"), "control"), "DEL");
}

TEST(unknown_and_repeated_settings_are_errors) {
    CheckedLine c = checkLine(RECORDER_SCHEMA, "NOPE=1");
    TEST_ASSERT(!c.ok() && anyError(c, "unknown setting NOPE") && anyError(c, "HELP"), "unknown, pointing at HELP");
    c = checkLine(RECORDER_SCHEMA, "camera_id=a;CAMERA_ID=b");
    TEST_ASSERT(!c.ok() && anyError(c, "CAMERA_ID is given twice"), "the same key twice (any case)");
}

TEST(a_bad_line_reports_every_problem_and_yields_nothing_to_store) {
    CheckedLine c = checkLine(RECORDER_SCHEMA, "CAMERA_ID=cam2;PUSH_PORT=99999;HTTP_PORT=x;NOPE=1;justtext");
    TEST_ASSERT(!c.ok(), "rejected");
    TEST_ASSERT(c.errors.size() == 4, "all four problems are reported, not just the first");
    TEST_ASSERT(anyError(c, "PUSH_PORT") && anyError(c, "HTTP_PORT") && anyError(c, "NOPE") && anyError(c, "justtext"), "naming each");
}

TEST(error_messages_never_contain_the_secret_value) {
    CheckedLine c = checkLine(RECORDER_SCHEMA, "WIFI=home:tooshrt");
    TEST_ASSERT(!c.ok() && !anyError(c, "tooshrt"), "a bad Wi-Fi password is not echoed");
    c = checkLine(RECORDER_SCHEMA, "API_KEY=" + std::string(200, 'k'));
    TEST_ASSERT(!c.ok() && !anyError(c, "kkkk"), "a bad key is not echoed");
}

// ── what is missing? ────────────────────────────────────────────────────

static bool listed(const std::vector<Problem>& ps, const char* key, bool missing) {
    for (size_t i = 0; i < ps.size(); ++i) if (ps[i].key == key) return ps[i].missing == missing;
    return false;
}
static bool notListed(const std::vector<Problem>& ps, const char* key) {
    for (size_t i = 0; i < ps.size(); ++i) if (ps[i].key == key) return false;
    return true;
}

TEST(a_blank_board_is_missing_every_setting_and_the_flash_is_only_read_where_a_value_exists) {
    MemoryStore st;
    std::vector<Problem> ps = findProblems(RECORDER_SCHEMA, st);
    TEST_ASSERT_EQ((int)ps.size(), (int)RECORDER_SCHEMA.count, "everything is listed (switches are unset, so their dependents are needed)");
    TEST_ASSERT(listed(ps, "WIFI", true) && listed(ps, "LOG_HEARTBEAT", true) && listed(ps, "ALARM_ACTIVE", true), "including dependents");
    TEST_ASSERT_EQ(st.badGets, 0, "get() was never called for a key that isn't there");
}

TEST(a_complete_store_has_no_problems) {
    MemoryStore st;
    TEST_ASSERT(store(st, TYPICAL), "the typical line is valid");
    TEST_ASSERT(findProblems(RECORDER_SCHEMA, st).empty(), "nothing missing");
    TEST_ASSERT_EQ(st.badGets, 0, "no get() of an absent key");
}

TEST(switching_remote_logging_off_removes_its_settings_from_the_requirements) {
    MemoryStore st;
    TEST_ASSERT(store(st, "WIFI=home:password1;SERVER_HOST=h;PUSH_PORT=1;HTTP_PORT=2;CAMERA_ID=c;API_KEY=k;PUSH_GAP_MUL=1.5;"
                          "ALARM_GPIO_PIN=-1;LOG_ENABLED=0"), "stored");
    std::vector<Problem> ps = findProblems(RECORDER_SCHEMA, st);
    TEST_ASSERT(ps.empty(), "LOG_* and ALARM_* are not needed with LOG_ENABLED=0 and ALARM_GPIO_PIN=-1");
    TEST_ASSERT_EQ(st.badGets, 0, "still no read of an absent key");
}

TEST(switching_a_feature_on_makes_its_settings_required_again) {
    MemoryStore st;
    store(st, "WIFI=home:password1;SERVER_HOST=h;PUSH_PORT=1;HTTP_PORT=2;CAMERA_ID=c;API_KEY=k;PUSH_GAP_MUL=1.5;"
              "ALARM_GPIO_PIN=-1;LOG_ENABLED=0");
    TEST_ASSERT(findProblems(RECORDER_SCHEMA, st).empty(), "complete");
    store(st, "LOG_ENABLED=1;ALARM_GPIO_PIN=13");
    std::vector<Problem> ps = findProblems(RECORDER_SCHEMA, st);
    TEST_ASSERT(listed(ps, "LOG_MIN_LEVEL", true) && listed(ps, "LOG_LOW_HEAP", true), "the LOG_* settings are missing now");
    TEST_ASSERT(listed(ps, "ALARM_ACTIVE", true) && listed(ps, "ALARM_ALL_CAMS", true), "so are the alarm ones");
    TEST_ASSERT(notListed(ps, "WIFI") && notListed(ps, "CAMERA_ID"), "and nothing else");
    TEST_ASSERT_EQ((int)ps.size(), 2 + 8, "exactly 2 alarm + 8 log settings");
}

TEST(a_new_firmware_that_adds_a_setting_only_asks_for_that_one) {
    MemoryStore st;
    store(st, TYPICAL);
    st.m.erase("LOG_LOW_HEAP");   // as if this key had just been introduced
    std::vector<Problem> ps = findProblems(RECORDER_SCHEMA, st);
    TEST_ASSERT(ps.size() == 1 && listed(ps, "LOG_LOW_HEAP", true), "only the new one");
}

TEST(a_stored_value_that_is_no_longer_valid_is_a_problem_not_a_crash) {
    MemoryStore st;
    store(st, TYPICAL);
    st.m["PUSH_PORT"] = "abc";
    st.m["WIFI"] = "just-one-field";
    std::vector<Problem> ps = findProblems(RECORDER_SCHEMA, st);
    TEST_ASSERT(listed(ps, "PUSH_PORT", false) && listed(ps, "WIFI", false), "reported as invalid, not missing");
    TEST_ASSERT(ps.size() == 2 && (has(ps[0].reason, "whole number") || has(ps[1].reason, "whole number")), "with the reason");
}

TEST(a_stored_value_with_special_characters_is_still_valid_when_read_back) {
    MemoryStore st;
    TEST_ASSERT(store(st, "API_KEY=a\\;b\\\\c;CAMERA_ID=cam2"), "stored");
    TEST_ASSERT(st.m["API_KEY"] == "a;b\\c", "stored decoded");
    std::string err;
    const KeyDef* def = findKey(RECORDER_SCHEMA, "API_KEY");
    TEST_ASSERT(def && validateStored(*def, st.m["API_KEY"], err), "still valid when re-checked");
}

// ── showing settings ────────────────────────────────────────────────────

TEST(unset_required_settings_say_so_and_unused_ones_say_that) {
    MemoryStore st;
    TEST_ASSERT(renderSetting(*findKey(RECORDER_SCHEMA, "CAMERA_ID"), st, true) == "CAMERA_ID=<not set>   <-- required", "required");
    store(st, "LOG_ENABLED=0;ALARM_GPIO_PIN=-1");
    std::string line = renderSetting(*findKey(RECORDER_SCHEMA, "LOG_ECHO"), st, true);
    TEST_ASSERT(line == "LOG_ECHO=<not set>   (not used)", line.c_str());
    store(st, "LOG_ENABLED=1");
    TEST_ASSERT(has(renderSetting(*findKey(RECORDER_SCHEMA, "LOG_ECHO"), st, true), "<-- required"), "required again");
}

TEST(secrets_are_masked_when_shown_but_not_in_the_unmasked_view) {
    MemoryStore st;
    store(st, "API_KEY=topsecret;WIFI=home:password1:guest:;CAMERA_ID=cam2");
    std::string key = renderSetting(*findKey(RECORDER_SCHEMA, "API_KEY"), st, true);
    TEST_ASSERT(key == "API_KEY=********", key.c_str());
    std::string wifi = renderSetting(*findKey(RECORDER_SCHEMA, "WIFI"), st, true);
    TEST_ASSERT(wifi == "WIFI=home:****:guest:(open)", wifi.c_str());
    TEST_ASSERT(renderSetting(*findKey(RECORDER_SCHEMA, "CAMERA_ID"), st, true) == "CAMERA_ID=cam2", "ordinary values are shown");
    TEST_ASSERT(renderSetting(*findKey(RECORDER_SCHEMA, "API_KEY"), st, false) == "API_KEY=topsecret", "unmasked");
    TEST_ASSERT(has(renderSetting(*findKey(RECORDER_SCHEMA, "WIFI"), st, false), "password1"), "unmasked wifi");
    std::vector<std::string> all = renderAll(RECORDER_SCHEMA, st, true);
    bool leaked = false;
    for (size_t i = 0; i < all.size(); ++i) if (has(all[i], "topsecret") || has(all[i], "password1")) leaked = true;
    TEST_ASSERT(!leaked, "the masked listing contains no secret anywhere");
    TEST_ASSERT_EQ((int)all.size(), (int)RECORDER_SCHEMA.count, "one line per setting");
}

TEST(a_wifi_name_with_a_colon_is_shown_escaped_so_the_listing_is_unambiguous) {
    MemoryStore st;
    store(st, "WIFI=my\\:net:password1");
    TEST_ASSERT(renderSetting(*findKey(RECORDER_SCHEMA, "WIFI"), st, true) == "WIFI=my\\:net:****", "escaped");
}

TEST(an_invalid_stored_value_is_flagged_in_the_listing) {
    MemoryStore st;
    st.m["PUSH_PORT"] = "abc";
    std::string line = renderSetting(*findKey(RECORDER_SCHEMA, "PUSH_PORT"), st, true);
    TEST_ASSERT(has(line, "PUSH_PORT=abc") && has(line, "INVALID"), line.c_str());
    st.m["WIFI"] = "garbage";
    TEST_ASSERT(has(renderSetting(*findKey(RECORDER_SCHEMA, "WIFI"), st, true), "<unreadable>"), "an unparseable wifi list is not dumped");
}

TEST(export_makes_one_line_that_recreates_the_same_settings_on_another_board) {
    MemoryStore a;
    TEST_ASSERT(store(a, TYPICAL), "stored");
    TEST_ASSERT(store(a, "API_KEY=we\\;ird\\\\key"), "a key with ; and \\");
    std::string line = renderExport(RECORDER_SCHEMA, a);
    MemoryStore b;
    CheckedLine c = checkLine(RECORDER_SCHEMA, line);
    TEST_ASSERT(c.ok(), "the exported line is itself valid input");
    for (size_t i = 0; i < c.pairs.size(); ++i) b.set(c.pairs[i].key, c.pairs[i].value);
    TEST_ASSERT(a.m == b.m, "the second board ends up with identical settings, special characters included");
    TEST_ASSERT(has(line, "API_KEY=we\\;ird\\\\key"), "escaped in the line");
    TEST_ASSERT(has(line, "extender-2:pass\\;word2"), "the wifi password's ; is escaped");
}

TEST(export_of_an_empty_store_is_empty_and_skips_unset_settings) {
    MemoryStore st;
    TEST_ASSERT(renderExport(RECORDER_SCHEMA, st).empty(), "nothing stored, nothing exported");
    store(st, "CAMERA_ID=cam2");
    TEST_ASSERT(renderExport(RECORDER_SCHEMA, st) == "CAMERA_ID=cam2", "only what is set");
}

TEST(describeKey_gives_what_it_is_what_to_type_and_when_it_applies) {
    std::string d = describeKey(*findKey(RECORDER_SCHEMA, "LOG_ECHO"));
    TEST_ASSERT(has(d, "LOG_ECHO - ") && has(d, "1 or 0") && has(d, "only needed when LOG_ENABLED is 1"), d.c_str());
    d = describeKey(*findKey(RECORDER_SCHEMA, "ALARM_ACTIVE"));
    TEST_ASSERT(has(d, "only needed when ALARM_GPIO_PIN is not -1") && has(d, "LOW or HIGH"), d.c_str());
    d = describeKey(*findKey(RECORDER_SCHEMA, "PUSH_PORT"));
    TEST_ASSERT(has(d, "whole number 1 to 65535") && !has(d, "only needed"), d.c_str());
    for (size_t i = 0; i < RECORDER_SCHEMA.count; ++i) TEST_ASSERT(!describeKey(RECORDER_SCHEMA.keys[i]).empty() && !kindText(RECORDER_SCHEMA.keys[i]).empty(), "every key describes itself");
}

// ── commands ────────────────────────────────────────────────────────────

TEST(commands_are_recognised_in_any_case) {
    TEST_ASSERT(parseCommand("help").cmd == Command::Help && parseCommand("?").cmd == Command::Help, "help");
    TEST_ASSERT(parseCommand("  Show ").cmd == Command::Show, "show");
    ParsedCommand sk = parseCommand("show camera_id");
    TEST_ASSERT(sk.cmd == Command::ShowKey && sk.arg == "CAMERA_ID", "show <key>");
    TEST_ASSERT(parseCommand("export").cmd == Command::Export, "export");
    TEST_ASSERT(parseCommand("ERASE").cmd == Command::Erase, "erase");
    TEST_ASSERT(parseCommand("exit").cmd == Command::Exit && parseCommand("quit").cmd == Command::Exit && parseCommand("done").cmd == Command::Exit, "exit words");
    TEST_ASSERT(parseCommand("").cmd == Command::None && parseCommand("   ").cmd == Command::None, "blank");
    ParsedCommand u = parseCommand("reboot now");
    TEST_ASSERT(u.cmd == Command::Unknown && u.arg == "reboot now", "unknown");
}

// ── kinds the Recorder doesn't use but other sketches' schemas will ─────

TEST(text_and_plain_pin_kinds_validate_too) {
    static const KeyDef keys[] = {
        { "NOTE", Kind::Text, 0, 0, Cond::Always, nullptr, nullptr, "free text" },
        { "OUT_PIN", Kind::Pin, 0, 0, Cond::Always, nullptr, nullptr, "an output pin" },
    };
    Schema toy = { keys, 2, nullptr };
    CheckedLine c = checkLine(toy, "NOTE=hello world;OUT_PIN=13");
    TEST_ASSERT(c.ok() && valueOf(c, "NOTE") == "hello world" && valueOf(c, "OUT_PIN") == "13", "valid values");
    TEST_ASSERT(anyError(checkLine(toy, "NOTE="), "must not be empty"), "text may not be empty");
    CheckedLine bad = checkLine(toy, "OUT_PIN=-1");
    TEST_ASSERT(anyError(bad, "GPIO -1 can't be used") && !anyError(bad, "or -1 for off"), "a plain pin has no 'off' value");
    TEST_ASSERT(kindText(keys[0]) == "text" && kindText(keys[1]) == "GPIO 2, 4, 13, 14 or 15", "described");
}

// ── rules that span several settings ────────────────────────────────────

// Toy schema: LOW_V must not be higher than HIGH_V (like CLEAR_THRESH / DETECT_THRESH).
static bool lowNotAboveHigh(const IValues& v, std::string& err) {
    std::string lo, hi;
    if (!v.get("LOW_V", lo) || !v.get("HIGH_V", hi)) return true;   // not both known yet
    long long l = 0, h = 0;
    if (!parseInt(lo, l) || !parseInt(hi, h)) return true;
    if (l > h) { err = "LOW_V (" + lo + ") must not be higher than HIGH_V (" + hi + ")"; return false; }
    return true;
}
static const KeyDef TOY_KEYS[] = {
    { "HIGH_V", Kind::Int, 1, 100, Cond::Always, nullptr, nullptr, "upper value" },
    { "LOW_V",  Kind::Int, 1, 100, Cond::Always, nullptr, nullptr, "lower value" },
};
static const Schema TOY_RULE_SCHEMA = { TOY_KEYS, 2, lowNotAboveHigh };

static std::vector<std::string> crossErrors(MemoryStore& st, const std::string& line) {
    CheckedLine c = checkLine(TOY_RULE_SCHEMA, line);
    checkCrossRules(TOY_RULE_SCHEMA, st, c.pairs, c.errors);
    return c.errors;
}

TEST(a_rule_over_several_settings_judges_the_line_together_with_what_is_stored) {
    MemoryStore st;
    TEST_ASSERT(crossErrors(st, "HIGH_V=10;LOW_V=5").empty(), "both in one line, consistent");
    TEST_ASSERT(crossErrors(st, "HIGH_V=5;LOW_V=10").size() == 1, "both in one line, inconsistent: refused");
    TEST_ASSERT(crossErrors(st, "LOW_V=50").empty(), "one setting alone: the other isn't known yet, so no complaint");
    st.m["HIGH_V"] = "20"; st.m["LOW_V"] = "10";
    TEST_ASSERT(crossErrors(st, "LOW_V=15").empty(), "a change that keeps the rule is fine");
    std::vector<std::string> e = crossErrors(st, "LOW_V=30");
    TEST_ASSERT(e.size() == 1 && has(e[0], "LOW_V (30) must not be higher than HIGH_V (20)"), "against the STORED other value");
    TEST_ASSERT(crossErrors(st, "HIGH_V=5").size() == 1, "lowering the other one breaks it too");
    TEST_ASSERT(crossErrors(st, "HIGH_V=40;LOW_V=30").empty(), "a rule broken by one can be fixed by sending both together");
    TEST_ASSERT(crossErrors(st, "HIGH_V=5;LOW_V=3").empty(), "even when each alone would clash with what is stored");
    TEST_ASSERT_EQ(st.badGets, 0, "never read an absent key");
}

TEST(the_rule_is_not_asked_about_lines_that_already_have_errors_and_a_schema_without_one_is_fine) {
    MemoryStore st;
    CheckedLine c = checkLine(TOY_RULE_SCHEMA, "HIGH_V=abc;LOW_V=5");
    TEST_ASSERT(!c.ok() && c.errors.size() == 1, "just the ordinary error");
    CheckedLine ok = checkLine(RECORDER_SCHEMA, "CAMERA_ID=cam2");
    checkCrossRules(RECORDER_SCHEMA, st, ok.pairs, ok.errors);
    TEST_ASSERT(ok.ok(), "no rule, no complaint");
}

TEST(the_boot_conversation_refuses_a_line_that_breaks_a_rule_and_stores_nothing) {
    MemoryStore st;
    ScriptConsole con;
    BootConfigFlow flow(TOY_RULE_SCHEMA, st, con, 5000);
    con.in = "HIGH_V=5;LOW_V=10\n";
    BootConfigFlow::Status s = BootConfigFlow::Running;
    for (uint32_t t = 0; t < 100 && s == BootConfigFlow::Running; t += 10) s = flow.step(1000 + t);
    TEST_ASSERT(s == BootConfigFlow::Running && st.m.empty(), "refused, nothing stored");
    TEST_ASSERT(con.said("ERROR: LOW_V (10) must not be higher than HIGH_V (5)") && con.said("Nothing was stored"), "and says why");
    con.in += "HIGH_V=10;LOW_V=5\n";
    for (uint32_t t = 100; t < 200 && s == BootConfigFlow::Running; t += 10) s = flow.step(1000 + t);
    TEST_ASSERT(s == BootConfigFlow::Restart && st.m["HIGH_V"] == "10" && st.m["LOW_V"] == "5", "the corrected line is stored and completes the set");
}

// ── the schema itself ───────────────────────────────────────────────────

TEST(the_recorder_schema_is_consistent) {
    for (size_t i = 0; i < RECORDER_SCHEMA.count; ++i) {
        const KeyDef& d = RECORDER_SCHEMA.keys[i];
        std::string name = d.name;
        TEST_ASSERT(name.size() >= 1 && name.size() <= NVS_KEY_MAX_LENGTH, (name + ": flash keys are at most 15 characters").c_str());
        bool chars = true;
        for (size_t k = 0; k < name.size(); ++k) if (!isKeyChar(name[k])) chars = false;
        TEST_ASSERT(chars, (name + ": only A-Z 0-9 _").c_str());
        for (size_t j = 0; j < i; ++j) TEST_ASSERT(name != RECORDER_SCHEMA.keys[j].name, (name + ": names are unique").c_str());
        TEST_ASSERT(d.help && d.help[0], (name + ": has help text").c_str());
        if (d.kind == Kind::Int || d.kind == Kind::Float) TEST_ASSERT(d.min < d.max, (name + ": range is sane").c_str());
        if (d.cond == Cond::Always) {
            TEST_ASSERT(d.condKey == nullptr, (name + ": no controller").c_str());
        } else {
            const KeyDef* ctl = d.condKey ? findKey(RECORDER_SCHEMA, d.condKey) : nullptr;
            TEST_ASSERT(ctl != nullptr && d.condValue != nullptr, (name + ": its controlling setting exists").c_str());
            TEST_ASSERT(ctl && ctl->cond == Cond::Always, (name + ": the controller is itself always required (no chains)").c_str());
            // the condition value must be something the controller can actually store
            std::string norm, err;
            TEST_ASSERT(ctl && validateValue(*ctl, d.condValue, norm, err) && norm == d.condValue, (name + ": condition value is canonical").c_str());
        }
    }
    TEST_ASSERT(findKey(RECORDER_SCHEMA, "CAMERA_ID") != nullptr && findKey(RECORDER_SCHEMA, "camera_id") == nullptr, "lookup is on the upper-case name");
}

TEST(the_typical_line_covers_every_recorder_setting) {
    CheckedLine c = checkLine(RECORDER_SCHEMA, TYPICAL);
    TEST_ASSERT(c.ok(), "valid");
    TEST_ASSERT_EQ((int)c.pairs.size(), (int)RECORDER_SCHEMA.count, "one value for every setting in the table");
}

TEST(the_committed_example_template_is_a_valid_complete_configuration) {
    std::string here = __FILE__;                                   // .../tests/cpp/test_settings_logic.cpp
    std::string dir = here.substr(0, here.find_last_of("/\\") + 1);
    std::ifstream f(dir + "../../Arduino/templates/example.recorder.template.txt");
    std::string line;
    TEST_ASSERT(static_cast<bool>(std::getline(f, line)), "the template file can be read");
    CheckedLine c = checkLine(RECORDER_SCHEMA, line);
    for (size_t i = 0; i < c.errors.size(); ++i) TEST_ASSERT(false, c.errors[i].c_str());
    TEST_ASSERT(c.ok(), "it is valid input");
    TEST_ASSERT_EQ((int)c.pairs.size(), (int)RECORDER_SCHEMA.count, "and covers every setting");
}

// ── typed settings ──────────────────────────────────────────────────────

TEST(settings_load_into_typed_fields) {
    MemoryStore st;
    store(st, TYPICAL);
    RecorderSettings s;
    std::string err;
    TEST_ASSERT(loadRecorderSettings(st, s, err), err.c_str());
    TEST_ASSERT(s.wifi.size() == 2 && s.wifi[0].ssid == "extender-1" && s.wifi[1].pass == "pass;word2", "wifi list, decoded");
    TEST_ASSERT(s.serverHost == "192.168.4.9" && s.pushPort == 8081 && s.httpPort == 8080, "relay");
    TEST_ASSERT(s.cameraId == "cam2" && s.apiKey == "s3cret", "identity");
    TEST_ASSERT(s.pushGapMul == 1.5f, "gap multiplier");
    TEST_ASSERT(s.alarmGpioPin == 13 && !s.alarmActiveHigh && !s.alarmRecordAll, "alarm");
    TEST_ASSERT(s.logEnabled && s.logMinLevel == 1 && s.logEcho && s.logRetryMax == 3, "log switches");
    TEST_ASSERT(s.logRetrySec == 300 && s.logFlushSec == 10 && s.logRepeatSec == 30 && s.logHeartbeatSec == 600 && s.logLowHeapBytes == 30000, "log timing");
    TEST_ASSERT_EQ(st.badGets, 0, "no read of an absent key");
}

TEST(alarm_level_and_scope_are_read_when_the_alarm_is_on) {
    MemoryStore st;
    store(st, TYPICAL);
    store(st, "ALARM_ACTIVE=HIGH;ALARM_ALL_CAMS=1;LOG_ECHO=0");
    RecorderSettings s;
    std::string err;
    TEST_ASSERT(loadRecorderSettings(st, s, err), err.c_str());
    TEST_ASSERT(s.alarmActiveHigh && s.alarmRecordAll && !s.logEcho, "HIGH, all cameras, echo off");
}

TEST(features_that_are_off_load_as_neutral_values) {
    MemoryStore st;
    store(st, "WIFI=home:password1;SERVER_HOST=h;PUSH_PORT=1;HTTP_PORT=2;CAMERA_ID=c;API_KEY=k;PUSH_GAP_MUL=2;"
              "ALARM_GPIO_PIN=-1;LOG_ENABLED=0");
    RecorderSettings s;
    std::string err;
    TEST_ASSERT(loadRecorderSettings(st, s, err), err.c_str());
    TEST_ASSERT(s.alarmGpioPin == -1 && !s.alarmRecordAll, "alarm off");
    TEST_ASSERT(!s.logEnabled, "remote logging off");
    TEST_ASSERT(s.logHeartbeatSec == 600 && s.logLowHeapBytes == 30000, "heartbeat and low-heap warning keep sensible values (the sketch still uses them for serial)");
    TEST_ASSERT_EQ(st.badGets, 0, "no read of an absent key");
}

TEST(loading_refuses_missing_or_invalid_settings_and_says_which) {
    MemoryStore st;
    RecorderSettings s;
    std::string err;
    TEST_ASSERT(!loadRecorderSettings(st, s, err) && has(err, "WIFI is not set"), "blank board");
    store(st, TYPICAL);
    st.m["HTTP_PORT"] = "nope";
    TEST_ASSERT(!loadRecorderSettings(st, s, err) && has(err, "HTTP_PORT is invalid") && has(err, "whole number"), "invalid value");
}

// ── the start-up conversation ───────────────────────────────────────────

struct Rig {
    MemoryStore st;
    ScriptConsole con;
    BootConfigFlow flow;
    uint32_t now;
    explicit Rig(uint32_t start = 1000) : flow(RECORDER_SCHEMA, st, con, 5000), now(start) {}

    // Steps every 10 ms until the flow stops or `ms` have passed.
    BootConfigFlow::Status run(uint32_t ms = 20) {
        BootConfigFlow::Status s = BootConfigFlow::Running;
        for (uint32_t t = 0; t <= ms; t += 10) {
            s = flow.step(now);
            if (s != BootConfigFlow::Running) return s;
            now += 10;
        }
        return s;
    }
    BootConfigFlow::Status send(const std::string& text, uint32_t ms = 50) { con.in += text; return run(ms); }
};

TEST(boot_always_shows_the_current_settings_first_with_secrets_masked) {
    Rig r;
    store(r.st, TYPICAL);
    r.run(10);
    TEST_ASSERT(r.con.said("---- settings ----"), "header");
    TEST_ASSERT(r.con.said("CAMERA_ID=cam2") && r.con.said("PUSH_PORT=8081"), "values");
    TEST_ASSERT(r.con.said("API_KEY=********") && r.con.said("WIFI=extender-1:****:extender-2:****"), "masked");
    TEST_ASSERT(!r.con.said("s3cret") && !r.con.said("password1"), "no secret on the serial port");
}

TEST(a_blank_board_lists_what_is_missing_and_waits_for_ever) {
    Rig r;
    BootConfigFlow::Status s = r.run(60000);   // a minute of silence
    TEST_ASSERT(s == BootConfigFlow::Running, "no timeout when settings are missing: it waits for the user");
    TEST_ASSERT(r.con.said("These settings need a value (" + std::to_string(RECORDER_SCHEMA.count) + ")"), "says how many");
    TEST_ASSERT(r.con.said("WIFI - ") && r.con.said("CAMERA_ID - ") && r.con.said("LOG_LOW_HEAP - "), "lists them with their help");
    TEST_ASSERT(r.con.said("KEY=value, several at once separated by ;"), "explains the format");
    TEST_ASSERT(!r.con.said("Change settings?"), "does not offer the y/N window");
}

TEST(a_whole_configuration_in_one_line_is_stored_and_the_board_restarts) {
    Rig r;
    BootConfigFlow::Status s = r.send(std::string(TYPICAL) + "\n");
    TEST_ASSERT(s == BootConfigFlow::Restart, "restart requested");
    TEST_ASSERT(r.con.said("All settings are stored. Restarting"), "says so");
    TEST_ASSERT(r.st.m.size() == RECORDER_SCHEMA.count, "everything stored");
    TEST_ASSERT(r.st.m["CAMERA_ID"] == "cam2" && r.st.m["WIFI"] == "extender-1:password1:extender-2:pass\\;word2", "with the right values");
    TEST_ASSERT(findProblems(RECORDER_SCHEMA, r.st).empty(), "and nothing is missing any more");
    TEST_ASSERT(!r.con.said("s3cret"), "the stored secret is not echoed back");
}

TEST(a_partial_line_is_stored_and_the_rest_is_asked_for_without_restarting) {
    Rig r;
    BootConfigFlow::Status s = r.send("CAMERA_ID=cam3;SERVER_HOST=pi.local\n");
    TEST_ASSERT(s == BootConfigFlow::Running, "not complete yet, so no restart");
    TEST_ASSERT(r.con.said("Stored 2 of 2:") && r.con.said("  CAMERA_ID=cam3"), "confirms what was stored");
    TEST_ASSERT(r.st.m.size() == 2, "both are in flash already");
    TEST_ASSERT(r.con.said("These settings need a value (" + std::to_string(RECORDER_SCHEMA.count - 2) + ")"), "and all the others are listed");
    r.con.clear();
    s = r.send("WIFI=home:password1;PUSH_PORT=8081;HTTP_PORT=8080;API_KEY=k;PUSH_GAP_MUL=1.5;ALARM_GPIO_PIN=-1;LOG_ENABLED=0\n");
    TEST_ASSERT(s == BootConfigFlow::Restart, "the second line completes it (the switches turned two features off): restart");
}

TEST(an_empty_line_while_settings_are_missing_does_not_finish) {
    Rig r;
    BootConfigFlow::Status s = r.send("\n");
    TEST_ASSERT(s == BootConfigFlow::Running && r.con.said("Not finished yet"), "asked again");
    s = r.send("exit\n");
    TEST_ASSERT(s == BootConfigFlow::Running, "EXIT too");
}

TEST(a_complete_board_asks_and_starts_normally_after_exactly_five_seconds) {
    Rig r(1000);
    store(r.st, TYPICAL);
    BootConfigFlow::Status s = r.flow.step(1000);
    TEST_ASSERT(s == BootConfigFlow::Running && r.con.said("Change settings? [y/N]"), "asks; [y/N] because the default is no");
    s = r.flow.step(1000 + 4999);
    TEST_ASSERT(s == BootConfigFlow::Running, "still waiting at 4999 ms");
    s = r.flow.step(1000 + 5000);
    TEST_ASSERT(s == BootConfigFlow::Proceed, "5000 ms: carry on");
    TEST_ASSERT(r.con.said("No input - starting normally"), "says so");
    TEST_ASSERT(r.flow.step(99999) == BootConfigFlow::Proceed, "and stays finished");
    TEST_ASSERT(!r.flow.changed(), "nothing was changed");
}

TEST(the_five_second_window_is_correct_when_the_clock_wraps_around) {
    uint32_t start = 0xFFFFFFFFu - 2000;   // the clock wraps 2 s into the window
    Rig r(start);
    store(r.st, TYPICAL);
    TEST_ASSERT(r.flow.step(start) == BootConfigFlow::Running, "begins");
    TEST_ASSERT(r.flow.step(start + 4999) == BootConfigFlow::Running, "not early, even though the clock wrapped");
    TEST_ASSERT(r.flow.step(start + 5000) == BootConfigFlow::Proceed, "on time");
}

TEST(typing_anything_but_y_starts_normally_at_once) {
    const char* answers[] = { "n\n", "N\n", "no\n", "\n", "x\n", "yy\n", "settings\n", "\r\n" };
    for (size_t i = 0; i < sizeof(answers) / sizeof(answers[0]); ++i) {
        Rig r;
        store(r.st, TYPICAL);
        r.run(10);
        TEST_ASSERT(r.send(answers[i]) == BootConfigFlow::Proceed, ("answer #" + std::to_string(i) + " starts normally").c_str());
    }
}

TEST(typing_y_opens_settings_mode_and_changes_are_stored_then_restart) {
    Rig r;
    store(r.st, TYPICAL);
    r.run(10);
    TEST_ASSERT(r.send("y\n") == BootConfigFlow::Running && r.con.said("Settings mode"), "y + Enter: settings mode, no time limit");
    TEST_ASSERT(r.run(60000) == BootConfigFlow::Running, "waits as long as it takes");
    TEST_ASSERT(r.send("CAMERA_ID=cam9\n") == BootConfigFlow::Running, "a change does not restart by itself");
    TEST_ASSERT(r.st.m["CAMERA_ID"] == "cam9", "stored at once");
    TEST_ASSERT(r.con.said("Send more changes, or an empty line / EXIT"), "invites more");
    TEST_ASSERT(r.send("PUSH_PORT=9000\n") == BootConfigFlow::Running, "another line");
    TEST_ASSERT(r.send("\n") == BootConfigFlow::Restart && r.con.said("Saved. Restarting"), "an empty line saves and restarts");
    TEST_ASSERT(r.st.m["PUSH_PORT"] == "9000" && r.flow.changed(), "both changes are kept");
}

TEST(yes_also_opens_settings_mode_and_so_does_a_y_typed_without_enter_when_time_runs_out) {
    Rig r;
    store(r.st, TYPICAL);
    r.run(10);
    r.send("YES\n");
    TEST_ASSERT(r.con.said("Settings mode"), "yes");

    Rig r2(1000);
    store(r2.st, TYPICAL);
    r2.flow.step(1000);
    r2.con.in = "y";                                     // the user typed y but not Enter
    TEST_ASSERT(r2.flow.step(1100) == BootConfigFlow::Running && !r2.con.said("Settings mode"), "still waiting for Enter inside the window");
    TEST_ASSERT(r2.flow.step(6000) == BootConfigFlow::Running && r2.con.said("Settings mode"), "at the deadline the y counts");
}

TEST(settings_mode_without_a_change_just_carries_on_booting) {
    Rig r;
    store(r.st, TYPICAL);
    r.run(10);
    r.send("y\n");
    TEST_ASSERT(r.send("\n") == BootConfigFlow::Proceed && r.con.said("No changes"), "no restart needed when nothing changed");
}

TEST(a_bad_line_stores_nothing_and_says_why_and_the_user_can_try_again) {
    Rig r;
    store(r.st, TYPICAL);
    r.run(10);
    r.send("y\n");
    std::map<std::string, std::string> before = r.st.m;
    BootConfigFlow::Status s = r.send("CAMERA_ID=cam9;PUSH_PORT=99999;NOPE=1\n");
    TEST_ASSERT(s == BootConfigFlow::Running, "still waiting");
    TEST_ASSERT(r.st.m == before, "NOTHING was stored, not even the valid CAMERA_ID");
    TEST_ASSERT(r.con.said("ERROR: PUSH_PORT must be") && r.con.said("ERROR: unknown setting NOPE") && r.con.said("Nothing was stored"), "errors listed");
    TEST_ASSERT(r.send("CAMERA_ID=cam9\n") == BootConfigFlow::Running && r.st.m["CAMERA_ID"] == "cam9", "the corrected line works");
}

TEST(a_flash_write_failure_is_reported) {
    Rig r;
    store(r.st, TYPICAL);
    r.run(10);
    r.send("y\n");
    r.st.failWrites = true;
    r.send("CAMERA_ID=cam9\n");
    TEST_ASSERT(r.con.said("ERROR: could not write CAMERA_ID to flash") && r.con.said("Stored 0 of 1"), "said so");
    TEST_ASSERT(r.send("\n") == BootConfigFlow::Proceed, "and nothing changed, so no restart");
}

TEST(a_setting_that_switches_a_feature_on_asks_for_the_new_settings_before_finishing) {
    Rig r;
    store(r.st, "WIFI=home:password1;SERVER_HOST=h;PUSH_PORT=1;HTTP_PORT=2;CAMERA_ID=c;API_KEY=k;PUSH_GAP_MUL=1.5;"
                "ALARM_GPIO_PIN=-1;LOG_ENABLED=0");
    r.run(10);
    r.send("y\n");
    r.send("ALARM_GPIO_PIN=13\n");
    TEST_ASSERT(r.con.said("These settings need a value (2)") && r.con.said("ALARM_ACTIVE - ") && r.con.said("ALARM_ALL_CAMS - "), "the alarm settings are asked for");
    TEST_ASSERT(r.send("\n") == BootConfigFlow::Running && r.con.said("Not finished yet"), "an empty line doesn't finish while they're missing");
    TEST_ASSERT(r.send("ALARM_ACTIVE=LOW;ALARM_ALL_CAMS=0\n") == BootConfigFlow::Running, "complete, but settings mode is still open");
    TEST_ASSERT(r.send("exit\n") == BootConfigFlow::Restart, "EXIT saves and restarts");
}

TEST(windows_line_endings_do_not_create_phantom_empty_lines) {
    Rig r;
    store(r.st, TYPICAL);
    r.run(10);
    r.send("y\r\n");
    TEST_ASSERT(r.con.said("Settings mode"), "y with CRLF");
    TEST_ASSERT(r.send("CAMERA_ID=cam4\r\n") == BootConfigFlow::Running, "a change with CRLF");
    TEST_ASSERT(r.st.m["CAMERA_ID"] == "cam4", "stored");
    TEST_ASSERT(r.con.count("Stored 1 of 1") == 1, "stored exactly once");
    TEST_ASSERT(r.send("PUSH_PORT=9001\r") == BootConfigFlow::Running && r.send("\n") == BootConfigFlow::Running, "CR and LF arriving separately are one line end");
    TEST_ASSERT(r.st.m["PUSH_PORT"] == "9001", "stored");
    TEST_ASSERT(r.send("\r\n") == BootConfigFlow::Restart, "a real empty line then finishes");
}

TEST(a_line_arriving_in_small_pieces_is_assembled) {
    Rig r;
    std::string line = std::string(TYPICAL) + "\n";
    BootConfigFlow::Status s = BootConfigFlow::Running;
    for (size_t i = 0; i < line.size(); i += 7) s = r.send(line.substr(i, 7), 10);
    TEST_ASSERT(s == BootConfigFlow::Restart && r.st.m.size() == RECORDER_SCHEMA.count, "a slow paste works");
}

TEST(backspace_edits_the_line_for_raw_terminals) {
    Rig r;
    store(r.st, TYPICAL);
    r.run(10);
    r.send("y\n");
    r.send("CAMERA_ID=cam8\x08" "9\x7f" "7\n");
    TEST_ASSERT(r.st.m["CAMERA_ID"] == "cam7", "8 deleted by BS, 9 deleted by DEL, 7 typed");
    r.send("\x08\x08\x08" "PUSH_PORT=9002\n");
    TEST_ASSERT(r.st.m["PUSH_PORT"] == "9002", "backspace on an empty line is harmless");
}

TEST(a_line_that_is_too_long_is_refused_without_breaking_the_next_one) {
    Rig r;
    store(r.st, TYPICAL);
    r.run(10);
    r.send("y\n");
    TEST_ASSERT(r.send("CAMERA_ID=" + std::string(MAX_LINE_LENGTH + 50, 'x') + "\n", 100) == BootConfigFlow::Running, "still running");
    TEST_ASSERT(r.con.said("too long") && r.con.said("Nothing was stored"), "refused");
    TEST_ASSERT(r.st.m["CAMERA_ID"] == "cam2", "unchanged");
    r.send("CAMERA_ID=cam5\n");
    TEST_ASSERT(r.st.m["CAMERA_ID"] == "cam5", "the next line is read normally");
}

TEST(help_lists_the_commands_the_format_and_every_setting) {
    Rig r;
    store(r.st, TYPICAL);
    r.run(10);
    r.send("y\n");
    r.con.clear();
    r.send("help\n");
    TEST_ASSERT(r.con.said("KEY1=value1;KEY2=value2") && r.con.said("WIFI=ssid1:password1:ssid2:password2"), "format");
    TEST_ASSERT(r.con.said("A literal ;  :  or \\ inside a value is written \\;  \\:  \\\\"), "escaping");
    TEST_ASSERT(r.con.said("Commands: HELP, SHOW"), "commands");
    for (size_t i = 0; i < RECORDER_SCHEMA.count; ++i) TEST_ASSERT(r.con.said(describeKey(RECORDER_SCHEMA.keys[i])), RECORDER_SCHEMA.keys[i].name);
}

TEST(show_masks_secrets_and_show_key_reveals_one) {
    Rig r;
    store(r.st, TYPICAL);
    r.run(10);
    r.send("y\n");
    r.con.clear();
    r.send("show\n");
    TEST_ASSERT(r.con.said("API_KEY=********") && !r.con.said("s3cret"), "SHOW is masked");
    r.con.clear();
    r.send("show api_key\n");
    TEST_ASSERT(r.con.said("API_KEY=s3cret"), "SHOW <KEY> is not");
    r.con.clear();
    r.send("show wifi\n");
    TEST_ASSERT(r.con.said("WIFI=extender-1:password1:extender-2:pass\\;word2"), "the wifi list, exactly as stored");
    r.con.clear();
    r.send("show nope\n");
    TEST_ASSERT(r.con.said("ERROR: unknown setting NOPE"), "unknown key");
    store(r.st, "WIFI=home:password1");
    r.st.m.erase("API_KEY");
    r.con.clear();
    r.send("show api_key\n");
    TEST_ASSERT(r.con.said("API_KEY=<not set>"), "an unset one");
    TEST_ASSERT_EQ(r.st.badGets, 0, "never read an absent key");
}

TEST(export_prints_a_line_that_can_be_pasted_into_another_camera) {
    Rig r;
    store(r.st, TYPICAL);
    r.run(10);
    r.send("y\n");
    r.con.clear();
    r.send("export\n");
    TEST_ASSERT(r.con.said("CAMERA_ID=cam2;") && r.con.said("API_KEY=s3cret"), "the real values");

    Rig blank;
    blank.run(10);
    blank.con.clear();
    blank.send("export\n");
    TEST_ASSERT(blank.con.said("(nothing is stored yet)"), "nothing to export on a blank board");
}

TEST(unknown_commands_are_reported) {
    Rig r;
    store(r.st, TYPICAL);
    r.run(10);
    r.send("y\n");
    r.send("reboot\n");
    TEST_ASSERT(r.con.said("Unknown command 'reboot'") && r.con.said("HELP"), "pointed at HELP");
}

TEST(erase_needs_confirmation_and_then_asks_for_everything_again) {
    Rig r;
    store(r.st, TYPICAL);
    r.run(10);
    r.send("y\n");
    r.send("erase\n");
    TEST_ASSERT(r.con.said("Type ERASE again to confirm") && r.st.clears == 0, "asks first, deletes nothing");
    r.send("show\n");
    r.send("erase\n");
    TEST_ASSERT(r.st.clears == 0, "another command in between cancelled it: this ERASE only asks again");
    BootConfigFlow::Status s = r.send("ERASE\n");
    TEST_ASSERT(s == BootConfigFlow::Running && r.st.clears == 1 && r.st.m.empty(), "confirmed: everything deleted");
    TEST_ASSERT(r.con.said("All settings erased") && r.con.said("These settings need a value (" + std::to_string(RECORDER_SCHEMA.count) + ")"), "and it asks for everything again");
    TEST_ASSERT(r.send("\n") == BootConfigFlow::Running, "can't leave until complete");
    TEST_ASSERT(r.send(std::string(TYPICAL) + "\n") == BootConfigFlow::Restart, "re-entering everything restarts");
}

TEST(a_setting_line_in_between_also_cancels_a_pending_erase) {
    Rig r;
    store(r.st, TYPICAL);
    r.run(10);
    r.send("y\n");
    r.send("erase\n");
    r.send("CAMERA_ID=cam6\n");
    r.send("erase\n");
    TEST_ASSERT(r.st.clears == 0, "the ERASE after a setting line is a first ERASE again");
}

TEST(a_stored_invalid_value_forces_the_ask_it_again_path_at_boot) {
    Rig r;
    store(r.st, TYPICAL);
    r.st.m["PUSH_PORT"] = "banana";
    TEST_ASSERT(r.run(60000) == BootConfigFlow::Running, "no 5 s window: it must be fixed first");
    TEST_ASSERT(r.con.said("PUSH_PORT=banana   <-- INVALID") && r.con.said("stored value is invalid"), "shown as invalid");
    TEST_ASSERT(r.send("PUSH_PORT=8081\n") == BootConfigFlow::Restart, "fixing it completes the set");
}

TEST(a_blank_store_with_failing_flash_still_reports_instead_of_hanging_silently) {
    Rig r;
    r.st.failWrites = true;
    TEST_ASSERT(r.send(std::string(TYPICAL) + "\n") == BootConfigFlow::Running, "nothing could be stored, so it can't finish");
    TEST_ASSERT(r.con.count("ERROR: could not write") == (int)RECORDER_SCHEMA.count, "each write failure is reported");
}

int main() {
    RUN_TEST(escape_round_trips_the_three_special_characters);
    RUN_TEST(unescape_rejects_unknown_escapes_and_a_lone_backslash);
    RUN_TEST(splitUnescaped_does_not_split_on_escaped_separators);
    RUN_TEST(parseInt_is_strict);
    RUN_TEST(parseFloat_is_strict);
    RUN_TEST(a_line_of_pairs_is_split_on_semicolons_and_the_first_equals_sign);
    RUN_TEST(keys_are_trimmed_and_upper_cased_but_values_are_left_alone);
    RUN_TEST(trailing_semicolon_empty_pieces_and_line_endings_are_tolerated);
    RUN_TEST(an_escaped_semicolon_stays_in_its_value);
    RUN_TEST(syntax_errors_are_reported_with_the_offending_piece);
    RUN_TEST(a_line_over_the_limit_is_refused_whole);
    RUN_TEST(wifi_list_one_three_and_sixteen_networks);
    RUN_TEST(wifi_list_errors);
    RUN_TEST(wifi_open_network_has_an_empty_password);
    RUN_TEST(wifi_passwords_and_names_may_contain_semicolons_colons_and_backslashes);
    RUN_TEST(a_wifi_line_with_an_escaped_semicolon_is_one_setting);
    RUN_TEST(ports_must_be_whole_numbers_from_1_to_65535);
    RUN_TEST(numbers_are_stored_in_canonical_form);
    RUN_TEST(camera_id_charset_and_length);
    RUN_TEST(server_host_is_a_hostname_or_ip);
    RUN_TEST(api_key_must_be_real_and_may_contain_special_characters);
    RUN_TEST(bool_spellings_are_normalised_to_1_and_0);
    RUN_TEST(alarm_level_is_low_or_high);
    RUN_TEST(gpio_pins_must_be_ones_the_board_leaves_free);
    RUN_TEST(push_gap_multiplier_is_a_number_in_range);
    RUN_TEST(control_characters_are_refused_in_every_value);
    RUN_TEST(unknown_and_repeated_settings_are_errors);
    RUN_TEST(a_bad_line_reports_every_problem_and_yields_nothing_to_store);
    RUN_TEST(error_messages_never_contain_the_secret_value);
    RUN_TEST(a_blank_board_is_missing_every_setting_and_the_flash_is_only_read_where_a_value_exists);
    RUN_TEST(a_complete_store_has_no_problems);
    RUN_TEST(switching_remote_logging_off_removes_its_settings_from_the_requirements);
    RUN_TEST(switching_a_feature_on_makes_its_settings_required_again);
    RUN_TEST(a_new_firmware_that_adds_a_setting_only_asks_for_that_one);
    RUN_TEST(a_stored_value_that_is_no_longer_valid_is_a_problem_not_a_crash);
    RUN_TEST(a_stored_value_with_special_characters_is_still_valid_when_read_back);
    RUN_TEST(unset_required_settings_say_so_and_unused_ones_say_that);
    RUN_TEST(secrets_are_masked_when_shown_but_not_in_the_unmasked_view);
    RUN_TEST(a_wifi_name_with_a_colon_is_shown_escaped_so_the_listing_is_unambiguous);
    RUN_TEST(an_invalid_stored_value_is_flagged_in_the_listing);
    RUN_TEST(export_makes_one_line_that_recreates_the_same_settings_on_another_board);
    RUN_TEST(export_of_an_empty_store_is_empty_and_skips_unset_settings);
    RUN_TEST(describeKey_gives_what_it_is_what_to_type_and_when_it_applies);
    RUN_TEST(commands_are_recognised_in_any_case);
    RUN_TEST(text_and_plain_pin_kinds_validate_too);
    RUN_TEST(a_rule_over_several_settings_judges_the_line_together_with_what_is_stored);
    RUN_TEST(the_rule_is_not_asked_about_lines_that_already_have_errors_and_a_schema_without_one_is_fine);
    RUN_TEST(the_boot_conversation_refuses_a_line_that_breaks_a_rule_and_stores_nothing);
    RUN_TEST(the_recorder_schema_is_consistent);
    RUN_TEST(the_typical_line_covers_every_recorder_setting);
    RUN_TEST(the_committed_example_template_is_a_valid_complete_configuration);
    RUN_TEST(settings_load_into_typed_fields);
    RUN_TEST(alarm_level_and_scope_are_read_when_the_alarm_is_on);
    RUN_TEST(features_that_are_off_load_as_neutral_values);
    RUN_TEST(loading_refuses_missing_or_invalid_settings_and_says_which);
    RUN_TEST(boot_always_shows_the_current_settings_first_with_secrets_masked);
    RUN_TEST(a_blank_board_lists_what_is_missing_and_waits_for_ever);
    RUN_TEST(a_whole_configuration_in_one_line_is_stored_and_the_board_restarts);
    RUN_TEST(a_partial_line_is_stored_and_the_rest_is_asked_for_without_restarting);
    RUN_TEST(an_empty_line_while_settings_are_missing_does_not_finish);
    RUN_TEST(a_complete_board_asks_and_starts_normally_after_exactly_five_seconds);
    RUN_TEST(the_five_second_window_is_correct_when_the_clock_wraps_around);
    RUN_TEST(typing_anything_but_y_starts_normally_at_once);
    RUN_TEST(typing_y_opens_settings_mode_and_changes_are_stored_then_restart);
    RUN_TEST(yes_also_opens_settings_mode_and_so_does_a_y_typed_without_enter_when_time_runs_out);
    RUN_TEST(settings_mode_without_a_change_just_carries_on_booting);
    RUN_TEST(a_bad_line_stores_nothing_and_says_why_and_the_user_can_try_again);
    RUN_TEST(a_flash_write_failure_is_reported);
    RUN_TEST(a_setting_that_switches_a_feature_on_asks_for_the_new_settings_before_finishing);
    RUN_TEST(windows_line_endings_do_not_create_phantom_empty_lines);
    RUN_TEST(a_line_arriving_in_small_pieces_is_assembled);
    RUN_TEST(backspace_edits_the_line_for_raw_terminals);
    RUN_TEST(a_line_that_is_too_long_is_refused_without_breaking_the_next_one);
    RUN_TEST(help_lists_the_commands_the_format_and_every_setting);
    RUN_TEST(show_masks_secrets_and_show_key_reveals_one);
    RUN_TEST(export_prints_a_line_that_can_be_pasted_into_another_camera);
    RUN_TEST(unknown_commands_are_reported);
    RUN_TEST(erase_needs_confirmation_and_then_asks_for_everything_again);
    RUN_TEST(a_setting_line_in_between_also_cancels_a_pending_erase);
    RUN_TEST(a_stored_invalid_value_forces_the_ask_it_again_path_at_boot);
    RUN_TEST(a_blank_store_with_failing_flash_still_reports_instead_of_hanging_silently);
    return test::summarize();
}
