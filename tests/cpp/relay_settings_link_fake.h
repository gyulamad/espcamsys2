// relay_settings_link_fake.h — stands in for the sketches' "Relay settings link"
// (the real one joins Wi-Fi and makes an HTTP request) in the tests that compile a
// sketch's "Settings glue" block. The glue constructs
// RelaySettingsLink(store, type, idKey); this one forwards to a scripted
// ScriptLink (remote_link_fake.h) that the test configures through g_link.
// Include after the sketch's settings_schema.h and before the glue block.

#pragma once

#include <string>

#include "remote_link_fake.h"

static ScriptLink g_link;                 // what the "relay" does; reset by the tests' powerUp()
static std::string g_linkType;            // what the glue said it is ("recorder" / "detector")
static std::string g_linkIdKey;           // and which setting holds its id

struct RelaySettingsLink : esp32cam_settings::IRemoteLink {
    RelaySettingsLink(esp32cam_settings::ISettingsStore&, const char* type, const char* idKey) {
        g_linkType = type;
        g_linkIdKey = idKey;
    }
    void startConnecting() override { g_link.startConnecting(); }
    bool online() override { return g_link.online(); }
    esp32cam_settings::FetchResult fetch(const std::string& need, std::string& line) override {
        return g_link.fetch(need, line);
    }
};

static void resetLink() { g_link = ScriptLink(); g_linkType.clear(); g_linkIdKey.clear(); }
