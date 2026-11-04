// test_alarm_logic.cpp — unit tests for Arduino/.../logic.h.
//
// Build & run (also done by run_tests.sh):
//   g++ -std=c++17 -Wall -Wextra -o build/test_alarm_logic test_alarm_logic.cpp
//   gdb -q -batch -ex run -ex bt -ex "quit $_exitcode" --args build/test_alarm_logic
//
// Running it under gdb means a crash (segfault, failed assert, etc.) prints
// a backtrace instead of just "Aborted" — on a clean run gdb behaves just
// like running the binary directly.

#include "framework.h"
#include "../../Arduino/ESP32_CAM_Recorder/logic.h"

using namespace esp32cam_logic;

// ── alarmDebounceUpdate ─────────────────────────────────────────────────

TEST(debounce_ignores_first_reading_at_boot) {
    // A sensor that powers up already in its "active" position must NOT
    // fire on its very first stable reading — nothing has "happened" yet.
    AlarmDebounceState st;
    bool triggered = false;
    triggered |= alarmDebounceUpdate(st, /*raw=*/0, /*now=*/0, /*debounce=*/50, /*active=*/0);
    triggered |= alarmDebounceUpdate(st, /*raw=*/0, /*now=*/60, /*debounce=*/50, /*active=*/0);
    TEST_ASSERT(!triggered, "no trigger on first-ever stable reading");
    TEST_ASSERT_EQ(st.stableState, 0, "stable state recorded");
}

TEST(debounce_fires_once_on_clean_transition) {
    AlarmDebounceState st;
    // Boot idle (HIGH=1), settles.
    alarmDebounceUpdate(st, 1, 0, 50, /*active=*/0);
    alarmDebounceUpdate(st, 1, 60, 50, /*active=*/0);
    // Button pressed (goes LOW=0) and settles after debounce window.
    bool duringChange = alarmDebounceUpdate(st, 0, 100, 50, /*active=*/0);
    TEST_ASSERT(!duringChange, "no trigger the instant the reading changes");
    bool stillSettling = alarmDebounceUpdate(st, 0, 120, 50, /*active=*/0); // only 20ms elapsed
    TEST_ASSERT(!stillSettling, "no trigger before debounce window elapses");
    bool settled = alarmDebounceUpdate(st, 0, 160, 50, /*active=*/0); // 60ms elapsed
    TEST_ASSERT(settled, "trigger once debounce window elapses on a real transition");
}

TEST(debounce_does_not_refire_while_held) {
    AlarmDebounceState st;
    alarmDebounceUpdate(st, 1, 0, 50, 0);
    alarmDebounceUpdate(st, 1, 60, 50, 0);
    alarmDebounceUpdate(st, 0, 100, 50, 0);
    bool firstFire = alarmDebounceUpdate(st, 0, 160, 50, 0);
    TEST_ASSERT(firstFire, "fires on the settled transition");
    bool secondCall = alarmDebounceUpdate(st, 0, 300, 50, 0); // still held, well past debounce
    TEST_ASSERT(!secondCall, "does not refire while held steady at the same value");
}

TEST(debounce_ignores_bounce_noise) {
    // A noisy contact that bounces 0/1/0/1 before settling should not fire
    // repeatedly — only once the reading has actually held steady.
    AlarmDebounceState st;
    alarmDebounceUpdate(st, 1, 0, 50, 0);
    alarmDebounceUpdate(st, 1, 60, 50, 0); // stable HIGH established
    alarmDebounceUpdate(st, 0, 100, 50, 0); // bounce down
    alarmDebounceUpdate(st, 1, 105, 50, 0); // bounce back up (resets settle timer)
    alarmDebounceUpdate(st, 0, 110, 50, 0); // bounce down again (resets again)
    bool settling = alarmDebounceUpdate(st, 0, 130, 50, 0); // only 20ms since last change
    TEST_ASSERT(!settling, "still within debounce window after the last bounce");
    bool settled = alarmDebounceUpdate(st, 0, 165, 50, 0); // 55ms since last change
    TEST_ASSERT(settled, "fires exactly once the bouncing has actually stopped");
}

TEST(debounce_release_does_not_trigger) {
    // Only a transition INTO the active state should trigger — releasing
    // back to idle must not.
    AlarmDebounceState st;
    alarmDebounceUpdate(st, 1, 0, 50, /*active=*/0); // idle HIGH
    alarmDebounceUpdate(st, 1, 60, 50, /*active=*/0);
    alarmDebounceUpdate(st, 0, 100, 50, /*active=*/0);
    bool pressFires = alarmDebounceUpdate(st, 0, 160, 50, /*active=*/0);
    TEST_ASSERT(pressFires, "press (transition to active) fires");
    alarmDebounceUpdate(st, 1, 200, 50, /*active=*/0); // released back to idle
    bool releaseFires = alarmDebounceUpdate(st, 1, 260, 50, /*active=*/0);
    TEST_ASSERT(!releaseFires, "release (transition to inactive) does not fire");
}

// ── alarmRecordTargetId / buildAlarmUrl / buildAuthLine ────────────────

TEST(alarm_record_target_single_camera) {
    TEST_ASSERT_EQ(alarmRecordTargetId(false, "cam2"), std::string("cam2"), "targets just this camera");
}

TEST(alarm_record_target_all_cameras) {
    TEST_ASSERT_EQ(alarmRecordTargetId(true, "cam2"), std::string("all"), "targets every camera");
}

TEST(build_alarm_url_format) {
    std::string url = buildAlarmUrl("192.168.4.9", 8080, "cam2");
    TEST_ASSERT_EQ(url, std::string("http://192.168.4.9:8080/alarm/cam2"), "alarm URL matches relay's expected format (no duration)");
}

TEST(build_alarm_url_all_target) {
    std::string url = buildAlarmUrl("192.168.4.9", 8080, "all");
    TEST_ASSERT_EQ(url, std::string("http://192.168.4.9:8080/alarm/all"), "alarm URL for the 'all cameras' target");
}

TEST(build_auth_line_format) {
    std::string line = buildAuthLine("cam2", "s3cr3t");
    TEST_ASSERT_EQ(line, std::string("cam2\ts3cr3t\n"), "auth line is <id>TAB<key>NEWLINE");
}

// ── encodeFrameLengthPrefix ──────────────────────────────────────────────

TEST(encode_frame_length_prefix_zero) {
    uint8_t out[4];
    encodeFrameLengthPrefix(0, out);
    TEST_ASSERT(out[0] == 0 && out[1] == 0 && out[2] == 0 && out[3] == 0, "zero length encodes as all-zero bytes");
}

TEST(encode_frame_length_prefix_small) {
    uint8_t out[4];
    encodeFrameLengthPrefix(1, out);
    TEST_ASSERT(out[0] == 0 && out[1] == 0 && out[2] == 0 && out[3] == 1, "small length in the last byte");
}

TEST(encode_frame_length_prefix_multi_byte) {
    uint8_t out[4];
    encodeFrameLengthPrefix(0x0102ABCD, out);
    TEST_ASSERT(out[0] == 0x01 && out[1] == 0x02 && out[2] == 0xAB && out[3] == 0xCD, "big-endian byte order");
}

TEST(encode_frame_length_prefix_max) {
    uint8_t out[4];
    encodeFrameLengthPrefix(0xFFFFFFFFu, out);
    TEST_ASSERT(out[0] == 0xFF && out[1] == 0xFF && out[2] == 0xFF && out[3] == 0xFF, "max uint32 encodes fully");
}

// ── pushWriteSucceeded ────────────────────────────────────────────────

TEST(push_write_succeeded_when_complete_and_connected) {
    TEST_ASSERT(pushWriteSucceeded(4 + 100, 100, true), "full write + still connected = success");
}

TEST(push_write_failed_when_short_write) {
    TEST_ASSERT(!pushWriteSucceeded(4 + 50, 100, true), "partial write = failure even if still connected");
}

TEST(push_write_failed_when_disconnected) {
    TEST_ASSERT(!pushWriteSucceeded(4 + 100, 100, false), "full write but socket dropped = failure");
}

// ── computePushDelayMs ───────────────────────────────────────────────

TEST(push_delay_scales_with_last_push_time) {
    TEST_ASSERT_EQ(computePushDelayMs(100, 1.5f), 150UL, "gap = last push time * multiplier");
}

TEST(push_delay_zero_when_push_instant) {
    TEST_ASSERT_EQ(computePushDelayMs(0, 1.5f), 0UL, "no gap needed when the push took no measurable time");
}

TEST(push_delay_is_capped_so_a_slow_link_is_not_made_slower) {
    TEST_ASSERT_EQ(computePushDelayMs(20000, 1.5f, 1000), 1000UL, "a 20 s push must not be followed by a 30 s pause");
    TEST_ASSERT_EQ(computePushDelayMs(400, 1.5f, 1000), 600UL, "under the cap the gap is unchanged");
}

// ── adaptJpegQuality ─────────────────────────────────────────────────

static const unsigned long SLOW_MS = 2000, FAST_MS = 600;

TEST(jpeg_quality_starts_at_the_configured_best) {
    JpegQualityAdapter a = makeJpegQualityAdapter(12, 45);
    TEST_ASSERT_EQ(a.current, 12, "starts at the configured quality");
    TEST_ASSERT_EQ(adaptJpegQuality(a, 300, true, SLOW_MS, FAST_MS), 12, "a good link changes nothing");
}

TEST(jpeg_quality_shrinks_frames_right_after_a_slow_push) {
    JpegQualityAdapter a = makeJpegQualityAdapter(12, 45);
    TEST_ASSERT_EQ(adaptJpegQuality(a, 3000, true, SLOW_MS, FAST_MS), 18, "one slow frame = one step coarser");
    TEST_ASSERT_EQ(adaptJpegQuality(a, 3000, true, SLOW_MS, FAST_MS), 24, "and again");
}

TEST(jpeg_quality_shrinks_twice_as_hard_when_very_slow) {
    JpegQualityAdapter a = makeJpegQualityAdapter(12, 45);
    TEST_ASSERT_EQ(adaptJpegQuality(a, 25000, true, SLOW_MS, FAST_MS), 24, "a 25 s push (the real -87 dBm case) takes a double step");
}

TEST(jpeg_quality_treats_a_failed_push_as_very_slow) {
    JpegQualityAdapter a = makeJpegQualityAdapter(12, 45);
    TEST_ASSERT_EQ(adaptJpegQuality(a, 100, false, SLOW_MS, FAST_MS), 24, "even if the failed attempt was quick");
}

TEST(jpeg_quality_never_goes_past_the_worst_allowed) {
    JpegQualityAdapter a = makeJpegQualityAdapter(12, 45);
    for (int i = 0; i < 20; i++) adaptJpegQuality(a, 30000, false, SLOW_MS, FAST_MS);
    TEST_ASSERT_EQ(a.current, 45, "stops at the worst quality");
}

TEST(jpeg_quality_recovers_slowly_after_a_run_of_fast_pushes) {
    JpegQualityAdapter a = makeJpegQualityAdapter(12, 45);
    adaptJpegQuality(a, 3000, true, SLOW_MS, FAST_MS); // 18
    for (int i = 0; i < JPEG_QUALITY_FAST_STREAK - 1; i++) {
        TEST_ASSERT_EQ(adaptJpegQuality(a, 200, true, SLOW_MS, FAST_MS), 18, "not yet: the link must stay good for a while");
    }
    TEST_ASSERT_EQ(adaptJpegQuality(a, 200, true, SLOW_MS, FAST_MS), 16, "then one small step back toward the picture");
}

TEST(jpeg_quality_never_improves_past_the_configured_best) {
    JpegQualityAdapter a = makeJpegQualityAdapter(12, 45);
    adaptJpegQuality(a, 3000, true, SLOW_MS, FAST_MS); // 18
    for (int i = 0; i < 100; i++) adaptJpegQuality(a, 100, true, SLOW_MS, FAST_MS);
    TEST_ASSERT_EQ(a.current, 12, "back to, and not beyond, the configured quality");
}

TEST(jpeg_quality_holds_in_the_middle_band_and_restarts_the_run) {
    JpegQualityAdapter a = makeJpegQualityAdapter(12, 45);
    adaptJpegQuality(a, 3000, true, SLOW_MS, FAST_MS); // 18
    for (int i = 0; i < JPEG_QUALITY_FAST_STREAK - 1; i++) adaptJpegQuality(a, 200, true, SLOW_MS, FAST_MS);
    TEST_ASSERT_EQ(adaptJpegQuality(a, 1000, true, SLOW_MS, FAST_MS), 18, "a so-so push neither degrades nor improves");
    for (int i = 0; i < JPEG_QUALITY_FAST_STREAK - 1; i++) {
        TEST_ASSERT_EQ(adaptJpegQuality(a, 200, true, SLOW_MS, FAST_MS), 18, "the run of fast pushes started over");
    }
}

TEST(jpeg_quality_adapter_tolerates_a_worst_better_than_best) {
    JpegQualityAdapter a = makeJpegQualityAdapter(30, 10);
    TEST_ASSERT_EQ(adaptJpegQuality(a, 30000, false, SLOW_MS, FAST_MS), 30, "a nonsensical range pins the quality instead of misbehaving");
}

// ── writeStalled ─────────────────────────────────────────────────────

TEST(write_stalled_false_while_within_timeout) {
    TEST_ASSERT(!writeStalled(1000, 2000, 4000), "1s of no progress within a 4s timeout is not stalled yet");
}

TEST(write_stalled_true_once_timeout_elapsed) {
    TEST_ASSERT(writeStalled(1000, 5001, 4000), "4001ms of no progress past a 4s timeout counts as stalled");
}

TEST(write_stalled_true_exactly_at_timeout_boundary) {
    TEST_ASSERT(writeStalled(1000, 5000, 4000), "exactly the timeout elapsed also counts as stalled");
}

// ── encodeAlarmMessage / chooseAlarmRoute ────────────────────────────

TEST(alarm_message_for_this_camera_is_the_exact_wire_bytes) {
    uint8_t m[ALARM_MESSAGE_LEN];
    encodeAlarmMessage(false, m);
    const uint8_t expected[6] = {0x00, 0x00, 0x00, 0x02, 0x00, 0x01};
    for (int i = 0; i < 6; i++) TEST_ASSERT_EQ((int)m[i], (int)expected[i], "byte matches the relay's protocol.js");
}

TEST(alarm_message_for_all_cameras_is_the_exact_wire_bytes) {
    uint8_t m[ALARM_MESSAGE_LEN];
    encodeAlarmMessage(true, m);
    const uint8_t expected[6] = {0x00, 0x00, 0x00, 0x02, 0x00, 0x02};
    for (int i = 0; i < 6; i++) TEST_ASSERT_EQ((int)m[i], (int)expected[i], "byte matches the relay's protocol.js");
}

TEST(alarm_message_can_never_be_mistaken_for_a_jpeg) {
    uint8_t m[ALARM_MESSAGE_LEN];
    encodeAlarmMessage(false, m);
    TEST_ASSERT_EQ((int)m[4], 0x00, "control payload starts with the marker");
    TEST_ASSERT((int)m[4] != 0xFF, "a JPEG starts with 0xFF 0xD8, a control message never does");
}

TEST(alarm_message_length_prefix_matches_its_payload) {
    uint8_t m[ALARM_MESSAGE_LEN];
    encodeAlarmMessage(true, m);
    uint32_t len = ((uint32_t)m[0] << 24) | ((uint32_t)m[1] << 16) | ((uint32_t)m[2] << 8) | m[3];
    TEST_ASSERT_EQ((int)len, (int)(ALARM_MESSAGE_LEN - 4), "prefix says 2 payload bytes follow");
}

TEST(alarm_route_uses_the_push_connection_only_when_the_relay_announced_support) {
    TEST_ASSERT(chooseAlarmRoute(true, true, true) == AlarmRoute::InBand, "push up + relay supports -> in-band");
    TEST_ASSERT(chooseAlarmRoute(true, true, false) == AlarmRoute::InBand, "in-band wins even if WiFi status looks down");
}

TEST(alarm_route_never_sends_in_band_to_a_relay_that_did_not_announce_support) {
    // The regression this guards against: an OLD relay takes the 6 alarm bytes for
    // a video frame -> corrupt frame on the stream (black screen) and a lost alarm.
    TEST_ASSERT(chooseAlarmRoute(true, false, true) == AlarmRoute::Http, "push up but relay silent -> HTTP, not in-band");
    TEST_ASSERT(chooseAlarmRoute(true, false, false) == AlarmRoute::Skip, "...and nothing at all if WiFi is down too");
}

TEST(alarm_route_falls_back_to_http_without_a_push_connection) {
    TEST_ASSERT(chooseAlarmRoute(false, false, true) == AlarmRoute::Http, "no push connection but WiFi -> HTTP fallback");
    TEST_ASSERT(chooseAlarmRoute(false, true, true) == AlarmRoute::Http, "stale capability flag with no connection -> HTTP");
}

TEST(alarm_route_skips_when_nothing_can_be_sent) {
    TEST_ASSERT(chooseAlarmRoute(false, false, false) == AlarmRoute::Skip, "no push, no WiFi -> skip");
}

TEST(relay_capability_byte_sets_the_flag) {
    bool supports = false;
    applyRelayByte(RELAY_CAP_INBAND_ALARM, supports);
    TEST_ASSERT(supports, "0x02 from the relay turns in-band alarms on");
}

TEST(old_relay_bytes_and_unknown_bytes_leave_the_flag_off) {
    bool supports = false;
    applyRelayByte(0, supports);   // legacy pause
    applyRelayByte(1, supports);   // legacy resume (what an old relay sends on connect)
    applyRelayByte(42, supports);  // unknown
    applyRelayByte(-1, supports);  // read() with nothing available
    TEST_ASSERT(!supports, "an old relay's bytes never enable in-band alarms");
}

TEST(relay_greeting_sequence_resume_then_capability) {
    // Exactly what the new relay writes on connect: 0x01 then 0x02.
    bool supports = false;
    const int greeting[2] = {0x01, 0x02};
    for (int i = 0; i < 2; i++) applyRelayByte(greeting[i], supports);
    TEST_ASSERT(supports, "greeting enables in-band alarms");
}

TEST(log_url_points_at_the_relays_log_endpoint) {
    TEST_ASSERT(buildLogUrl("192.168.4.9", 8080) == "http://192.168.4.9:8080/log", "host, port and /log");
}

// ── alarmHoldUpdate (keep recording while the alarm line stays active) ───

TEST(hold_edge_sends_the_alarm_immediately) {
    AlarmHoldState st;
    TEST_ASSERT(alarmHoldUpdate(st, /*edge=*/true, /*active=*/true, 1000, 1000), "an edge always sends");
    TEST_ASSERT(st.armed, "an edge arms the refresh");
    TEST_ASSERT_EQ(st.lastSentMs, 1000UL, "the send time is remembered");
}

TEST(hold_resends_every_refresh_interval_while_the_line_stays_active) {
    // The bug: line goes high and stays high -> one alarm, recording runs out.
    AlarmHoldState st;
    alarmHoldUpdate(st, true, true, 1000, 1000);
    TEST_ASSERT(!alarmHoldUpdate(st, false, true, 1500, 1000), "not before the interval has passed");
    TEST_ASSERT(!alarmHoldUpdate(st, false, true, 1999, 1000), "still not at 999 ms");
    TEST_ASSERT(alarmHoldUpdate(st, false, true, 2000, 1000), "re-sent once the interval has passed");
    TEST_ASSERT(!alarmHoldUpdate(st, false, true, 2500, 1000), "the interval restarts after each send");
    TEST_ASSERT(alarmHoldUpdate(st, false, true, 3000, 1000), "and it keeps going for as long as the line is held");
    TEST_ASSERT(alarmHoldUpdate(st, false, true, 4000, 1000), "...and going");
}

TEST(hold_stops_resending_once_the_line_goes_inactive) {
    AlarmHoldState st;
    alarmHoldUpdate(st, true, true, 0, 1000);
    TEST_ASSERT(!alarmHoldUpdate(st, false, false, 1500, 1000), "nothing is sent for a released line");
    TEST_ASSERT(!st.armed, "release disarms");
    TEST_ASSERT(!alarmHoldUpdate(st, false, true, 5000, 1000), "a line seen active again WITHOUT an edge does not send");
}

TEST(hold_a_new_edge_after_release_starts_over) {
    AlarmHoldState st;
    alarmHoldUpdate(st, true, true, 0, 1000);
    alarmHoldUpdate(st, false, false, 500, 1000); // released
    TEST_ASSERT(alarmHoldUpdate(st, true, true, 700, 1000), "the next edge sends right away");
    TEST_ASSERT(!alarmHoldUpdate(st, false, true, 1200, 1000), "the interval counts from that edge");
    TEST_ASSERT(alarmHoldUpdate(st, false, true, 1700, 1000), "and the refresh resumes");
}

TEST(hold_an_edge_while_held_restarts_the_interval) {
    // "...or goes high again while the recording keeps rolling": an extra edge
    // sends at once and is not followed by a second send right behind it.
    AlarmHoldState st;
    alarmHoldUpdate(st, true, true, 0, 1000);
    TEST_ASSERT(alarmHoldUpdate(st, true, true, 800, 1000), "an edge during the hold sends");
    TEST_ASSERT(!alarmHoldUpdate(st, false, true, 1000, 1000), "no double send: the interval restarted at the edge");
    TEST_ASSERT(alarmHoldUpdate(st, false, true, 1800, 1000), "the next refresh is a full interval after it");
}

TEST(hold_a_pulse_shorter_than_one_loop_sends_once_and_disarms) {
    // Line went high and low again before loop() looked: the edge was latched.
    AlarmHoldState st;
    TEST_ASSERT(alarmHoldUpdate(st, true, false, 100, 1000), "the latched edge still sends");
    TEST_ASSERT(!alarmHoldUpdate(st, false, false, 200, 1000), "the next look sees a released line and stays quiet");
    TEST_ASSERT(!st.armed, "and nothing is left armed");
}

TEST(hold_a_line_already_active_at_boot_does_not_send) {
    // Same rule as alarmDebounceUpdate(): no edge, no alarm.
    AlarmHoldState st;
    TEST_ASSERT(!alarmHoldUpdate(st, false, true, 0, 1000), "no edge yet: quiet");
    TEST_ASSERT(!alarmHoldUpdate(st, false, true, 60000, 1000), "even long after boot while still held");
}

TEST(hold_survives_the_millis_counter_wrapping) {
    // Unsigned subtraction: a send just before the 32-bit wrap is still seen as old after it.
    const unsigned long nearWrap = 0xFFFFFFFFUL - 200;
    AlarmHoldState st;
    alarmHoldUpdate(st, true, true, nearWrap, 1000);
    TEST_ASSERT(!alarmHoldUpdate(st, false, true, nearWrap + 500, 1000), "not due 500 ms after the send, across the wrap");
    TEST_ASSERT(alarmHoldUpdate(st, false, true, nearWrap + 1000, 1000), "due 1000 ms after the send, across the wrap");
}

int main() {
    RUN_TEST(debounce_ignores_first_reading_at_boot);
    RUN_TEST(debounce_fires_once_on_clean_transition);
    RUN_TEST(debounce_does_not_refire_while_held);
    RUN_TEST(debounce_ignores_bounce_noise);
    RUN_TEST(debounce_release_does_not_trigger);

    RUN_TEST(alarm_record_target_single_camera);
    RUN_TEST(alarm_record_target_all_cameras);
    RUN_TEST(build_alarm_url_format);
    RUN_TEST(build_alarm_url_all_target);
    RUN_TEST(build_auth_line_format);

    RUN_TEST(encode_frame_length_prefix_zero);
    RUN_TEST(encode_frame_length_prefix_small);
    RUN_TEST(encode_frame_length_prefix_multi_byte);
    RUN_TEST(encode_frame_length_prefix_max);

    RUN_TEST(push_write_succeeded_when_complete_and_connected);
    RUN_TEST(push_write_failed_when_short_write);
    RUN_TEST(push_write_failed_when_disconnected);

    RUN_TEST(push_delay_scales_with_last_push_time);
    RUN_TEST(push_delay_zero_when_push_instant);
    RUN_TEST(push_delay_is_capped_so_a_slow_link_is_not_made_slower);

    RUN_TEST(jpeg_quality_starts_at_the_configured_best);
    RUN_TEST(jpeg_quality_shrinks_frames_right_after_a_slow_push);
    RUN_TEST(jpeg_quality_shrinks_twice_as_hard_when_very_slow);
    RUN_TEST(jpeg_quality_treats_a_failed_push_as_very_slow);
    RUN_TEST(jpeg_quality_never_goes_past_the_worst_allowed);
    RUN_TEST(jpeg_quality_recovers_slowly_after_a_run_of_fast_pushes);
    RUN_TEST(jpeg_quality_never_improves_past_the_configured_best);
    RUN_TEST(jpeg_quality_holds_in_the_middle_band_and_restarts_the_run);
    RUN_TEST(jpeg_quality_adapter_tolerates_a_worst_better_than_best);


    RUN_TEST(write_stalled_false_while_within_timeout);
    RUN_TEST(write_stalled_true_once_timeout_elapsed);
    RUN_TEST(write_stalled_true_exactly_at_timeout_boundary);
    RUN_TEST(alarm_message_for_this_camera_is_the_exact_wire_bytes);
    RUN_TEST(alarm_message_for_all_cameras_is_the_exact_wire_bytes);
    RUN_TEST(alarm_message_can_never_be_mistaken_for_a_jpeg);
    RUN_TEST(alarm_message_length_prefix_matches_its_payload);
    RUN_TEST(alarm_route_uses_the_push_connection_only_when_the_relay_announced_support);
    RUN_TEST(alarm_route_never_sends_in_band_to_a_relay_that_did_not_announce_support);
    RUN_TEST(alarm_route_falls_back_to_http_without_a_push_connection);
    RUN_TEST(alarm_route_skips_when_nothing_can_be_sent);
    RUN_TEST(relay_capability_byte_sets_the_flag);
    RUN_TEST(old_relay_bytes_and_unknown_bytes_leave_the_flag_off);
    RUN_TEST(relay_greeting_sequence_resume_then_capability);
    RUN_TEST(log_url_points_at_the_relays_log_endpoint);
    RUN_TEST(hold_edge_sends_the_alarm_immediately);
    RUN_TEST(hold_resends_every_refresh_interval_while_the_line_stays_active);
    RUN_TEST(hold_stops_resending_once_the_line_goes_inactive);
    RUN_TEST(hold_a_new_edge_after_release_starts_over);
    RUN_TEST(hold_an_edge_while_held_restarts_the_interval);
    RUN_TEST(hold_a_pulse_shorter_than_one_loop_sends_once_and_disarms);
    RUN_TEST(hold_a_line_already_active_at_boot_does_not_send);
    RUN_TEST(hold_survives_the_millis_counter_wrapping);

    return test::summarize();
}
