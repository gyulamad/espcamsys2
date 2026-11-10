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

// ffmpeg scale arguments for a recording whose frames are not all the same
// pixel size, or [] when they are (the normal case: no filter, and the encode
// is byte-for-byte what it always was). A camera walks its frame-size ladder
// while its link is slow, so a recording CAN contain mixed sizes; the first
// frame's size wins — the clip keeps the resolution it started with and the
// smaller frames are scaled up to it, rather than frames being dropped from
// footage. An unreadable first frame (null) means no size is known: leave the
// encode alone rather than scale to a guess; an unreadable later frame is
// treated as a mismatch, because scaling same-size frames is a no-op anyway.
function scaleArgsForFrameSizes(sizes) {
  if (!Array.isArray(sizes) || sizes.length === 0 || !sizes[0]) return [];
  const { width, height } = sizes[0];
  const uniform = sizes.every((s) => s && s.width === width && s.height === height);
  return uniform ? [] : ['-vf', `scale=${width}:${height}`];
}

// The exact ffmpeg argv finalizeRecording() spawns, extracted so the
// command-building logic can be tested without running ffmpeg itself.
// extraArgs (e.g. the scale filter from scaleArgsForFrameSizes) is spliced in
// after the input, where output options belong.
function buildFfmpegArgs(fps, framePattern, outputPath, extraArgs = []) {
  return [
    '-y',
    '-framerate', fps.toFixed(2),
    '-i', framePattern,
    ...extraArgs,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    outputPath,
  ];
}

module.exports = { computeFps, scaleArgsForFrameSizes, buildFfmpegArgs };
