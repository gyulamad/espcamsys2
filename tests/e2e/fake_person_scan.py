#!/usr/bin/env python3
"""Stands in for nodejs/camera-relay/tools/person_scan.py in test_person_scan_e2e.js: the verdict is the clip's own text.
PERSON -> thumbnail + person; EMPTY -> no person; SLOW -> sleeps (to see "processing");
SCORE:0.5 -> a person scored 0.5, found only when --confidence (the sensitivity) is at most 0.5; anything else -> crash."""
import json, re, sys, time

a = sys.argv
video = a[a.index('--video') + 1]
thumb = a[a.index('--thumbnail') + 1]
text = open(video, 'rb').read().decode('latin-1')
if 'SLOW' in text:
    time.sleep(1.5)
score = re.search(r'SCORE:([0-9.]+)', text)
if score:
    text = 'PERSON' if float(score.group(1)) >= float(a[a.index('--confidence') + 1]) else 'EMPTY'
if 'PERSON' in text:
    open(thumb, 'wb').write(b'\xff\xd8\xff\xe0fakejpeg')
    print(json.dumps({'ok': True, 'person': True, 'confidence': 0.9, 'frameIndex': 0, 'framesRead': 1, 'framesAnalysed': 1}))
elif 'EMPTY' in text:
    print(json.dumps({'ok': True, 'person': False, 'framesRead': 3, 'framesAnalysed': 3}))
else:
    print('Traceback: boom', file=sys.stderr)
    sys.exit(1)
