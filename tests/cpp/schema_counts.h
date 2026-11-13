// schema_counts.h — what a schema asks of a board, for the tests. Include after settings_logic.h.

#pragma once

#include <cstddef>

// How many settings a BLANK board is asked for: all but the optional ones. An optional setting
// (Cond::Optional) may stay absent, so it is neither listed as missing nor stored unless someone sets it.
// (Counting schema.count would also count them, and then every blank-board test breaks for the wrong reason
// whenever an optional setting is added.)
inline size_t requiredKeyCount(const esp32cam_settings::Schema& schema) {
    size_t n = 0;
    for (size_t i = 0; i < schema.count; ++i) {
        if (schema.keys[i].cond != esp32cam_settings::Cond::Optional) ++n;
    }
    return n;
}
