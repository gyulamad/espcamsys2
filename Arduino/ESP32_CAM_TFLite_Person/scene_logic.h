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
//       - motion:     the sum, over those pixels that lie inside the MOTION AREA,
//                     of |gray now - gray in the previous frame| (the same idea as
//                     the watcher in the older esp32camsys camera system)
//     The motion area (MotionArea, the MOTION_X0..MOTION_Y1 settings) is a
//     rectangle of the picture. By default it is the whole picture; narrowing it
//     keeps something that always moves (trees in the wind, a rotating machine)
//     out of the motion reading. Brightness always looks at the whole picture:
//     darkness is a property of the scene, not of the part watched for motion.
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
//
// Optionally (MOTION_EMA_LEN > 0) the motion threshold calibrates itself: it follows a moving
// average of the motion readings, so wind and rain that make an empty scene "move" raise it instead
// of keeping the model busy - see motion_baseline.h. MOTION_THRESH is then its lower limit.

#pragma once

#include <stddef.h>
#include <stdint.h>

#include <string>
#include <vector>

#include "motion_baseline.h"

namespace person_scene {

// Every SAMPLE_STEP-th pixel, horizontally and vertically, is a sample.
constexpr int SAMPLE_STEP = 10;

// The size of the picture the person model takes (the sketch static_asserts
// that its IMAGE_WIDTH / IMAGE_HEIGHT agree): the default motion area and the
// limits of the MOTION_* settings follow from it.
constexpr int FRAME_SIZE = 96;

// Darkness is left again only when the brightness is this much ABOVE the
// threshold it was entered at, so a picture hovering around the threshold
// (dusk, a flickering lamp) does not flip the gate on every frame.
constexpr int DARK_HYSTERESIS = 5;

// The part of the picture that is watched for motion, in pixels: x0/y0 are the
// first column/row inside it, x1/y1 the first column/row OUTSIDE it (so the whole
// 96x96 picture is 0,0 - 96,96, and the width is x1 - x0).
struct MotionArea {
    int x0, y0, x1, y1;
    MotionArea() : x0(0), y0(0), x1(FRAME_SIZE), y1(FRAME_SIZE) {}
    MotionArea(int left, int top, int right, int bottom) : x0(left), y0(top), x1(right), y1(bottom) {}
    bool operator==(const MotionArea& o) const { return x0 == o.x0 && y0 == o.y0 && x1 == o.x1 && y1 == o.y1; }
    bool operator!=(const MotionArea& o) const { return !(*this == o); }
};

// Is `a` a usable motion area on a width x height picture? It has to lie inside
// the picture and be at least SAMPLE_STEP pixels wide and high: that is what
// guarantees that at least one sample pixel falls inside it, so the motion
// reading can move at all (an area between two sample rows would read 0 forever
// and detection would never start). `err` says what is wrong when it is not.
inline bool motionAreaUsable(const MotionArea& a, int width, int height, std::string& err) {
    if (a.x0 < 0 || a.y0 < 0 || a.x1 > width || a.y1 > height) {
        err = "the motion area must lie inside the " + std::to_string(width) + "x" + std::to_string(height) + " picture";
        return false;
    }
    if (a.x1 - a.x0 < SAMPLE_STEP || a.y1 - a.y0 < SAMPLE_STEP) {
        err = "the motion area must be at least " + std::to_string(SAMPLE_STEP) + " pixels wide and high";
        return false;
    }
    return true;
}

struct SceneReading {
    int brightness = 0;          // average gray of the samples, 0..255 (rounded)
    uint32_t motion = 0;         // sum of |difference| to the previous frame's samples inside the motion area
    bool hasPrevious = false;    // false for the very first frame: motion is then 0 and means nothing
};

class SceneSampler {
public:
    SceneSampler(int width, int height, int step = SAMPLE_STEP)
        : width_(width > 0 ? width : 0),
          height_(height > 0 ? height : 0),
          step_(step > 0 ? step : 1),
          area_(0, 0, width_, height_) {
        count_ = static_cast<size_t>((width_ + step_ - 1) / step_) *
                 static_cast<size_t>((height_ + step_ - 1) / step_);
        previous_.assign(count_, 0);
    }

    size_t sampleCount() const { return count_; }

    // Restricts the motion reading to `area`. An area that is not usable on this
    // picture (motionAreaUsable) is refused and the previous one stays - the
    // settings are checked long before, so this is only a second line of defence
    // against drawing outside the frame.
    bool setMotionArea(const MotionArea& area) {
        std::string err;
        if (!motionAreaUsable(area, width_, height_, err)) return false;
        area_ = area;
        return true;
    }

    const MotionArea& motionArea() const { return area_; }

    // `gray` is width x height bytes, one per pixel. Remembers this frame's
    // samples (all of them, wherever the motion area is) for the next call.
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
                if (havePrevious_ && inMotionArea(x, y)) {
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
    bool inMotionArea(int x, int y) const {
        return x >= area_.x0 && x < area_.x1 && y >= area_.y0 && y < area_.y1;
    }

    int width_;
    int height_;
    int step_;
    MotionArea area_;
    size_t count_ = 0;
    bool havePrevious_ = false;
    std::vector<uint8_t> previous_;
};

enum class SceneState { Dark, Idle, Active };

struct SceneConfig {
    int darkBelow = 0;             // DARK_THRESH: brightness below this = dark; 0 = check off
    uint32_t motionAtLeast = 0;    // MOTION_THRESH: motion at or above this = moving; 0 = check off (with an EMA: the lowest threshold)
    uint32_t holdMs = 0;           // MOTION_HOLD_S in ms: how long detection stays on after the last motion
    uint32_t motionEmaFrames = 0;  // MOTION_EMA_LEN: frames the motion average spans; 0 = threshold stays fixed
    uint32_t motionEmaPercent = DEFAULT_MOTION_EMA_PERCENT;   // MOTION_EMA_PCT: threshold = average + this many percent
};

struct SceneVerdict {
    SceneState state = SceneState::Active;
    bool run = true;               // run the person model on this frame
    bool clearPerson = false;      // a person is flagged but the scene is dark: drop it
    bool changed = false;          // the state differs from the previous frame's (worth a log line)
    uint32_t motionLimit = 0;      // the motion threshold this frame was judged against (0 = motion check off)
};

class SceneGate {
public:
    SceneGate() {}
    explicit SceneGate(const SceneConfig& cfg) : cfg_(cfg) {}

    void configure(const SceneConfig& cfg) {
        cfg_ = cfg;
        baseline_.configure(cfg.motionEmaFrames, cfg.motionEmaPercent);
        dark_ = false;
        motionSeen_ = false;
        lastMotionMs_ = 0;
        last_ = SceneState::Active;
    }

    const SceneConfig& config() const { return cfg_; }

    // The motion threshold in force right now: MOTION_THRESH, or - with the EMA on - the moving average
    // plus its percentage when that is higher. 0 while the motion check is off, EMA or not.
    uint32_t motionThreshold() const {
        if (cfg_.motionAtLeast == 0) return 0;
        return baseline_.threshold(cfg_.motionAtLeast);
    }

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

        SceneVerdict v;
        v.motionLimit = motionThreshold();   // fixed before this frame is learnt: a spike must not raise its own bar
        const bool moving = isMoving(nowMs, r, v.motionLimit);

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
    // Motion, held for holdMs after the last frame that moved. `limit` is the threshold this frame is
    // judged against; the frame is learnt by the average only afterwards.
    bool isMoving(uint32_t nowMs, const SceneReading& r, uint32_t limit) {
        if (limit == 0) return true;   // motion check off: every frame counts as moving
        if (r.hasPrevious) {
            if (r.motion >= limit) {
                motionSeen_ = true;
                lastMotionMs_ = nowMs;
            }
            baseline_.observe(r.motion, cfg_.motionAtLeast);   // the first frame has no reading to learn from
        }
        // Unsigned subtraction: correct across the 49-day millis() wrap.
        return motionSeen_ && static_cast<uint32_t>(nowMs - lastMotionMs_) <= cfg_.holdMs;
    }

    SceneConfig cfg_;
    MotionBaseline baseline_;
    bool dark_ = false;
    bool motionSeen_ = false;
    uint32_t lastMotionMs_ = 0;
    SceneState last_ = SceneState::Active;
};

// One line for the serial monitor when the state changes. `motionLimit` is the motion threshold the
// frame was judged against (SceneVerdict::motionLimit): with the EMA on it differs from MOTION_THRESH.
inline std::string describeScene(SceneState state, const SceneReading& r, const SceneConfig& cfg, uint32_t motionLimit) {
    switch (state) {
        case SceneState::Dark:
            return "Scene: DARK (brightness " + std::to_string(r.brightness) + " < " +
                   std::to_string(cfg.darkBelow) + ") - detection paused";
        case SceneState::Idle:
            return "Scene: still (motion " + std::to_string(r.motion) + " < " +
                   std::to_string(motionLimit) + ") - detection paused";
        case SceneState::Active:
        default:
            return "Scene: active (brightness " + std::to_string(r.brightness) + ", motion " +
                   std::to_string(r.motion) + ") - detecting";
    }
}

// The same with the fixed MOTION_THRESH as the threshold (no EMA).
inline std::string describeScene(SceneState state, const SceneReading& r, const SceneConfig& cfg) {
    return describeScene(state, r, cfg, cfg.motionAtLeast);
}

}  // namespace person_scene
