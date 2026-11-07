// motion_baseline.h — the scene gate's "what is normal motion here?" level: an exponential moving
// average (EMA) of the motion readings, and the motion threshold derived from it.
// Pure C++11 (no Arduino includes), unit-tested on a desktop: see
// tests/cpp/test_person_motion_baseline.cpp.
//
// Why: a fixed MOTION_THRESH is tuned for a calm scene. When a storm moves the trees, or rain and
// insects light up the lens, the motion reading of an EMPTY scene rises above it and the person model
// runs on every frame for nothing. With the EMA switched on, the threshold follows that noise level:
//
//     threshold = max( MOTION_THRESH, EMA * (100 + MOTION_EMA_PCT) / 100 )
//
// MOTION_THRESH stays the floor, so the EMA can only RAISE the threshold (in a storm), never lower it
// below what was set by hand; a calm scene therefore behaves exactly as without the EMA.
//
// The average spans MOTION_EMA_LEN frames (a few minutes' worth): short enough to follow a storm, long
// enough that a person walking through the picture for some seconds barely moves it. It is counted in
// frames, not seconds, so there is no clock to get wrong.
//
// What it learns is the motion of an EMPTY scene, so one reading counts for at most CLIP_FACTOR times the
// threshold in force (it is clipped). Without that, the very thing to be detected raises the bar against
// itself: a camera warm-up (auto exposure settling) seeded the average with thousands and blinded the
// detector for minutes, and a person busy in the picture for a minute and a half raised the threshold above
// the next person's walk (simulated: 5 minutes blind, and 0 of 20 frames of the next walk noticed). With the
// clip a burst can lift the threshold only a little, and a real storm - noise that stays above it - still
// raises it as fast as before. The first reading seeds the average, but at most as high as the floor allows
// (floor / (1 + percent)): one reading never starts the threshold above MOTION_THRESH.
//
// MOTION_EMA_LEN = 0 switches the whole thing off: threshold() then returns the floor, untouched.

#pragma once

#include <stdint.h>

namespace person_scene {

// One reading is learnt as at most this many times the threshold in force.
constexpr double CLIP_FACTOR = 2.0;

// MOTION_EMA_PCT's usual value (the setting itself has no default, see settings_schema.h): the
// threshold lies 30% above the average.
constexpr uint32_t DEFAULT_MOTION_EMA_PERCENT = 30;

// The limits of the two settings (settings_schema.h). 100000 frames is over an hour even at 25 frames a
// second; 1000% is a threshold eleven times the average. Both keep the arithmetic far from any overflow.
constexpr uint32_t MAX_MOTION_EMA_LEN = 100000;
constexpr uint32_t MAX_MOTION_EMA_PERCENT = 1000;

class MotionBaseline {
public:
    // `lengthFrames`: how many frames the average spans, 0 = off.
    // `percentAbove`: how far above the average the threshold lies, in percent.
    // Starts over: a new configuration must not inherit what an old one learnt.
    void configure(uint32_t lengthFrames, uint32_t percentAbove) {
        alpha_ = lengthFrames == 0 ? 0.0 : 2.0 / (static_cast<double>(lengthFrames) + 1.0);
        factor_ = 1.0 + static_cast<double>(percentAbove) / 100.0;
        average_ = 0.0;
        seeded_ = false;
    }

    bool enabled() const { return alpha_ > 0.0; }

    // The average so far (0 while off or before the first reading).
    double average() const { return average_; }

    // Learns one motion reading (at most twice the threshold in force, see above). `floor` is MOTION_THRESH, the
    // same as for threshold(). Call it for real readings only: the very first frame has nothing to be compared
    // to (SceneReading::hasPrevious) and its 0 would drag the average down for nothing.
    void observe(uint32_t motion, uint32_t floor) {
        if (!enabled()) return;
        const double reading = static_cast<double>(motion);
        if (!seeded_) {
            const double most = static_cast<double>(floor) / factor_;
            average_ = reading < most ? reading : most;
            seeded_ = true;
            return;
        }
        const double most = limit(floor) * CLIP_FACTOR;
        average_ += alpha_ * ((reading < most ? reading : most) - average_);
    }

    // The threshold in force: `floor` (MOTION_THRESH) or, when the average calls for more, that.
    uint32_t threshold(uint32_t floor) const {
        const double adaptive = limit(floor) + 0.5;   // + 0.5: rounded to the nearest whole number
        if (adaptive >= static_cast<double>(UINT32_MAX)) return UINT32_MAX;   // cannot happen with real readings: never wrap
        const uint32_t whole = static_cast<uint32_t>(adaptive);
        return whole > floor ? whole : floor;
    }

private:
    // The threshold as a number with decimals: the floor, or the average plus its percentage when that is more.
    double limit(uint32_t floor) const {
        const double fixed = static_cast<double>(floor);
        if (!enabled() || !seeded_) return fixed;
        const double adaptive = average_ * factor_;
        return adaptive > fixed ? adaptive : fixed;
    }

    double alpha_ = 0.0;     // smoothing factor 2 / (length + 1); 0 = off
    double factor_ = 1.0;    // 1 + percent / 100
    double average_ = 0.0;
    bool seeded_ = false;    // has the first reading arrived
};

}  // namespace person_scene
