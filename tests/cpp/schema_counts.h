// schema_counts.h — what a schema asks of a board, for the tests. Include after settings_logic.h.

#pragma once

#include <cstddef>
#include <string>

// Does this setting have a default (a KeyMeta row with a value)? Then a board that stored nothing for it uses that.
inline bool hasDefault(const esp32cam_settings::Schema& schema, const char* name) {
    const esp32cam_settings::KeyMeta* m = esp32cam_settings::findMeta(schema.meta, schema.metaCount, name);
    return m && m->defaultValue;
}

// How many settings a BLANK board is asked for, exactly as findProblems lists them: all but the optional
// ones, the ones with a default, and the ones whose controller's default switches their feature off (a
// dependent is not asked for while its feature is off, and the controller's default is in force on a blank
// board). (Counting schema.count would also count them, and then every blank-board test breaks for the
// wrong reason whenever an optional or defaulted setting is added.)
inline size_t requiredKeyCount(const esp32cam_settings::Schema& schema) {
    size_t n = 0;
    for (size_t i = 0; i < schema.count; ++i) {
        const esp32cam_settings::KeyDef& k = schema.keys[i];
        if (k.cond == esp32cam_settings::Cond::Optional) continue;
        if (hasDefault(schema, k.name)) continue;
        if (k.condKey && hasDefault(schema, k.condKey)) {
            // The controller's default is in force: is the feature on with it?
            const esp32cam_settings::KeyMeta* m = esp32cam_settings::findMeta(schema.meta, schema.metaCount, k.condKey);
            const bool equal = m && m->defaultValue && std::string(m->defaultValue) == k.condValue;
            const bool featureOn = k.cond == esp32cam_settings::Cond::WhenEquals ? equal : !equal;
            if (!featureOn) continue;   // off by default: not asked for, like MOTION_EMA_PCT while MOTION_EMA_LEN defaults to 0
        }
        ++n;
    }
    return n;
}
