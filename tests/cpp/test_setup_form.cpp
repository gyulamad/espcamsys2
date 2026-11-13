// test_setup_form.cpp — the pure helpers of the on-device setup form (setup_form.h): URL decoding,
// the strict form parser, HTML escaping, the constant-time compare, the master password rule and
// the captive-portal probe list. No schema and no board: the request handler itself is tested
// against both sketches' schemas in test_setup_form_recorder.cpp / test_setup_form_person.cpp
// (cases in setup_form_cases.h).
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -Wall -Wextra -o build/test_setup_form test_setup_form.cpp

#include "framework.h"

#include <string>
#include <vector>

#include "../../Arduino/ESP32_CAM_Recorder/setup_form.h"

using namespace esp32cam_setup;

static bool decodes(const std::string& in, const std::string& expected) {
    std::string out, err;
    return urlDecode(in, out, err) && out == expected;
}
static bool refused(const std::string& in) {
    std::string out = "junk", err;
    bool ok = urlDecode(in, out, err);
    return !ok && out.empty() && !err.empty();
}

// ── urlDecode ───────────────────────────────────────────────────────────

TEST(plus_is_a_space_and_percent_escapes_are_decoded) {
    TEST_ASSERT(decodes("", ""), "empty stays empty");
    TEST_ASSERT(decodes("abc", "abc"), "plain text");
    TEST_ASSERT(decodes("a+b", "a b"), "plus is a space");
    TEST_ASSERT(decodes("a%20b", "a b"), "%20");
    TEST_ASSERT(decodes("%41%42%43", "ABC"), "upper-case hex");
    TEST_ASSERT(decodes("%7e%7E", "~~"), "lower and upper-case hex");
    TEST_ASSERT(decodes("%2B", "+"), "an encoded plus is a literal plus");
    TEST_ASSERT(decodes("%25", "%"), "an encoded percent");
    TEST_ASSERT(decodes("%3B%3A%5C", ";:\\"), "the settings line's separators survive");
    TEST_ASSERT(decodes("%C3%A9", "\xC3\xA9"), "UTF-8 bytes pass through unchanged");
    TEST_ASSERT(decodes("100%25+sure", "100% sure"), "mixed");
}

TEST(bad_escapes_are_refused_not_repaired) {
    TEST_ASSERT(refused("%"), "a lone percent");
    TEST_ASSERT(refused("abc%"), "a percent at the end");
    TEST_ASSERT(refused("%4"), "one hex digit");
    TEST_ASSERT(refused("%zz"), "not hex");
    TEST_ASSERT(refused("%g1"), "first digit not hex");
    TEST_ASSERT(refused("%1g"), "second digit not hex");
    TEST_ASSERT(refused("%%41"), "percent percent");
    TEST_ASSERT(refused("a%2"), "cut off in the middle of the text");
}

TEST(a_nul_or_a_raw_control_character_is_refused) {
    TEST_ASSERT(refused("a%00b"), "a decoded NUL");
    TEST_ASSERT(refused(std::string("a") + '\0' + "b"), "a raw NUL");
    TEST_ASSERT(refused("a\nb"), "a raw newline");
    TEST_ASSERT(refused("a\rb"), "a raw carriage return");
    TEST_ASSERT(refused("a\tb"), "a raw tab");
    TEST_ASSERT(refused(std::string("a") + '\x7f'), "a raw DEL");
    TEST_ASSERT(decodes("a%0Ab", "a\nb"), "an ENCODED newline decodes (the settings engine rejects it by name)");
    TEST_ASSERT(decodes("a%09b", "a\tb"), "an encoded tab decodes too");
}

TEST(the_error_never_repeats_the_text) {
    std::string out, err;
    urlDecode("secret-password%zz", out, err);
    TEST_ASSERT(err.find("secret") == std::string::npos, "no value in the message");
}

// ── parseUrlEncoded ─────────────────────────────────────────────────────

static bool parses(const std::string& body, std::vector<FormField>& f) {
    std::string err;
    return parseUrlEncoded(body, f, err);
}
static bool rejects(const std::string& body) {
    std::vector<FormField> f;
    f.push_back(FormField());
    std::string err;
    bool ok = parseUrlEncoded(body, f, err);
    return !ok && f.empty() && !err.empty();
}

TEST(a_form_body_becomes_fields) {
    std::vector<FormField> f;
    TEST_ASSERT(parses("a=1&b=two+words&c=%3B", f), "parsed");
    TEST_ASSERT_EQ(f.size(), (size_t)3, "three fields");
    TEST_ASSERT_EQ(f[0].name, std::string("a"), "name 1");
    TEST_ASSERT_EQ(f[1].value, std::string("two words"), "value decoded");
    TEST_ASSERT_EQ(f[2].value, std::string(";"), "escape decoded");
    TEST_ASSERT(findField(f, "b") && *findField(f, "b") == "two words", "findField");
    TEST_ASSERT(findField(f, "zzz") == nullptr, "findField: not there");
}

TEST(empty_values_equals_signs_and_stray_ampersands) {
    std::vector<FormField> f;
    TEST_ASSERT(parses("a=&b=x%3Dy&&c=3&", f), "parsed");
    TEST_ASSERT_EQ(f.size(), (size_t)3, "empty pieces skipped");
    TEST_ASSERT_EQ(f[0].value, std::string(""), "an empty value is a field with an empty value");
    TEST_ASSERT_EQ(f[1].value, std::string("x=y"), "an encoded '=' stays in the value");
    TEST_ASSERT(parses("", f) && f.empty(), "an empty body has no fields");
    TEST_ASSERT(parses("a=1=2", f) && f.size() == 1 && f[0].value == "1=2", "only the first '=' splits");
}

TEST(malformed_bodies_are_refused_whole) {
    TEST_ASSERT(rejects("a"), "a piece without '='");
    TEST_ASSERT(rejects("a=1&b"), "the second piece has no '='");
    TEST_ASSERT(rejects("=1"), "an empty name");
    TEST_ASSERT(rejects("a b=1"), "a space in a name");
    TEST_ASSERT(rejects("a<b=1"), "a '<' in a name");
    TEST_ASSERT(rejects("a%3Bb=1"), "a ';' in a name");
    TEST_ASSERT(rejects("a=1&a=2"), "a name given twice");
    TEST_ASSERT(rejects("a=1&a=1"), "...even with the same value");
    TEST_ASSERT(rejects("a=%zz"), "a bad escape in a value");
    TEST_ASSERT(rejects("%zz=1"), "a bad escape in a name");
    TEST_ASSERT(rejects("a=%00"), "a NUL in a value");
    TEST_ASSERT(rejects(std::string(MAX_FIELD_NAME + 1, 'n') + "=1"), "a name that is too long");
}

TEST(size_and_field_count_are_capped) {
    std::vector<FormField> f;
    TEST_ASSERT(parses("a=" + std::string(MAX_BODY_BYTES - 2, 'x'), f), "exactly the limit is fine");
    TEST_ASSERT(rejects("a=" + std::string(MAX_BODY_BYTES - 1, 'x')), "one byte over is refused");

    std::string many;
    for (size_t i = 0; i < MAX_FORM_FIELDS; ++i) many += "f" + std::to_string(i) + "=1&";
    TEST_ASSERT(parses(many, f) && f.size() == MAX_FORM_FIELDS, "exactly the field limit is fine");
    TEST_ASSERT(rejects(many + "extra=1"), "one field over is refused");
}

// ── htmlEscape ──────────────────────────────────────────────────────────

TEST(html_escape_covers_markup_and_both_quote_kinds) {
    TEST_ASSERT_EQ(htmlEscape("<script>alert(1)</script>"), std::string("&lt;script&gt;alert(1)&lt;/script&gt;"), "tags");
    TEST_ASSERT_EQ(htmlEscape("\"x\" 'y' & z"), std::string("&quot;x&quot; &#39;y&#39; &amp; z"), "quotes and ampersand");
    TEST_ASSERT_EQ(htmlEscape("&amp;"), std::string("&amp;amp;"), "an existing entity is escaped, not trusted");
    TEST_ASSERT_EQ(htmlEscape("plain text 123"), std::string("plain text 123"), "plain text unchanged");
    TEST_ASSERT_EQ(htmlEscape(std::string("a") + '\0' + "b\nc"), std::string("a b c"), "control characters become spaces");
    TEST_ASSERT_EQ(htmlEscape("\xC3\xA9"), std::string("\xC3\xA9"), "UTF-8 is left alone");
    TEST_ASSERT_EQ(htmlEscape(""), std::string(""), "empty");
}

// ── constantTimeEquals ──────────────────────────────────────────────────

TEST(constant_time_compare_is_an_ordinary_equality) {
    TEST_ASSERT(constantTimeEquals("abc", "abc"), "equal");
    TEST_ASSERT(constantTimeEquals("", ""), "both empty");
    TEST_ASSERT(!constantTimeEquals("abc", "abd"), "last char differs");
    TEST_ASSERT(!constantTimeEquals("abc", "xbc"), "first char differs");
    TEST_ASSERT(!constantTimeEquals("abc", "ab"), "shorter");
    TEST_ASSERT(!constantTimeEquals("ab", "abc"), "longer");
    TEST_ASSERT(!constantTimeEquals("", "a"), "empty vs one");
    TEST_ASSERT(!constantTimeEquals(std::string("ab\0c", 4), std::string("ab\0d", 4)), "differs after a NUL");
    TEST_ASSERT(!constantTimeEquals(std::string("a\0", 2), "a"), "a trailing NUL is a difference");
}

// ── the master password rule ────────────────────────────────────────────

TEST(the_master_password_rule) {
    TEST_ASSERT(masterPasswordProblem("a-good-one-9").empty(), "an ordinary password");
    TEST_ASSERT(masterPasswordProblem("12345678").empty(), "exactly 8");
    TEST_ASSERT(masterPasswordProblem(std::string(63, 'x')).empty(), "exactly 63");
    TEST_ASSERT(masterPasswordProblem("with spaces ok").empty(), "spaces are fine");
    TEST_ASSERT(masterPasswordProblem("p@ss;w:rd\\!").empty(), "separators are fine (the line format escapes them)");
    TEST_ASSERT(!masterPasswordProblem("1234567").empty(), "7 is too short");
    TEST_ASSERT(!masterPasswordProblem("").empty(), "empty");
    TEST_ASSERT(!masterPasswordProblem(std::string(64, 'x')).empty(), "64 is too long for WPA2");
    TEST_ASSERT(!masterPasswordProblem("Admin1234").empty(), "the default itself");
    TEST_ASSERT(masterPasswordProblem("admin1234").empty(), "...but only exactly (case matters to WPA2)");
    TEST_ASSERT(!masterPasswordProblem("pass\xC3\xA9word").empty(), "non-ASCII");
    TEST_ASSERT(!masterPasswordProblem("pass\tword1").empty(), "a control character");
    TEST_ASSERT(!masterPasswordProblem(std::string("pass\0word1", 9)).empty(), "a NUL");
    TEST_ASSERT(masterPasswordProblem("a-good-one-9").find("a-good-one-9") == std::string::npos, "the message never has the password");
    TEST_ASSERT(masterPasswordProblem("Admin1234").find("Admin1234") == std::string::npos, "...not even the default");
}

TEST(the_form_rule_is_exactly_the_setup_logic_rule) {
    // One rule (S2): the form must accept a password iff the setup WiFi could use it AND it is not the public default.
    const char* candidates[] = { "", "1234567", "12345678", "Admin1234", "admin1234", "with space 1", "tab\there1", "caf\xC3\xA9-12345", "x" };
    for (size_t i = 0; i < sizeof(candidates) / sizeof(candidates[0]); ++i) {
        std::string c = candidates[i];
        bool expected = validSetupPassword(c) && !isDefaultSetupPassword(c);
        TEST_ASSERT_EQ(masterPasswordProblem(c).empty(), expected, ("candidate " + std::to_string(i)).c_str());
    }
    TEST_ASSERT(masterPasswordProblem(SETUP_DEFAULT_PASSWORD).find("default") != std::string::npos, "the default is named as such");
}

// ── captive portal probes ───────────────────────────────────────────────

TEST(known_probe_addresses_are_recognised) {
    TEST_ASSERT(isCaptivePortalProbe("/generate_204"), "Android");
    TEST_ASSERT(isCaptivePortalProbe("/gen_204"), "Android (older)");
    TEST_ASSERT(isCaptivePortalProbe("/hotspot-detect.html"), "Apple");
    TEST_ASSERT(isCaptivePortalProbe("/library/test/success.html"), "Apple (older)");
    TEST_ASSERT(isCaptivePortalProbe("/connecttest.txt"), "Windows");
    TEST_ASSERT(isCaptivePortalProbe("/ncsi.txt"), "Windows (older)");
    TEST_ASSERT(isCaptivePortalProbe("/canonical.html"), "Firefox");
    TEST_ASSERT(!isCaptivePortalProbe("/"), "the form itself is not a probe");
    TEST_ASSERT(!isCaptivePortalProbe("/save"), "nor is /save");
    TEST_ASSERT(!isCaptivePortalProbe("/generate_204/x"), "exact match only");
    TEST_ASSERT(!isCaptivePortalProbe(""), "empty");
}

int main() {
    RUN_TEST(plus_is_a_space_and_percent_escapes_are_decoded);
    RUN_TEST(bad_escapes_are_refused_not_repaired);
    RUN_TEST(a_nul_or_a_raw_control_character_is_refused);
    RUN_TEST(the_error_never_repeats_the_text);
    RUN_TEST(a_form_body_becomes_fields);
    RUN_TEST(empty_values_equals_signs_and_stray_ampersands);
    RUN_TEST(malformed_bodies_are_refused_whole);
    RUN_TEST(size_and_field_count_are_capped);
    RUN_TEST(html_escape_covers_markup_and_both_quote_kinds);
    RUN_TEST(constant_time_compare_is_an_ordinary_equality);
    RUN_TEST(the_master_password_rule);
    RUN_TEST(the_form_rule_is_exactly_the_setup_logic_rule);
    RUN_TEST(known_probe_addresses_are_recognised);
    return test::summarize();
}
