'use strict';

const { test, assertEqual, summarize } = require('./framework');
const video = require('../../nodejs/camera-relay/lib/video');

test('computeFps averages frame count over the measured span', () => {
  // 30 frames spanning 10 real seconds -> 3 fps.
  assertEqual(video.computeFps(30, 0, 10000, 5), 3);
});

test('computeFps falls back to the default with no measurable span', () => {
  assertEqual(video.computeFps(1, 1000, 1000, 5), 5);
});

test('computeFps clamps to the maximum (30fps)', () => {
  assertEqual(video.computeFps(1000, 0, 1000, 5), 30);
});

test('computeFps clamps to the minimum (1fps)', () => {
  assertEqual(video.computeFps(1, 0, 60000, 5), 1);
});

test('buildFfmpegArgs produces the expected argv', () => {
  const args = video.buildFfmpegArgs(12.5, '/tmp/rec/frame_%06d.jpg', '/tmp/rec/cam1_x.mp4');
  assertEqual(args, [
    '-y',
    '-framerate', '12.50',
    '-i', '/tmp/rec/frame_%06d.jpg',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '/tmp/rec/cam1_x.mp4',
  ]);
});

test('buildFfmpegArgs without extra args is what it always was (no breaking change)', () => {
  const withDefault = video.buildFfmpegArgs(12.5, '/tmp/f.jpg', '/tmp/out.mp4');
  const withEmpty = video.buildFfmpegArgs(12.5, '/tmp/f.jpg', '/tmp/out.mp4', []);
  assertEqual(withDefault, withEmpty);
});

test('buildFfmpegArgs splices the scale filter in after the input', () => {
  const args = video.buildFfmpegArgs(12.5, '/tmp/rec/frame_%06d.jpg', '/tmp/rec/cam1_x.mp4', ['-vf', 'scale=640:480']);
  assertEqual(args, [
    '-y',
    '-framerate', '12.50',
    '-i', '/tmp/rec/frame_%06d.jpg',
    '-vf', 'scale=640:480',
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    '/tmp/rec/cam1_x.mp4',
  ]);
});

test('scaleArgsForFrameSizes: uniform frames need no filter', () => {
  const vga = { width: 640, height: 480 };
  assertEqual(video.scaleArgsForFrameSizes([vga, vga, vga]), []);
});

test('scaleArgsForFrameSizes: mixed frames scale to the FIRST frame size', () => {
  const vga = { width: 640, height: 480 };
  const qqvga = { width: 160, height: 120 };
  assertEqual(video.scaleArgsForFrameSizes([vga, vga, qqvga, qqvga]), ['-vf', 'scale=640:480']);
  assertEqual(video.scaleArgsForFrameSizes([qqvga, vga]), ['-vf', 'scale=160:120']);
});

test('scaleArgsForFrameSizes: nothing to encode, or no readable first frame, means no filter', () => {
  assertEqual(video.scaleArgsForFrameSizes([]), []);
  assertEqual(video.scaleArgsForFrameSizes(null), []);
  assertEqual(video.scaleArgsForFrameSizes([null, null]), []);
});

test('scaleArgsForFrameSizes: an unreadable LATER frame is treated as a mismatch (scaling a same-size frame is a no-op, mis-scaling is worse)', () => {
  const vga = { width: 640, height: 480 };
  assertEqual(video.scaleArgsForFrameSizes([vga, null]), ['-vf', 'scale=640:480']);
});

summarize();
