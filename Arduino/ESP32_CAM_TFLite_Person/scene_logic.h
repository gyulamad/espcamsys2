// scene_logic.h — the person detector's "is it worth running the model?" gate:
// a darkness check and a motion check on a handful of sample pixels.
// Pure C++11 (no Arduino includes), unit-tested on a desktop: see
// tests/cpp/test_person_scene_logic.cpp.
//
// Why: the person-detection model reports false positives on dark pictures (it
// is looking at sensor noise), and running it on a picture where nothing moves
// is wasted work. So every frame is first looked at cheaply:
//
//   * SceneSampler picks every SAMPLE_STEP-th pixel in both directions (on the
//     96x96 frame: 10 x 10 = 100 pixels), and reports
//       - brightness: the average gray value of those pixels (0..255)
//       - motion:     the sum, over those pixels, of |gray now - gray in the
//                     previous frame| (the same idea as the watcher in the
//                     older esp32camsys camera system)
//   * SceneGate turns the readings into a verdict:
//       Dark   brightness below the DARK_THRESH setting  -> no detection, and a
//              person that was "detected" is cleared (it can only be a false one)
//       Idle   light enough, but nothing moved lately     -> no detection
//       Active light enough and motion within the last MOTION_HOLD_S seconds
//              (or a person is currently detected, so that a person standing
//              still does not drop out)                   -> run the model
//
// A threshold of 0 switches its check off: DARK_THRESH=0 never reports Dark,
// MOTION_THRESH=0 treats every frame as moving. With both 0 the gate is always
// Active, i.e. the detector behaves exactly as it did before this gate existed.

#pragma once

#include <stddef.h>
#include <stdint.h>

#include <string>
#include <vector>

namespace person_scene {

// Every SAMPLE_STEP-th pixel, horizontally and vertically, is a sample.
constexpr int SAMPLE_STEP = 10;

// Darkness is left again only when the brightness is this much ABOVE the
// threshold it was entered at, so a picture hovering around the threshold
// (dusk, a flickering lamp) does not flip the gate on every frame.
constexpr int DARK_HYSTERESIS = 5;

struct SceneReading {
    int brightness = 0;          // average gray of the samples, 0..255 (rounded)
    uint32_t motion = 0;         // sum of |difference| to the previous frame's samples
    bool hasPrevious = false;    // false for the very first frame: motion is then 0 and means nothing
};

class SceneSampler {
public:
    SceneSampler(int width, int height, int step = SAMPLE_STEP)
        : width_(width > 0 ? width : 0),
          height_(height > 0 ? height : 0),
          step_(step > 0 ? step : 1) {
        count_ = static_cast<size_t>((width_ + step_ - 1) / step_) *
                 static_cast<size_t>((height_ + step_ - 1) / step_);
        previous_.assign(count_, 0);
    }

    size_t sampleCount() const { return count_; }

    // `gray` is width x height bytes, one per pixel. Remembers this frame's
    // samples for the next call.
    SceneReading analyze(const uint8_t* gray) {
        SceneReading r;
        r.hasPrevious = havePrevious_;
        if (count_ == 0 || gray == nullptr) return r;

        uint32_t sum = 0;
        uint32_t diff = 0;
        size_t i = 0;
        for (int y = 0; y < height_; y += step_) {
            for (int x = 0; x < width_; x += step_) {
                uint8_t p = gray[static_cast<size_t>(y) * width_ + x];
                sum += p;
                if (havePrevious_) {
                    uint8_t q = previous_[i];
                    diff += p > q ? static_cast<uint32_t>(p - q) : static_cast<uint32_t>(q - p);
                }
                previous_[i] = p;
                ++i;
            }
        }
        havePrevious_ = true;
        r.brightness = static_cast<int>((sum + count_ / 2) / count_);
        r.motion = diff;
        return r;
    }

private:
    int width_;
    int height_;
    int step_;
    size_t count_ = 0;
    bool havePrevious_ = false;
    std::vector<uint8_t> previous_;
};

enum class SceneState { Dark, Idle, Active };

struct SceneConfig {
    int darkBelow = 0;             // DARK_THRESH: brightness below this = dark; 0 = check off
    uint32_t motionAtLeast = 0;    // MOTION_THRESH: motion at or above this = moving; 0 = check off
    uint32_t holdMs = 0;           // MOTION_HOLD_S in ms: how long detection stays on after the last motion
};

struct SceneVerdict {
    SceneState state = SceneState::Active;
    bool run = true;               // run the person model on this frame
    bool clearPerson = false;      // a person is flagged but the scene is dark: drop it
    bool changed = false;          // the state differs from the previous frame's (worth a log line)
};

class SceneGate {
public:
    SceneGate() {}
    explicit SceneGate(const SceneConfig& cfg) : cfg_(cfg) {}

    void configure(const SceneConfig& cfg) {
        cfg_ = cfg;
        dark_ = false;
        motionSeen_ = false;
        lastMotionMs_ = 0;
        last_ = SceneState::Active;
    }

    const SceneConfig& config() const { return cfg_; }

    // `personActive`: the detector currently has a person flagged.
    SceneVerdict update(uint32_t nowMs, const SceneReading& r, bool personActive) {
        // Darkness, with hysteresis.
        if (cfg_.darkBelow <= 0) {
            dark_ = false;
        } else if (!dark_ && r.brightness < cfg_.darkBelow) {
            dark_ = true;
        } else if (dark_ && r.brightness >= cfg_.darkBelow + DARK_HYSTERESIS) {
            dark_ = false;
        }

        // Motion, held for holdMs after the last frame that moved.
        bool moving;
        if (cfg_.motionAtLeast == 0) {
            moving = true;
        } else {
            if (r.hasPrevious && r.motion >= cfg_.motionAtLeast) {
                motionSeen_ = true;
                lastMotionMs_ = nowMs;
            }
            // Unsigned subtraction: correct across the 49-day millis() wrap.
            moving = motionSeen_ && static_cast<uint32_t>(nowMs - lastMotionMs_) <= cfg_.holdMs;
        }

        SceneVerdict v;
        if (dark_) v.state = SceneState::Dark;
        else if (moving || personActive) v.state = SceneState::Active;
        else v.state = SceneState::Idle;

        v.run = v.state == SceneState::Active;
        v.clearPerson = dark_ && personActive;
        v.changed = v.state != last_;   // last_ starts as Active: nothing to report while both checks are off
        last_ = v.state;
        return v;
    }

private:
    SceneConfig cfg_;
    bool dark_ = false;
    bool motionSeen_ = false;
    uint32_t lastMotionMs_ = 0;
    SceneState last_ = SceneState::Active;
};

// One line for the serial monitor when the state changes.
inline std::string describeScene(SceneState state, const SceneReading& r, const SceneConfig& cfg) {
    switch (state) {
        case SceneState::Dark:
            return "Scene: DARK (brightness " + std::to_string(r.brightness) + " < " +
                   std::to_string(cfg.darkBelow) + ") - detection paused";
        case SceneState::Idle:
            return "Scene: still (motion " + std::to_string(r.motion) + " < " +
                   std::to_string(cfg.motionAtLeast) + ") - detection paused";
        case SceneState::Active:
        default:
            return "Scene: active (brightness " + std::to_string(r.brightness) + ", motion " +
                   std::to_string(r.motion) + ") - detecting";
    }
}

}  // namespace person_scene
