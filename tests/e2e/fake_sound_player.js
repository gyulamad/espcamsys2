#!/usr/bin/env node
'use strict';
// fake_sound_player.js — stands in for the audio player (ffplay) in test_alarm_sounds_e2e.js: appends the path it was
// asked to play to the file named by FAKE_PLAYER_LOG, then ends. FAKE_PLAYER_MODE=fail makes it exit with 1 (a speaker
// that does not work); =slow keeps it "playing" for two seconds.
const fs = require('fs');
const file = process.argv[process.argv.length - 1];
const mode = process.env.FAKE_PLAYER_MODE || '';
fs.appendFileSync(process.env.FAKE_PLAYER_LOG, `${file}\n`);
if (mode === 'fail') { console.error('no soundcards found'); process.exit(1); }
if (mode === 'slow') setTimeout(() => process.exit(0), 2000);
