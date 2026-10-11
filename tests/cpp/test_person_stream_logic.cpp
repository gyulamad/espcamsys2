// test_person_stream_logic.cpp — unit tests for the person detector's live-view
// logic (Arduino/ESP32_CAM_TFLite_Person/stream_logic.h): who is let in, how a
// request is routed, what is sent to the relay and when.
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -Wall -Wextra -o build/test_person_stream_logic test_person_stream_logic.cpp

#include "framework.h"

#include "../../Arduino/ESP32_CAM_TFLite_Person/stream_logic.h"

using namespace person_stream;

static bool has(const std::string& hay, const std::string& needle) { return hay.find(needle) != std::string::npos; }

// ── credentials ─────────────────────────────────────────────────────────

TEST(credentials_need_a_real_password_and_a_colon_free_user) {
    TEST_ASSERT(credentialsUsable("viewer", "s3cret-pass"), "ordinary credentials are usable");
    TEST_ASSERT(!credentialsUsable("viewer", ""), "empty password refused");
    TEST_ASSERT(!credentialsUsable("viewer", "change-me"), "the template password is refused");
    TEST_ASSERT(!credentialsUsable("", "s3cret-pass"), "empty user refused");
    TEST_ASSERT(!credentialsUsable("vie:wer", "s3cret-pass"), "a ':' in the user name can't be sent in Basic auth");
    TEST_ASSERT(!credentialsUsable(nullptr, "s3cret-pass"), "null user refused");
    TEST_ASSERT(!credentialsUsable("viewer", nullptr), "null password refused");
    TEST_ASSERT(credentialsUsable("viewer", "pass:word"), "a ':' in the password is fine");
}

// ── base64 / Basic auth ─────────────────────────────────────────────────

TEST(base64_matches_the_rfc4648_test_vectors) {
    TEST_ASSERT_EQ(base64Encode(""), std::string(""), "empty");
    TEST_ASSERT_EQ(base64Encode("f"), std::string("Zg=="), "f");
    TEST_ASSERT_EQ(base64Encode("fo"), std::string("Zm8="), "fo");
    TEST_ASSERT_EQ(base64Encode("foo"), std::string("Zm9v"), "foo");
    TEST_ASSERT_EQ(base64Encode("foob"), std::string("Zm9vYg=="), "foob");
    TEST_ASSERT_EQ(base64Encode("fooba"), std::string("Zm9vYmE="), "fooba");
    TEST_ASSERT_EQ(base64Encode("foobar"), std::string("Zm9vYmFy"), "foobar");
}

TEST(base64_handles_high_bytes) {
    TEST_ASSERT_EQ(base64Encode(std::string("\xff\xfe\xfd", 3)), std::string("//79"), "0xfffefd");
}

TEST(expected_auth_header_is_what_a_browser_sends) {
    TEST_ASSERT_EQ(expectedAuthHeader("user", "pass"), std::string("Basic dXNlcjpwYXNz"), "user:pass");
}

TEST(constant_time_equals_compares_content_and_length) {
    TEST_ASSERT(constantTimeEquals("abc", "abc"), "equal");
    TEST_ASSERT(constantTimeEquals("", ""), "both empty");
    TEST_ASSERT(!constantTimeEquals("abc", "abd"), "last char differs");
    TEST_ASSERT(!constantTimeEquals("abc", "xbc"), "first char differs");
    TEST_ASSERT(!constantTimeEquals("abc", "abcd"), "longer is not equal");
    TEST_ASSERT(!constantTimeEquals("abcd", "abc"), "shorter is not equal");
    TEST_ASSERT(!constantTimeEquals("", "a"), "empty vs non-empty");
    TEST_ASSERT(!constantTimeEquals(std::string("a\0b", 3), std::string("a\0c", 3)), "embedded NUL does not end the comparison");
}

// ── parsing ─────────────────────────────────────────────────────────────

TEST(request_head_complete_needs_the_blank_line) {
    TEST_ASSERT(!requestHeadComplete(""), "nothing yet");
    TEST_ASSERT(!requestHeadComplete("GET / HTTP/1.1\r\nHost: x\r\n"), "headers still arriving");
    TEST_ASSERT(requestHeadComplete("GET / HTTP/1.1\r\nHost: x\r\n\r\n"), "CRLF blank line");
    TEST_ASSERT(requestHeadComplete("GET / HTTP/1.1\nHost: x\n\n"), "bare LF blank line");
}

TEST(parse_reads_method_path_and_authorization) {
    Request r = parseRequest("GET /stream HTTP/1.1\r\nHost: 192.168.4.37\r\nAuthorization: Basic abc123\r\n\r\n");
    TEST_ASSERT(r.valid, "valid");
    TEST_ASSERT_EQ(r.method, std::string("GET"), "method");
    TEST_ASSERT_EQ(r.path, std::string("/stream"), "path");
    TEST_ASSERT_EQ(r.authorization, std::string("Basic abc123"), "authorization value");
}

TEST(parse_header_name_is_case_insensitive_and_value_is_trimmed) {
    Request r = parseRequest("GET / HTTP/1.1\r\nauthorization:    Basic xyz  \r\n\r\n");
    TEST_ASSERT_EQ(r.authorization, std::string("Basic xyz  "), "leading blanks trimmed, rest kept exactly");
    Request r2 = parseRequest("GET / HTTP/1.1\r\nAUTHORIZATION: Basic q\r\n\r\n");
    TEST_ASSERT_EQ(r2.authorization, std::string("Basic q"), "upper case name");
}

TEST(parse_drops_the_query_string_from_the_path) {
    Request r = parseRequest("GET /stream?x=1&y=2 HTTP/1.1\r\n\r\n");
    TEST_ASSERT_EQ(r.path, std::string("/stream"), "query removed");
}

TEST(parse_without_authorization_leaves_it_empty) {
    Request r = parseRequest("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
    TEST_ASSERT(r.valid, "valid");
    TEST_ASSERT(r.authorization.empty(), "no credentials");
}

TEST(parse_ignores_an_authorization_header_that_is_in_the_body) {
    Request r = parseRequest("GET / HTTP/1.1\r\nHost: x\r\n\r\nAuthorization: Basic sneaky\r\n");
    TEST_ASSERT(r.authorization.empty(), "only headers count");
}

TEST(parse_rejects_malformed_request_lines) {
    TEST_ASSERT(!parseRequest("").valid, "empty");
    TEST_ASSERT(!parseRequest("GET").valid, "no line end");
    TEST_ASSERT(!parseRequest("GET /\r\n\r\n").valid, "no version");
    TEST_ASSERT(!parseRequest(" / HTTP/1.1\r\n\r\n").valid, "no method");
    TEST_ASSERT(!parseRequest("GET stream HTTP/1.1\r\n\r\n").valid, "target must start with '/'");
    TEST_ASSERT(!parseRequest("GET  HTTP/1.1\r\n\r\n").valid, "empty target");
}

// ── routing ─────────────────────────────────────────────────────────────

static Route route(const std::string& head, const std::string& expected) { return routeFor(parseRequest(head), expected); }

TEST(routing_lets_the_right_credentials_reach_index_and_stream) {
    std::string auth = expectedAuthHeader("viewer", "pw12345678");
    std::string a = "Authorization: " + auth + "\r\n\r\n";
    TEST_ASSERT(route("GET / HTTP/1.1\r\n" + a, auth) == Route::Index, "/ is the page");
    TEST_ASSERT(route("GET /index.html HTTP/1.1\r\n" + a, auth) == Route::Index, "/index.html too");
    TEST_ASSERT(route("GET /stream HTTP/1.1\r\n" + a, auth) == Route::Stream, "/stream streams");
    TEST_ASSERT(route("GET /stream?t=1 HTTP/1.1\r\n" + a, auth) == Route::Stream, "a cache-busting query is fine");
}

TEST(routing_refuses_missing_or_wrong_credentials_on_every_path) {
    std::string auth = expectedAuthHeader("viewer", "pw12345678");
    TEST_ASSERT(route("GET /stream HTTP/1.1\r\n\r\n", auth) == Route::Unauthorized, "no credentials");
    TEST_ASSERT(route("GET / HTTP/1.1\r\nAuthorization: Basic bm9wZQ==\r\n\r\n", auth) == Route::Unauthorized, "wrong credentials");
    TEST_ASSERT(route("GET /secret HTTP/1.1\r\n\r\n", auth) == Route::Unauthorized, "an unknown path doesn't reveal itself to strangers");
    TEST_ASSERT(route("POST /stream HTTP/1.1\r\n\r\n", auth) == Route::Unauthorized, "nor does a POST");
    TEST_ASSERT(route("GET /stream HTTP/1.1\r\nAuthorization: " + auth + "x\r\n\r\n", auth) == Route::Unauthorized, "a longer header than the right one");
    TEST_ASSERT(route("GET /stream HTTP/1.1\r\nAuthorization: basic " + auth.substr(6) + "\r\n\r\n", auth) == Route::Unauthorized, "scheme must match exactly (strict)");
}

TEST(routing_never_lets_anyone_in_when_no_credentials_are_configured_but_sent_empty) {
    // expectedAuthHeader() always yields "Basic ...", never "": a request with no
    // Authorization header (empty) can therefore never match it.
    std::string auth = expectedAuthHeader("u", "p");
    TEST_ASSERT(!auth.empty(), "the expected header is never empty");
    TEST_ASSERT(route("GET / HTTP/1.1\r\nAuthorization:\r\n\r\n", auth) == Route::Unauthorized, "an empty Authorization header is not a login");
}

TEST(routing_authenticated_odd_requests) {
    std::string auth = expectedAuthHeader("viewer", "pw12345678");
    std::string a = "Authorization: " + auth + "\r\n\r\n";
    TEST_ASSERT(route("GET /nope HTTP/1.1\r\n" + a, auth) == Route::NotFound, "unknown path");
    TEST_ASSERT(route("GET /favicon.ico HTTP/1.1\r\n" + a, auth) == Route::NotFound, "favicon");
    TEST_ASSERT(route("POST /stream HTTP/1.1\r\n" + a, auth) == Route::MethodNotAllowed, "POST");
    TEST_ASSERT(route("garbage\r\n\r\n", auth) == Route::BadRequest, "garbage");
}

// ── responses ───────────────────────────────────────────────────────────

TEST(unauthorized_response_asks_the_browser_for_a_login) {
    std::string r = unauthorizedResponse();
    TEST_ASSERT(has(r, "HTTP/1.1 401 Unauthorized\r\n"), "401");
    TEST_ASSERT(has(r, "WWW-Authenticate: Basic realm=\"Human detector\"\r\n"), "login prompt");
    TEST_ASSERT(has(r, "Connection: close\r\n"), "closes");
    TEST_ASSERT(has(r, "Content-Length: 23\r\n"), "length matches 'authentication required'");
}

TEST(simple_responses_have_the_right_status_lines) {
    TEST_ASSERT(has(notFoundResponse(), "HTTP/1.1 404 Not Found\r\n"), "404");
    TEST_ASSERT(has(badRequestResponse(), "HTTP/1.1 400 Bad Request\r\n"), "400");
    TEST_ASSERT(has(methodNotAllowedResponse(), "HTTP/1.1 405 Method Not Allowed\r\n"), "405");
    TEST_ASSERT(has(methodNotAllowedResponse(), "Allow: GET\r\n"), "says what is allowed");
}

TEST(index_page_embeds_the_stream_and_declares_its_length) {
    std::string r = indexPage();
    TEST_ASSERT(has(r, "HTTP/1.1 200 OK\r\n"), "200");
    TEST_ASSERT(has(r, "<img src=/stream"), "shows the stream");
    TEST_ASSERT(has(r, "image-rendering:pixelated"), "enlarged without smoothing");
    size_t bodyAt = r.find("\r\n\r\n") + 4;
    char want[48];
    snprintf(want, sizeof(want), "Content-Length: %u\r\n", (unsigned)(r.size() - bodyAt));
    TEST_ASSERT(has(r, want), "Content-Length equals the body's real size");
}

TEST(stream_head_and_parts_are_valid_multipart) {
    std::string h = streamResponseHead();
    TEST_ASSERT(has(h, "multipart/x-mixed-replace;boundary=frame"), "mjpeg content type");
    TEST_ASSERT(h.size() >= 4 && h.compare(h.size() - 4, 4, "\r\n\r\n") == 0, "ends the header block");
    std::string p = streamPartHead(2345);
    TEST_ASSERT_EQ(p, std::string("--frame\r\nContent-Type: image/jpeg\r\nContent-Length: 2345\r\n\r\n"), "part header");
}

// ── announcement ────────────────────────────────────────────────────────

TEST(urls_are_built_for_the_relay_and_for_the_viewer) {
    TEST_ASSERT_EQ(buildLogUrl("192.168.4.9", 8080), std::string("http://192.168.4.9:8080/log"), "relay log url");
    TEST_ASSERT_EQ(buildStreamUrl("192.168.4.37", 80), std::string("http://192.168.4.37/"), "port 80 left out");
    TEST_ASSERT_EQ(buildStreamUrl("192.168.4.37", 8081), std::string("http://192.168.4.37:8081/"), "other port shown");
}

TEST(json_strings_are_escaped) {
    std::string o;
    appendJsonString(o, "a\"b\\c\nd\te\rg\x01" "f");
    TEST_ASSERT_EQ(o, std::string("\"a\\\"b\\\\c\\nd\\te\\rg\\u0001f\""), "quote, backslash, newline, tab, carriage return, control");
    std::string u;
    appendJsonString(u, "—");
    TEST_ASSERT_EQ(u, std::string("\"—\""), "UTF-8 passes through unchanged");
}

TEST(announce_message_names_the_address_and_never_the_password) {
    std::string m = buildAnnounceMessage(AnnounceReason::NewAddress, "http://192.168.4.37/", "viewer", "extender-2", -61, 42);
    TEST_ASSERT(has(m, "human detector stream available at http://192.168.4.37/"), "the address is first and greppable");
    TEST_ASSERT(has(m, "user 'viewer'"), "says which user to log in as");
    TEST_ASSERT(has(m, "Wi-Fi 'extender-2'"), "which network");
    TEST_ASSERT(has(m, "-61 dBm"), "signal strength");
    TEST_ASSERT(has(m, "up 42s"), "uptime");
    std::string hb = buildAnnounceMessage(AnnounceReason::Heartbeat, "http://192.168.4.37/", "viewer", "x", -50, 600);
    TEST_ASSERT(has(hb, "human detector stream still at http://192.168.4.37/"), "a heartbeat reads differently but keeps the address");
}

TEST(announce_json_has_the_shape_the_relay_expects) {
    std::string j = buildAnnounceJson("cam2-human", "Oct  9 2026 12:00:00", "hello \"world\"", 12345, 98000, -61, 7);
    TEST_ASSERT(j.compare(0, 24, "{\"camera\":\"cam2-human\",\"") == 0, "starts with the camera id");
    TEST_ASSERT(has(j, "\"fw\":\"Oct  9 2026 12:00:00\""), "firmware build");
    TEST_ASSERT(has(j, "\"entries\":[{\"seq\":7,\"level\":\"INFO\","), "one INFO entry with its sequence number");
    TEST_ASSERT(has(j, "\"ageMs\":0,\"uptimeMs\":12345,\"heap\":98000,\"rssi\":-61,"), "numbers");
    TEST_ASSERT(has(j, "\"message\":\"hello \\\"world\\\"\"}]}"), "escaped message ends the body");
}

TEST(announce_policy_announces_a_new_address_first) {
    AnnouncePolicy p(600000, 30000);
    TEST_ASSERT(p.due(1000, true, "192.168.4.37") == AnnounceReason::NewAddress, "first connect after boot");
    TEST_ASSERT(p.due(1000, false, "192.168.4.37") == AnnounceReason::None, "never while Wi-Fi is down");
    TEST_ASSERT(p.due(1000, true, "") == AnnounceReason::None, "never without an address");
}

TEST(announce_policy_stays_quiet_until_the_heartbeat) {
    AnnouncePolicy p(600000, 30000);
    p.onResult(1000, true, "192.168.4.37");
    TEST_ASSERT(p.due(2000, true, "192.168.4.37") == AnnounceReason::None, "just announced");
    TEST_ASSERT(p.due(600999, true, "192.168.4.37") == AnnounceReason::None, "1 ms before the heartbeat");
    TEST_ASSERT(p.due(601000, true, "192.168.4.37") == AnnounceReason::Heartbeat, "heartbeat due");
    p.onResult(601000, true, "192.168.4.37");
    TEST_ASSERT(p.due(602000, true, "192.168.4.37") == AnnounceReason::None, "and quiet again");
}

TEST(announce_policy_announces_a_changed_address_at_once) {
    AnnouncePolicy p(600000, 30000);
    p.onResult(1000, true, "192.168.4.37");
    TEST_ASSERT(p.due(2000, true, "192.168.5.12") == AnnounceReason::NewAddress, "another network or lease");
    p.onResult(2000, true, "192.168.5.12");
    TEST_ASSERT(p.due(3000, true, "192.168.5.12") == AnnounceReason::None, "now known");
    TEST_ASSERT(p.due(4000, true, "192.168.4.37") == AnnounceReason::NewAddress, "going back is a change too");
}

TEST(announce_policy_retries_a_failure_after_the_retry_period_only) {
    AnnouncePolicy p(600000, 30000);
    p.onResult(1000, false, "192.168.4.37");
    TEST_ASSERT(p.due(2000, true, "192.168.4.37") == AnnounceReason::None, "not straight away");
    TEST_ASSERT(p.due(30999, true, "192.168.4.37") == AnnounceReason::None, "1 ms early");
    TEST_ASSERT(p.due(31000, true, "192.168.4.37") == AnnounceReason::NewAddress, "retry due");
    p.onResult(31000, false, "192.168.4.37");
    TEST_ASSERT(p.due(32000, true, "192.168.4.37") == AnnounceReason::None, "and the period starts over after each failure");
    p.onResult(61000, true, "192.168.4.37");
    TEST_ASSERT(p.due(62000, true, "192.168.4.37") == AnnounceReason::None, "a success ends the retrying");
}

TEST(announce_policy_survives_the_millis_counter_wrapping) {
    AnnouncePolicy p(600000, 30000);
    uint32_t nearWrap = 0xFFFFFFFFu - 1000u;
    p.onResult(nearWrap, true, "192.168.4.37");
    TEST_ASSERT(p.due(nearWrap + 5000u, true, "192.168.4.37") == AnnounceReason::None, "wrapped, but only 5 s later");
    TEST_ASSERT(p.due(nearWrap + 600000u, true, "192.168.4.37") == AnnounceReason::Heartbeat, "wrapped, 10 min later");
}

int main() {
    RUN_TEST(credentials_need_a_real_password_and_a_colon_free_user);
    RUN_TEST(base64_matches_the_rfc4648_test_vectors);
    RUN_TEST(base64_handles_high_bytes);
    RUN_TEST(expected_auth_header_is_what_a_browser_sends);
    RUN_TEST(constant_time_equals_compares_content_and_length);

    RUN_TEST(request_head_complete_needs_the_blank_line);
    RUN_TEST(parse_reads_method_path_and_authorization);
    RUN_TEST(parse_header_name_is_case_insensitive_and_value_is_trimmed);
    RUN_TEST(parse_drops_the_query_string_from_the_path);
    RUN_TEST(parse_without_authorization_leaves_it_empty);
    RUN_TEST(parse_ignores_an_authorization_header_that_is_in_the_body);
    RUN_TEST(parse_rejects_malformed_request_lines);

    RUN_TEST(routing_lets_the_right_credentials_reach_index_and_stream);
    RUN_TEST(routing_refuses_missing_or_wrong_credentials_on_every_path);
    RUN_TEST(routing_never_lets_anyone_in_when_no_credentials_are_configured_but_sent_empty);
    RUN_TEST(routing_authenticated_odd_requests);

    RUN_TEST(unauthorized_response_asks_the_browser_for_a_login);
    RUN_TEST(simple_responses_have_the_right_status_lines);
    RUN_TEST(index_page_embeds_the_stream_and_declares_its_length);
    RUN_TEST(stream_head_and_parts_are_valid_multipart);

    RUN_TEST(urls_are_built_for_the_relay_and_for_the_viewer);
    RUN_TEST(json_strings_are_escaped);
    RUN_TEST(announce_message_names_the_address_and_never_the_password);
    RUN_TEST(announce_json_has_the_shape_the_relay_expects);
    RUN_TEST(announce_policy_announces_a_new_address_first);
    RUN_TEST(announce_policy_stays_quiet_until_the_heartbeat);
    RUN_TEST(announce_policy_announces_a_changed_address_at_once);
    RUN_TEST(announce_policy_retries_a_failure_after_the_retry_period_only);
    RUN_TEST(announce_policy_survives_the_millis_counter_wrapping);

    return test::summarize();
}
