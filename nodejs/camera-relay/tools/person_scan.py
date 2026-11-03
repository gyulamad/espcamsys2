#!/usr/bin/env python3
"""person_scan.py — does this recording contain a person?

Run by the relay (nodejs/camera-relay/lib/personscan.js builds the command line); it can also be run by
hand to try a model on a clip:

    python3 tools/person_scan.py --model models/person.onnx --video clip.mp4 --thumbnail clip.mp4.thumb.jpg

It reads the clip frame by frame, runs a YOLO-style ONNX detector (OpenCV's DNN module, CPU only — no
PyTorch, no GPU) and STOPS at the first frame with a person: that frame is saved as the thumbnail (with the
person boxed) so the dashboard can show who is in the clip without anybody playing it.

The ONE line printed on stdout is a JSON object:

    {"ok": true,  "person": true,  "confidence": 0.81, "frameIndex": 42, "framesRead": 43, "framesAnalysed": 43}
    {"ok": true,  "person": false, "framesRead": 300, "framesAnalysed": 300}
    {"ok": false, "error": "..."}            (exit status 1: no verdict — the caller must keep the clip)

"person": false is only ever answered after the WHOLE clip was read; a clip that cannot be opened, holds no
frames or stops early (truncated / corrupt) is "ok": false, never "no person", so a damaged recording can
not be mistaken for an empty one and thrown away.

Models understood (class 0 = person, as in COCO):
  * YOLOv5/v8/v11 style, output (1, 4+classes, N)       rows: cx, cy, w, h, class scores...
  * end-to-end (YOLOv10/YOLO26 style), output (1, N, 6)  rows: x1, y1, x2, y2, score, class

Layout: pure decoding (decode_person, letterbox_geometry), the detector (OnnxPersonDetector), the clip walk
(scan_video, which takes ANY callable frame -> Detection|None so tests need no model) and main().
"""

import argparse
import json
import os
import sys
from collections import namedtuple

PERSON_CLASS = 0
DEFAULT_CONFIDENCE = 0.4      # a missed person costs more than a false alarm, so below the usual 0.5
DEFAULT_IMGSZ = 640
DEFAULT_NICE = 10             # the Pi still has to serve the cameras while this runs
TRUNCATED_BELOW = 0.9         # fewer frames than this share of the clip's own frame count = cut short
JPEG_QUALITY = 85

# box is (x1, y1, x2, y2) in whatever coordinates the producer worked in (model input, then frame).
Detection = namedtuple('Detection', 'confidence box')
ScanResult = namedtuple('ScanResult', 'person confidence frame_index frames_read frames_analysed frame detection')


class ScanError(Exception):
    """The clip could not be judged (not opened, empty, cut short). Never means 'no person'."""


# ── Pure decoding ────────────────────────────────────────────────────────

def letterbox_geometry(width, height, size):
    """How a width x height frame is fitted into a size x size square keeping its aspect ratio.
    -> (scale, pad_x, pad_y, new_width, new_height)"""
    scale = min(size / width, size / height)
    new_w, new_h = max(1, round(width * scale)), max(1, round(height * scale))
    return scale, (size - new_w) // 2, (size - new_h) // 2, new_w, new_h


def box_to_frame(box, scale, pad_x, pad_y, width, height):
    """A box in model-input coordinates -> the original frame's, clamped to it."""
    x1, y1, x2, y2 = box
    clamp = lambda v, hi: int(max(0, min(hi, v)))  # noqa: E731
    return (clamp((x1 - pad_x) / scale, width - 1), clamp((y1 - pad_y) / scale, height - 1),
            clamp((x2 - pad_x) / scale, width - 1), clamp((y2 - pad_y) / scale, height - 1))


def _as_rows(output):
    """Normalises a model output to a list of rows plus a flag: True when the rows are end-to-end ones."""
    shape = tuple(output.shape)
    if len(shape) == 3 and shape[0] == 1:
        shape, output = shape[1:], output[0]
    if len(shape) != 2:
        raise ScanError(f'unexpected model output shape {tuple(output.shape)}')
    if shape[1] == 6 and shape[0] != 6:
        return output, True
    if shape[0] < shape[1]:
        return output.T, False       # (4+classes, N) -> N rows
    return output, False


def decode_person(output, threshold):
    """The most confident person in one model output, or None when there is none at/above the threshold.
    No non-maximum suppression: only whether somebody is there matters, and the best box is enough."""
    rows, end_to_end = _as_rows(output)
    best = None
    for row in rows:
        if end_to_end:
            x1, y1, x2, y2, score, cls = (float(v) for v in row[:6])
            if int(cls) != PERSON_CLASS:
                continue
            box = (x1, y1, x2, y2)
        else:
            if len(row) < 5:
                raise ScanError('model output rows have no class scores')
            score = float(row[4 + PERSON_CLASS])
            cx, cy, w, h = (float(v) for v in row[:4])
            box = (cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2)
        if score >= threshold and (best is None or score > best.confidence):
            best = Detection(score, box)
    return best


# ── The detector ─────────────────────────────────────────────────────────

class OnnxPersonDetector:
    """frame (BGR numpy image) -> Detection (box in FRAME coordinates) or None."""

    def __init__(self, model_path, imgsz=DEFAULT_IMGSZ, threshold=DEFAULT_CONFIDENCE):
        import cv2
        self._cv2 = cv2
        if not os.path.isfile(model_path):
            raise ScanError(f'model file not found: {model_path}')
        self._net = cv2.dnn.readNetFromONNX(model_path)
        self._imgsz = imgsz
        self._threshold = threshold

    def __call__(self, frame):
        cv2 = self._cv2
        height, width = frame.shape[:2]
        scale, pad_x, pad_y, new_w, new_h = letterbox_geometry(width, height, self._imgsz)
        resized = cv2.resize(frame, (new_w, new_h), interpolation=cv2.INTER_LINEAR)
        canvas = cv2.copyMakeBorder(resized, pad_y, self._imgsz - new_h - pad_y, pad_x, self._imgsz - new_w - pad_x,
                                    cv2.BORDER_CONSTANT, value=(114, 114, 114))
        self._net.setInput(cv2.dnn.blobFromImage(canvas, 1 / 255.0, (self._imgsz, self._imgsz), swapRB=True))
        found = decode_person(self._net.forward(), self._threshold)
        if found is None:
            return None
        return Detection(found.confidence, box_to_frame(found.box, scale, pad_x, pad_y, width, height))


# ── Walking a clip ───────────────────────────────────────────────────────

def scan_video(video_path, detect, stride=1, open_capture=None):
    """Reads the clip and returns a ScanResult; raises ScanError when it cannot be judged.

    detect       callable frame -> Detection | None
    stride       analyse every Nth frame (the others are skipped cheaply); 1 = every frame
    open_capture video path -> cv2.VideoCapture-like (a test seam; defaults to cv2.VideoCapture)
    """
    if stride < 1:
        raise ScanError('stride must be at least 1')
    if open_capture is None:
        import cv2
        open_capture = cv2.VideoCapture
    cap = open_capture(video_path)
    try:
        if not cap.isOpened():
            raise ScanError('the video could not be opened')
        expected = int(cap.get(7))    # cv2.CAP_PROP_FRAME_COUNT; 0 or negative when unknown
        read = analysed = 0
        while True:
            if not cap.grab():
                break
            index = read
            read += 1
            if index % stride:
                continue
            ok, frame = cap.retrieve()
            if not ok or frame is None:
                raise ScanError(f'frame {index} could not be decoded')
            analysed += 1
            found = detect(frame)
            if found is not None:
                return ScanResult(True, found.confidence, index, read, analysed, frame, found)
    finally:
        cap.release()
    if read == 0:
        raise ScanError('the video holds no frames')
    if expected > 0 and read < expected * TRUNCATED_BELOW:
        raise ScanError(f'the video stopped after {read} of {expected} frames (truncated or corrupt)')
    return ScanResult(False, None, None, read, analysed, None, None)


def write_thumbnail(frame, detection, path):
    """Saves the frame as a JPEG with the person boxed. Written beside the target and renamed into place,
    so the dashboard never sees half a picture."""
    import cv2
    picture = frame.copy()
    x1, y1, x2, y2 = detection.box
    cv2.rectangle(picture, (x1, y1), (x2, y2), (0, 200, 0), 2)
    temp = path + '.tmp.jpg'
    if not cv2.imwrite(temp, picture, [cv2.IMWRITE_JPEG_QUALITY, JPEG_QUALITY]):
        raise ScanError('the thumbnail could not be written')
    os.replace(temp, path)


def result_to_json(result):
    """The one JSON line main() prints for a finished scan."""
    if not result.person:
        return {'ok': True, 'person': False, 'framesRead': result.frames_read, 'framesAnalysed': result.frames_analysed}
    return {'ok': True, 'person': True, 'confidence': round(result.confidence, 3), 'frameIndex': result.frame_index,
            'framesRead': result.frames_read, 'framesAnalysed': result.frames_analysed}


# ── Command line ─────────────────────────────────────────────────────────

def parse_args(argv):
    p = argparse.ArgumentParser(description='Finds out whether a recording contains a person.')
    p.add_argument('--model', required=True, help='YOLO ONNX model (class 0 = person)')
    p.add_argument('--video', required=True)
    p.add_argument('--thumbnail', required=True, help='where the picture of the first person is saved')
    p.add_argument('--confidence', type=float, default=DEFAULT_CONFIDENCE)
    p.add_argument('--stride', type=int, default=1, help='analyse every Nth frame')
    p.add_argument('--imgsz', type=int, default=DEFAULT_IMGSZ)
    p.add_argument('--nice', type=int, default=DEFAULT_NICE)
    args = p.parse_args(argv)
    if not 0 < args.confidence <= 1:
        p.error('--confidence must be above 0 and at most 1')
    if args.stride < 1:
        p.error('--stride must be at least 1')
    if args.imgsz < 32 or args.imgsz % 32:
        p.error('--imgsz must be a multiple of 32')
    return args


def run(args, make_detector=OnnxPersonDetector):
    """Does the whole job for parsed arguments and returns the JSON-able answer (raises ScanError)."""
    if not os.path.isfile(args.video):
        raise ScanError(f'video not found: {args.video}')
    detector = make_detector(args.model, args.imgsz, args.confidence)
    result = scan_video(args.video, detector, args.stride)
    if result.person:
        write_thumbnail(result.frame, result.detection, args.thumbnail)
    return result_to_json(result)


def main(argv=None, make_detector=OnnxPersonDetector):
    args = parse_args(sys.argv[1:] if argv is None else argv)
    try:
        os.nice(args.nice)
    except (OSError, AttributeError):
        pass    # not allowed / not available: run at normal priority
    try:
        answer = run(args, make_detector)
    except ScanError as e:
        print(json.dumps({'ok': False, 'error': str(e)}))
        return 1
    except Exception as e:    # a broken model, a cv2 error: still an answer the relay can log, never a silent "no person"
        print(json.dumps({'ok': False, 'error': f'{type(e).__name__}: {e}'}))
        return 1
    print(json.dumps(answer))
    return 0


if __name__ == '__main__':
    sys.exit(main())
