// remote_link_fake.h — a scripted stand-in for the Wi-Fi + HTTP side of
// "ask the relay for the missing settings" (esp32cam_settings::IRemoteLink).
// Include after settings_logic.h. The tests decide when Wi-Fi comes up and what
// each request to the relay answers, and read back what the board did.

#pragma once

#include <string>
#include <vector>

struct ScriptedReply {
    esp32cam_settings::FetchResult result;
    std::string line;
};

struct ScriptLink : esp32cam_settings::IRemoteLink {
    // Wi-Fi: comes up on the Nth online() call after startConnecting(); 0 = never.
    int onlineOnCall = 1;
    // The relay: answers in order; when the script runs out it keeps giving `whenEmpty`.
    std::vector<ScriptedReply> replies;
    esp32cam_settings::FetchResult whenEmpty = esp32cam_settings::FetchResult::NothingStaged;

    // What the board did.
    int connects = 0;
    int onlineCalls = 0;
    int fetches = 0;
    std::vector<std::string> needSeen;

    void startConnecting() override { connects++; onlineCalls = 0; }
    bool online() override {
        onlineCalls++;
        return onlineOnCall > 0 && onlineCalls >= onlineOnCall;
    }
    esp32cam_settings::FetchResult fetch(const std::string& need, std::string& line) override {
        fetches++;
        needSeen.push_back(need);
        if (replies.empty()) return whenEmpty;
        ScriptedReply r = replies.front();
        replies.erase(replies.begin());
        line = r.line;
        return r.result;
    }

    void reply(esp32cam_settings::FetchResult r, const std::string& line = "") {
        ScriptedReply s; s.result = r; s.line = line; replies.push_back(s);
    }
};
