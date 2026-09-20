'use strict';

// video.js — pure logic around encoding a finished recording, extracted
// out of server.js's finalizeRecording() so it can be tested without
// actually spawning ffmpeg or writing any files.

// The real measured frame rate for a finished recording, clamped to a
// sane encodable range. Falls back to defaultFps when there's no usable
// span (e.g. a single frame, or frames with no measurable time between
// the first and last).
function computeFps(frameCount, firstFrameAtMs, lastFrameAtMs, defaultFps, minFps = 1, maxFps = 30) {
  const spanSeconds = lastFrameAtMs > firstFrameAtMs ? (lastFrameAtMs - firstFrameAtMs) / 1000 : 0;
  return spanSeconds > 0 ? Math.min(maxFps, Math.max(minFps, frameCount / spanSeconds)) : defaultFps;
}

// The exact ffmpeg argv finalizeRecording() spawns, extracted so the
// command-building logic can be tested without running ffmpeg itself.
function buildFfmpegArgs(fps, framePattern, outputPath) {
  return [
    '-y',
    '-framerate', fps.toFixed(2),
    '-i', framePattern,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputPath,
  ];
}

module.exports = { computeFps, buildFfmpegArgs };
