// settings_keys_check.h — the rules of the short stored-key table (docs/settings_keys.tsv, explained in
// docs/SETTINGS_KEYS.md), for the tests. Include after the sketch's settings_schema.h.
//
// The rules (keyTableProblems): a stored key is at most NVS_KEY_MAX_LENGTH (15) characters of A-Z 0-9 _,
// starting with a letter, with no doubled or trailing underscore; within one sketch no stored key and no old name
// appears twice; every row has a label; one stored key has one label in every sketch; origin and sketch are known.
// The table against a schema (schemaTableProblems): every key of the schema has a row for that sketch, and every
// "stored" row (a key that devices already hold in flash) is still a key of the schema, so nobody can rename or
// drop one by accident.

#pragma once

#include <fstream>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <vector>

struct KeyRow {
    std::string origin;   // "stored": already in the flash of deployed boards (frozen); "new": added by F-29
    std::string sketch;   // "rec", "det" or "both"
    std::string oldName;  // the name before (a #define, a constant, a config.h name); for a stored key often the same
    std::string key;      // the stored key
    std::string label;
    std::string tasks;
};

inline bool rowCoversSketch(const KeyRow& r, const std::string& sketch) {
    return r.sketch == "both" || r.sketch == sketch;
}

// The tab separated table; '#' lines and empty lines are comments. A line without 6 columns is reported in `err`.
inline std::vector<KeyRow> loadKeyRows(const std::string& path, std::string& err) {
    std::vector<KeyRow> rows;
    std::ifstream in(path.c_str());
    if (!in) { err = "cannot open " + path; return rows; }
    std::string line;
    int n = 0;
    while (std::getline(in, line)) {
        ++n;
        if (line.empty() || line[0] == '#') continue;
        std::vector<std::string> col;
        std::string cell;
        std::istringstream ls(line);
        while (std::getline(ls, cell, '\t')) col.push_back(cell);
        if (!line.empty() && line[line.size() - 1] == '\t') col.push_back("");
        if (col.size() != 6) { err = path + ":" + std::to_string(n) + ": expected 6 tab separated columns"; return rows; }
        KeyRow r = { col[0], col[1], col[2], col[3], col[4], col[5] };
        rows.push_back(r);
    }
    return rows;
}

inline std::string keysTsvPath() {
    std::string here = __FILE__;   // .../tests/cpp/settings_keys_check.h
    std::string::size_type cut = here.rfind("/tests/cpp/");
    return (cut == std::string::npos ? std::string(".") : here.substr(0, cut)) + "/docs/settings_keys.tsv";
}

inline bool wellFormedKey(const std::string& k, size_t maxLen) {
    if (k.empty() || k.size() > maxLen) return false;
    if (k[0] < 'A' || k[0] > 'Z') return false;
    if (k[k.size() - 1] == '_' || k.find("__") != std::string::npos) return false;
    for (size_t i = 0; i < k.size(); ++i) {
        const char c = k[i];
        if (!((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_')) return false;
    }
    return true;
}

inline std::vector<std::string> keyTableProblems(const std::vector<KeyRow>& rows, size_t maxLen) {
    std::vector<std::string> out;
    std::map<std::string, std::string> labelOf;   // stored key -> its label
    std::set<std::string> keys[2], olds[2];       // [0] rec, [1] det
    const char* const sketches[2] = { "rec", "det" };
    for (size_t i = 0; i < rows.size(); ++i) {
        const KeyRow& r = rows[i];
        const std::string who = "row " + std::to_string(i + 1) + " (" + r.key + ")";
        if (r.origin != "stored" && r.origin != "new") out.push_back(who + ": origin must be stored or new");
        if (r.sketch != "rec" && r.sketch != "det" && r.sketch != "both") out.push_back(who + ": sketch must be rec, det or both");
        if (!wellFormedKey(r.key, maxLen))
            out.push_back(who + ": the stored key must be 1-" + std::to_string(maxLen) + " characters of A-Z 0-9 _, start with a letter, no doubled or trailing _");
        if (r.oldName.empty()) out.push_back(who + ": old name is empty");
        if (r.label.empty()) out.push_back(who + ": label is empty");
        const std::map<std::string, std::string>::const_iterator seen = labelOf.find(r.key);
        if (seen == labelOf.end()) labelOf[r.key] = r.label;
        else if (seen->second != r.label) out.push_back(who + ": one stored key, one label (\"" + seen->second + "\" vs \"" + r.label + "\")");
        for (int s = 0; s < 2; ++s) {
            if (!rowCoversSketch(r, sketches[s])) continue;
            if (!keys[s].insert(r.key).second) out.push_back(who + ": stored key used twice in the " + sketches[s] + " sketch");
            if (!olds[s].insert(r.oldName).second) out.push_back(who + ": old name \"" + r.oldName + "\" used twice in the " + sketches[s] + " sketch");
        }
    }
    return out;
}

// `schemaKeys`: the names of the schema's KeyDef rows of one sketch ("rec" or "det").
inline std::vector<std::string> schemaTableProblems(const std::vector<KeyRow>& rows, const std::string& sketch,
                                                    const std::vector<std::string>& schemaKeys) {
    std::vector<std::string> out;
    std::set<std::string> inSchema(schemaKeys.begin(), schemaKeys.end()), inTable;
    for (size_t i = 0; i < rows.size(); ++i) {
        if (!rowCoversSketch(rows[i], sketch)) continue;
        inTable.insert(rows[i].key);
        if (rows[i].origin == "stored" && !inSchema.count(rows[i].key))
            out.push_back(sketch + ": \"" + rows[i].key + "\" is stored on deployed boards but is no longer a key of the schema (renamed or removed?)");
    }
    for (size_t i = 0; i < schemaKeys.size(); ++i)
        if (!inTable.count(schemaKeys[i])) out.push_back(sketch + ": schema key \"" + schemaKeys[i] + "\" has no row in docs/settings_keys.tsv");
    return out;
}
