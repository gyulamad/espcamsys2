#!/usr/bin/env python3
"""Stands in for person_scan.py in test_alarm_sounds_e2e.js: every clip has a person in it."""
import json, sys
a = sys.argv
open(a[a.index('--thumbnail') + 1], 'wb').write(b'\xff\xd8\xff\xe0fakejpeg')
print(json.dumps({'ok': True, 'person': True, 'confidence': 0.9, 'frameIndex': 0, 'framesRead': 1, 'framesAnalysed': 1}))
