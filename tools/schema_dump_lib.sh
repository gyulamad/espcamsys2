#!/usr/bin/env bash
# schema_dump_lib.sh — SOURCED by tools/gen_device_schema.sh and tools/gen_settings_reference.sh (not run on its own).
# The one place that knows how the firmware's settings tables (settings_schema.h) are built into a dump program, so the
# two generators never carry their own copy of the compile lines.
#
#   build_schema_dumps ROOT OUT_DIR   compiles tools/dump_device_schema.cpp twice into OUT_DIR:
#                                     dump_recorder (ESP32_CAM_Recorder) and dump_detector (ESP32_CAM_TFLite_Person).
#                                     Each prints one JSON member ("recorder": {...} / "detector": {...}).
#                                     Returns non-zero (the caller's `set -e` stops) if either does not compile.

build_schema_dumps() {
    local root="$1" out="$2"
    g++ -std=c++11 -Wall -Wextra -o "$out/dump_recorder" "$root/tools/dump_device_schema.cpp" || return 1
    g++ -std=c++11 -Wall -Wextra -DDUMP_DETECTOR -o "$out/dump_detector" "$root/tools/dump_device_schema.cpp" || return 1
}
