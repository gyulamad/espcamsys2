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

summarize();
