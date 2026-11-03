"""Unit tests for tools/person_scan.py — no model needed: the detector is a plain function, the videos are
generated with OpenCV. Run:  python3 -m unittest discover -s tests/python -v   (run_tests.sh does)."""

import contextlib
import io
import json
import os
import sys
import tempfile
import unittest

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', 'nodejs', 'camera-relay', 'tools'))
import person_scan as ps  # noqa: E402

import cv2  # noqa: E402


def write_video(path, frames):
    """A tiny MJPEG video of the given BGR frames (MJPG/.avi needs no extra codecs)."""
    h, w = frames[0].shape[:2]
    out = cv2.VideoWriter(path, cv2.VideoWriter_fourcc(*'MJPG'), 5, (w, h))
    for f in frames:
        out.write(f)
    out.release()


def blank(): return np.zeros((48, 64, 3), np.uint8)
def marked(): f = blank(); f[:, :] = 255; return f  # an all-white frame is "the person" for the fake detector


def fake_detector(frame):
    """Finds a 'person' in white frames only."""
    return ps.Detection(0.9, (8, 8, 40, 40)) if frame.mean() > 200 else None


class FakeCapture:
    def __init__(self, frames, reported_count=None, opened=True, fail_decode_at=None):
        self._frames, self._i, self._opened = frames, -1, opened
        self._count = len(frames) if reported_count is None else reported_count
        self._fail_at = fail_decode_at
        self.released = False
    def isOpened(self): return self._opened
    def get(self, prop): return self._count
    def grab(self):
        self._i += 1
        return self._i < len(self._frames)
    def retrieve(self):
        if self._i == self._fail_at: return False, None
        return True, self._frames[self._i]
    def release(self): self.released = True


class DecodeTests(unittest.TestCase):
    def test_raw_yolo_output_finds_best_person(self):
        out = np.zeros((1, 84, 100), np.float32)          # 100 candidate boxes (real models: 8400), 80 classes
        out[0, 0:4, 1] = (100, 100, 20, 40); out[0, 4, 1] = 0.3     # weak person
        out[0, 0:4, 3] = (200, 150, 60, 80); out[0, 4, 3] = 0.8     # strong person
        out[0, 0:4, 4] = (10, 10, 10, 10); out[0, 5, 4] = 0.99      # a different class (bicycle)
        found = ps.decode_person(out, 0.4)
        self.assertAlmostEqual(found.confidence, 0.8, places=5)
        self.assertEqual(found.box, (170.0, 110.0, 230.0, 190.0))

    def test_raw_output_below_threshold_is_none(self):
        out = np.zeros((1, 84, 100), np.float32); out[0, 4, 0] = 0.39
        self.assertIsNone(ps.decode_person(out, 0.4))

    def test_other_classes_are_not_people(self):
        out = np.zeros((1, 84, 100), np.float32); out[0, 5:, :] = 0.95
        self.assertIsNone(ps.decode_person(out, 0.4))

    def test_end_to_end_output(self):
        out = np.array([[[1, 2, 30, 40, 0.7, 0], [5, 5, 9, 9, 0.99, 2], [0, 0, 0, 0, 0.0, 0]]], np.float32)
        found = ps.decode_person(out, 0.5)
        self.assertAlmostEqual(found.confidence, 0.7, places=5)
        self.assertEqual(found.box, (1.0, 2.0, 30.0, 40.0))

    def test_end_to_end_none(self):
        self.assertIsNone(ps.decode_person(np.array([[[1, 2, 30, 40, 0.2, 0]]], np.float32), 0.5))

    def test_bad_shapes_raise(self):
        with self.assertRaises(ps.ScanError):
            ps.decode_person(np.zeros((7,), np.float32), 0.5)
        with self.assertRaises(ps.ScanError):
            ps.decode_person(np.zeros((1, 3, 400), np.float32), 0.5)   # rows without class scores

    def test_letterbox_geometry_and_back(self):
        scale, px, py, nw, nh = ps.letterbox_geometry(1280, 720, 640)
        self.assertEqual((scale, px, py, nw, nh), (0.5, 0, 140, 640, 360))
        self.assertEqual(ps.box_to_frame((0, 140, 640, 500), scale, px, py, 1280, 720), (0, 0, 1279, 719))
        self.assertEqual(ps.box_to_frame((100, 240, 200, 340), scale, px, py, 1280, 720), (200, 200, 400, 400))


class ScanVideoTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)

    def path(self, name): return os.path.join(self.dir.name, name)

    def test_person_in_third_frame_stops_there(self):
        v = self.path('p.avi'); write_video(v, [blank(), blank(), marked(), blank(), blank()])
        r = ps.scan_video(v, fake_detector)
        self.assertTrue(r.person)
        self.assertEqual((r.frame_index, r.frames_read, r.frames_analysed), (2, 3, 3))   # never read frames 4, 5

    def test_no_person_reads_every_frame(self):
        v = self.path('n.avi'); write_video(v, [blank()] * 6)
        r = ps.scan_video(v, fake_detector)
        self.assertFalse(r.person)
        self.assertEqual((r.frames_read, r.frames_analysed), (6, 6))

    def test_stride_skips_frames_but_reads_them(self):
        seen = []
        def detect(frame): seen.append(1); return None
        r = ps.scan_video('x', detect, stride=3, open_capture=lambda p: FakeCapture([blank()] * 10))
        self.assertEqual((r.frames_read, r.frames_analysed, len(seen)), (10, 4, 4))   # frames 0, 3, 6, 9

    def test_capture_is_released_on_every_path(self):
        caps = []
        def opener(p): caps.append(FakeCapture([marked()])); return caps[-1]
        ps.scan_video('x', fake_detector, open_capture=opener)
        self.assertTrue(caps[0].released)

    def test_unopenable_video_is_an_error_not_no_person(self):
        with self.assertRaises(ps.ScanError):
            ps.scan_video(self.path('missing.avi'), fake_detector)

    def test_empty_video_is_an_error(self):
        with self.assertRaises(ps.ScanError):
            ps.scan_video('x', fake_detector, open_capture=lambda p: FakeCapture([], reported_count=0))

    def test_truncated_video_is_an_error(self):
        with self.assertRaises(ps.ScanError) as c:
            ps.scan_video('x', fake_detector, open_capture=lambda p: FakeCapture([blank()] * 3, reported_count=10))
        self.assertIn('truncated', str(c.exception))

    def test_unknown_frame_count_is_trusted(self):
        r = ps.scan_video('x', fake_detector, open_capture=lambda p: FakeCapture([blank()] * 3, reported_count=0))
        self.assertFalse(r.person)

    def test_undecodable_frame_is_an_error(self):
        with self.assertRaises(ps.ScanError):
            ps.scan_video('x', fake_detector, open_capture=lambda p: FakeCapture([blank()] * 3, fail_decode_at=1))

    def test_bad_stride(self):
        with self.assertRaises(ps.ScanError):
            ps.scan_video('x', fake_detector, stride=0, open_capture=lambda p: FakeCapture([blank()]))


class ThumbnailAndCliTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.video = os.path.join(self.dir.name, 'c.avi')
        self.thumb = os.path.join(self.dir.name, 'c.avi.thumb.jpg')

    def args(self, **kw):
        base = ['--model', 'm.onnx', '--video', self.video, '--thumbnail', self.thumb, '--nice', '0']
        for k, v in kw.items():
            base += [f'--{k}', str(v)]
        return base

    def run_main(self, argv, detector=lambda m, s, t: fake_detector):
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            code = ps.main(argv, detector)
        return code, json.loads(out.getvalue())

    def test_person_writes_thumbnail_and_reports(self):
        write_video(self.video, [blank(), marked(), blank()])
        code, answer = self.run_main(self.args())
        self.assertEqual(code, 0)
        self.assertEqual((answer['ok'], answer['person'], answer['frameIndex']), (True, True, 1))
        self.assertEqual(answer['confidence'], 0.9)
        picture = cv2.imread(self.thumb)
        self.assertEqual(picture.shape[:2], (48, 64))
        self.assertFalse(os.path.exists(self.thumb + '.tmp.jpg'))

    def test_no_person_writes_no_thumbnail(self):
        write_video(self.video, [blank()] * 3)
        code, answer = self.run_main(self.args())
        self.assertEqual((code, answer), (0, {'ok': True, 'person': False, 'framesRead': 3, 'framesAnalysed': 3}))
        self.assertFalse(os.path.exists(self.thumb))

    def test_missing_video_is_ok_false_exit_1(self):
        code, answer = self.run_main(self.args())
        self.assertEqual((code, answer['ok']), (1, False))
        self.assertIn('not found', answer['error'])

    def test_missing_model_is_ok_false(self):
        write_video(self.video, [blank()])
        code, answer = self.run_main(self.args(), ps.OnnxPersonDetector)
        self.assertEqual((code, answer['ok']), (1, False))
        self.assertIn('model file not found', answer['error'])

    def test_unexpected_exception_is_ok_false_never_no_person(self):
        write_video(self.video, [blank()])
        def broken(frame): raise RuntimeError('boom')
        code, answer = self.run_main(self.args(), lambda m, s, t: broken)
        self.assertEqual((code, answer['ok']), (1, False))
        self.assertIn('RuntimeError: boom', answer['error'])

    def test_argument_validation(self):
        for bad in (['--confidence', '0'], ['--confidence', '1.5'], ['--stride', '0'], ['--imgsz', '100']):
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                ps.parse_args(self.args() + bad)

    def test_unwritable_thumbnail_is_an_error(self):
        write_video(self.video, [marked()])
        self.thumb = os.path.join(self.dir.name, 'no-such-dir', 't.jpg')
        code, answer = self.run_main(self.args())
        self.assertEqual((code, answer['ok']), (1, False))


if __name__ == '__main__':
    unittest.main()
