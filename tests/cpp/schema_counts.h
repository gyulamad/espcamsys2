// schema_counts.h — what a schema asks of a board, for the tests. Include after settings_logic.h.

#pragma once

#include <cstddef>

// Does this setting have a default (a KeyMeta row with a value)? Then a board that stored nothing for it uses that.
inline bool hasDefault(const esp32cam_settings::Schema& schema, const char* name) {
    const esp32cam_settings::KeyMeta* m = esp32cam_settings::findMeta(schema.meta, schema.metaCount, name);
    return m && m->defaultValue;
}

// How many settings a BLANK board is asked for: all but the optional ones and the ones with a default.
// An optional setting (Cond::Optional) may stay absent, and a defaulted one uses its default, so neither is
// listed as missing nor stored unless someone sets it.
// (Counting schema.count would also count them, and then every blank-board test breaks for the wrong reason
// whenever an optional or defaulted setting is added.)
inline size_t requiredKeyCount(const esp32cam_settings::Schema& schema) {
    size_t n = 0;
    for (size_t i = 0; i < schema.count; ++i) {
        if (schema.keys[i].cond == esp32cam_settings::Cond::Optional) continue;
        if (hasDefault(schema, schema.keys[i].name)) continue;
        ++n;
    }
    return n;
}
