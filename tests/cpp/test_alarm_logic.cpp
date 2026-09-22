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
#include "../../Arduino/sketch_sep12a_camera2_behind_NAT/logic.h"

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

// ── alarmRecordTargetId / buildRecordUrl / buildAuthLine ────────────────

TEST(alarm_record_target_single_camera) {
    TEST_ASSERT_EQ(alarmRecordTargetId(false, "cam2"), std::string("cam2"), "targets just this camera");
}

TEST(alarm_record_target_all_cameras) {
    TEST_ASSERT_EQ(alarmRecordTargetId(true, "cam2"), std::string("all"), "targets every camera");
}

TEST(build_record_url_format) {
    std::string url = buildRecordUrl("192.168.4.9", 8080, "cam2", 60);
    TEST_ASSERT_EQ(url, std::string("http://192.168.4.9:8080/record/cam2?seconds=60"), "record URL matches relay's expected format");
}

TEST(build_record_url_all_target) {
    std::string url = buildRecordUrl("192.168.4.9", 8080, "all", 30);
    TEST_ASSERT_EQ(url, std::string("http://192.168.4.9:8080/record/all?seconds=30"), "record URL for the 'all cameras' target");
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

// ── applyControlByte ─────────────────────────────────────────────────

TEST(control_byte_zero_pauses) {
    bool streamEnabled = true;
    applyControlByte(0, streamEnabled);
    TEST_ASSERT(!streamEnabled, "0x00 pauses streaming");
}

TEST(control_byte_one_resumes) {
    bool streamEnabled = false;
    applyControlByte(1, streamEnabled);
    TEST_ASSERT(streamEnabled, "0x01 resumes streaming");
}

TEST(control_byte_unknown_is_ignored) {
    bool streamEnabled = true;
    applyControlByte(42, streamEnabled);
    TEST_ASSERT(streamEnabled, "unrecognised byte leaves state untouched");
}

TEST(control_byte_only_last_of_several_matters) {
    // Mirrors the .ino draining several buffered bytes in one loop() pass.
    bool streamEnabled = true;
    int bytes[] = {0, 1, 0};
    for (int b : bytes) applyControlByte(b, streamEnabled);
    TEST_ASSERT(!streamEnabled, "final byte in the batch wins");
}

// ── extractJsonBoolField / extractJsonIntField ───────────────────────────

TEST(extract_json_bool_field_true) {
    bool out = false;
    bool ok = extractJsonBoolField("{\"ai_enabled\":true,\"live_peek_until_epoch\":0}", "ai_enabled", out);
    TEST_ASSERT(ok, "field found");
    TEST_ASSERT(out, "parsed as true");
}

TEST(extract_json_bool_field_false) {
    bool out = true;
    bool ok = extractJsonBoolField("{\"ai_enabled\":false,\"live_peek_until_epoch\":0}", "ai_enabled", out);
    TEST_ASSERT(ok, "field found");
    TEST_ASSERT(!out, "parsed as false");
}

TEST(extract_json_bool_field_missing_key) {
    bool out = true;
    bool ok = extractJsonBoolField("{\"live_peek_until_epoch\":0}", "ai_enabled", out);
    TEST_ASSERT(!ok, "missing key reports failure");
}

TEST(extract_json_bool_field_wrong_type) {
    bool out = true;
    bool ok = extractJsonBoolField("{\"ai_enabled\":1}", "ai_enabled", out);
    TEST_ASSERT(!ok, "a non-bool value reports failure rather than a wrong guess");
}

TEST(extract_json_int_field_zero) {
    long out = -1;
    bool ok = extractJsonIntField("{\"live_peek_until_epoch\":0}", "live_peek_until_epoch", out);
    TEST_ASSERT(ok, "field found");
    TEST_ASSERT_EQ(out, 0L, "parsed as zero");
}

TEST(extract_json_int_field_multi_digit) {
    long out = 0;
    bool ok = extractJsonIntField("{\"ai_enabled\":true,\"live_peek_until_epoch\":1699999999}", "live_peek_until_epoch", out);
    TEST_ASSERT(ok, "field found");
    TEST_ASSERT_EQ(out, 1699999999L, "parsed multi-digit value");
}

TEST(extract_json_int_field_negative) {
    long out = 0;
    bool ok = extractJsonIntField("{\"live_peek_until_epoch\":-5}", "live_peek_until_epoch", out);
    TEST_ASSERT(ok, "field found");
    TEST_ASSERT_EQ(out, -5L, "parsed negative value");
}

TEST(extract_json_int_field_missing_key) {
    long out = 0;
    bool ok = extractJsonIntField("{\"ai_enabled\":true}", "live_peek_until_epoch", out);
    TEST_ASSERT(!ok, "missing key reports failure");
}

// ── parseAiAlarmCommand ───────────────────────────────────────────────

TEST(parse_ai_alarm_command_valid) {
    AiAlarmCommand cmd = parseAiAlarmCommand("{\"ai_enabled\":true,\"live_peek_until_epoch\":42}");
    TEST_ASSERT(cmd.valid, "well-formed payload parses");
    TEST_ASSERT(cmd.aiEnabled, "ai_enabled parsed correctly");
    TEST_ASSERT_EQ(cmd.livePeekUntilEpoch, 42L, "live_peek_until_epoch parsed correctly");
}

TEST(parse_ai_alarm_command_field_order_independent) {
    // JSON.stringify's own key order happens to match this, but the parser
    // shouldn't rely on it.
    AiAlarmCommand cmd = parseAiAlarmCommand("{\"live_peek_until_epoch\":7,\"ai_enabled\":false}");
    TEST_ASSERT(cmd.valid, "parses regardless of key order");
    TEST_ASSERT(!cmd.aiEnabled, "ai_enabled parsed correctly");
    TEST_ASSERT_EQ(cmd.livePeekUntilEpoch, 7L, "live_peek_until_epoch parsed correctly");
}

TEST(parse_ai_alarm_command_missing_field_is_invalid) {
    AiAlarmCommand cmd = parseAiAlarmCommand("{\"ai_enabled\":true}");
    TEST_ASSERT(!cmd.valid, "missing live_peek_until_epoch makes the whole command invalid");
}

TEST(parse_ai_alarm_command_garbage_is_invalid) {
    AiAlarmCommand cmd = parseAiAlarmCommand("not json at all");
    TEST_ASSERT(!cmd.valid, "unparsable payload is rejected, not guessed at");
}

// ── drainDownstream ───────────────────────────────────────────────────

// Builds a raw command frame buffer: [tag][2-byte BE length][payload].
static std::string buildCommandFrame(const std::string &payload) {
    std::string out;
    out += (char)COMMAND_FRAME_TAG;
    out += (char)((payload.size() >> 8) & 0xFF);
    out += (char)(payload.size() & 0xFF);
    out += payload;
    return out;
}

TEST(drain_downstream_single_control_byte) {
    std::string buf;
    buf += (char)CONTROL_BYTE_RESUME;
    DownstreamDrainResult r = drainDownstream(buf);
    TEST_ASSERT_EQ((int)r.controlBytes.size(), 1, "one control byte extracted");
    TEST_ASSERT_EQ(r.controlBytes[0], CONTROL_BYTE_RESUME, "correct value");
    TEST_ASSERT_EQ((int)r.commandPayloads.size(), 0, "no command payloads");
    TEST_ASSERT_EQ(r.rest.size(), (size_t)0, "nothing left over");
    TEST_ASSERT(!r.malformed, "not malformed");
}

TEST(drain_downstream_single_command_frame) {
    std::string payload = "{\"ai_enabled\":false,\"live_peek_until_epoch\":0}";
    DownstreamDrainResult r = drainDownstream(buildCommandFrame(payload));
    TEST_ASSERT_EQ((int)r.commandPayloads.size(), 1, "one command payload extracted");
    TEST_ASSERT_EQ(r.commandPayloads[0], payload, "payload bytes match exactly");
    TEST_ASSERT_EQ((int)r.controlBytes.size(), 0, "no control bytes");
    TEST_ASSERT_EQ(r.rest.size(), (size_t)0, "nothing left over");
}

TEST(drain_downstream_mixed_messages_in_order) {
    std::string buf;
    buf += (char)CONTROL_BYTE_PAUSE;
    buf += buildCommandFrame("{\"ai_enabled\":true,\"live_peek_until_epoch\":1}");
    buf += (char)CONTROL_BYTE_RESUME;
    DownstreamDrainResult r = drainDownstream(buf);
    TEST_ASSERT_EQ((int)r.controlBytes.size(), 2, "both control bytes extracted");
    TEST_ASSERT_EQ(r.controlBytes[0], CONTROL_BYTE_PAUSE, "first control byte in order");
    TEST_ASSERT_EQ(r.controlBytes[1], CONTROL_BYTE_RESUME, "second control byte in order");
    TEST_ASSERT_EQ((int)r.commandPayloads.size(), 1, "command frame extracted between them");
}

TEST(drain_downstream_partial_command_frame_header_left_in_rest) {
    std::string buf;
    buf += (char)COMMAND_FRAME_TAG;
    buf += (char)0; // only 1 of the 2 length bytes arrived so far
    DownstreamDrainResult r = drainDownstream(buf);
    TEST_ASSERT_EQ((int)r.commandPayloads.size(), 0, "nothing extracted yet");
    TEST_ASSERT_EQ(r.rest.size(), (size_t)2, "partial header kept for next call");
}

TEST(drain_downstream_partial_command_frame_payload_left_in_rest) {
    std::string full = buildCommandFrame("{\"ai_enabled\":true,\"live_peek_until_epoch\":9}");
    std::string partial = full.substr(0, full.size() - 1); // one byte short
    DownstreamDrainResult r = drainDownstream(partial);
    TEST_ASSERT_EQ((int)r.commandPayloads.size(), 0, "incomplete frame not extracted yet");
    TEST_ASSERT_EQ(r.rest.size(), partial.size(), "whole partial frame kept for next call");
}

TEST(drain_downstream_frame_split_across_two_calls) {
    std::string full = buildCommandFrame("{\"ai_enabled\":false,\"live_peek_until_epoch\":3}");
    std::string firstHalf = full.substr(0, 2); // just the tag + first length byte
    std::string secondHalf = full.substr(2);

    DownstreamDrainResult r1 = drainDownstream(firstHalf);
    TEST_ASSERT_EQ((int)r1.commandPayloads.size(), 0, "nothing extracted from the first half alone");

    DownstreamDrainResult r2 = drainDownstream(r1.rest + secondHalf);
    TEST_ASSERT_EQ((int)r2.commandPayloads.size(), 1, "reassembled once the rest arrives");
}

TEST(drain_downstream_unrecognized_tag_is_skipped) {
    std::string buf;
    buf += (char)0x7F; // not a control byte or the command frame tag
    buf += (char)CONTROL_BYTE_RESUME;
    DownstreamDrainResult r = drainDownstream(buf);
    TEST_ASSERT_EQ((int)r.controlBytes.size(), 1, "the unrecognized byte is skipped, not fatal");
    TEST_ASSERT_EQ(r.controlBytes[0], CONTROL_BYTE_RESUME, "parsing resumes correctly after it");
}

TEST(drain_downstream_oversized_length_is_malformed) {
    std::string buf;
    buf += (char)COMMAND_FRAME_TAG;
    buf += (char)0xFF;
    buf += (char)0xFF; // declares a 65535-byte payload, over MAX_COMMAND_FRAME_LEN
    DownstreamDrainResult r = drainDownstream(buf);
    TEST_ASSERT(r.malformed, "oversized declared length is flagged malformed");
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

int main() {
    RUN_TEST(debounce_ignores_first_reading_at_boot);
    RUN_TEST(debounce_fires_once_on_clean_transition);
    RUN_TEST(debounce_does_not_refire_while_held);
    RUN_TEST(debounce_ignores_bounce_noise);
    RUN_TEST(debounce_release_does_not_trigger);

    RUN_TEST(alarm_record_target_single_camera);
    RUN_TEST(alarm_record_target_all_cameras);
    RUN_TEST(build_record_url_format);
    RUN_TEST(build_record_url_all_target);
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

    RUN_TEST(control_byte_zero_pauses);
    RUN_TEST(control_byte_one_resumes);
    RUN_TEST(control_byte_unknown_is_ignored);
    RUN_TEST(control_byte_only_last_of_several_matters);

    RUN_TEST(extract_json_bool_field_true);
    RUN_TEST(extract_json_bool_field_false);
    RUN_TEST(extract_json_bool_field_missing_key);
    RUN_TEST(extract_json_bool_field_wrong_type);

    RUN_TEST(extract_json_int_field_zero);
    RUN_TEST(extract_json_int_field_multi_digit);
    RUN_TEST(extract_json_int_field_negative);
    RUN_TEST(extract_json_int_field_missing_key);

    RUN_TEST(parse_ai_alarm_command_valid);
    RUN_TEST(parse_ai_alarm_command_field_order_independent);
    RUN_TEST(parse_ai_alarm_command_missing_field_is_invalid);
    RUN_TEST(parse_ai_alarm_command_garbage_is_invalid);

    RUN_TEST(drain_downstream_single_control_byte);
    RUN_TEST(drain_downstream_single_command_frame);
    RUN_TEST(drain_downstream_mixed_messages_in_order);
    RUN_TEST(drain_downstream_partial_command_frame_header_left_in_rest);
    RUN_TEST(drain_downstream_partial_command_frame_payload_left_in_rest);
    RUN_TEST(drain_downstream_frame_split_across_two_calls);
    RUN_TEST(drain_downstream_unrecognized_tag_is_skipped);
    RUN_TEST(drain_downstream_oversized_length_is_malformed);

    RUN_TEST(write_stalled_false_while_within_timeout);
    RUN_TEST(write_stalled_true_once_timeout_elapsed);
    RUN_TEST(write_stalled_true_exactly_at_timeout_boundary);

    return test::summarize();
}
