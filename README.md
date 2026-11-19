# ESP32-CAM Home Security System

[![Run Project Tests](https://github.com/gyulamad/espcamsys2/actions/workflows/tests.yml/badge.svg)](https://github.com/gyulamad/espcamsys2/actions/workflows/tests.yml)

A small, self-hosted camera security system built from cheap ESP32-CAM boards and a Raspberry Pi (or any always-on Linux box). It has three pieces:

1. **ESP32-CAM devices** — capture JPEGs, push them to the Pi over Wi-Fi, and (optionally) record on trigger
2. **`server.js` relay** — runs on the Pi, receives frames, re-serves them as live pictures (one `GET /mux` stream), and turns recording sessions into `.mp4` files
3. **PHP dashboard** — runs on the Pi, shown to you over a Tor hidden service, proxies each camera's stream/controls from the relay

```
[ESP32-CAM] --push JPEG--> [server.js relay :8080] <--fetch-- [PHP dashboard] <--Tor--> [you, anywhere]
```

Everything assumes the Pi is the only thing with a public-facing address, and that address is a `.onion` — nothing is port-forwarded on your router.

There is also an **optional, separate sketch** (`ESP32_CAM_TFLite_Person`) that runs on-device person detection instead of streaming — see ASSEMBLY.md if you want to try that on a spare board.

## What it does

- **Live pictures everywhere, one connection.** The dashboard (and the two SIMPLE pages) hold exactly one long-lived request (`mux.php`) that carries every camera's picture, every paired person detector's picture and readings, and the cameras' recording state — so the browser's ~6-connections-per-address limit is never a problem.
- **Recording that does not miss the start.** The relay keeps a rolling pre-roll buffer of the last few seconds of every camera, so every clip (alarm, person detector, RECORD button) begins *before* the trigger.
- **Recording ON / OFF.** Per camera or all at once, timed or indefinite, so a busy room does not fill the disk with clips of you.
- **Person detection on the boards** (TensorFlow Lite Micro) with a darkness/motion gate, a live view for aiming and tuning, and browser calibration.
- **Person check for the footage** (YOLO on the Pi): recordings without a person in them are sorted out automatically, and each clip gets a thumbnail of the first person it found.
- **Finds the relay by itself.** When the Pi's address changes, the boards ask the network where the relay went (with a proof that only the key holder can answer) and re-store the address.
- **Over-the-air updates.** One script compiles and publishes the firmware; every board polls, downloads, flashes and reboots itself. Settings survive everything short of an erased flash, and new settings can be staged on the relay so boards pick them up without a cable.
- **Cable-free setup.** A board can open its own Wi-Fi and show a settings page, so no case has to be opened for a reconfiguration.
- **Logs you can actually read.** Boards send what they would print to serial to the relay; one plain-text file answers "what happened, when, and why".
- **Notifications** (Telegram or other channels): a person in a recording, a disk almost full — a message with the thumbnail reaches you without opening the dashboard.

## Documentation

The old single `INSTALL.md` was split into documents you can actually maintain (F-32). Start here:

| Document | Audience | What it covers |
|---|---|---|
| [ASSEMBLY.md](ASSEMBLY.md) | developer | Building the system from sketch: hardware you need, flashing the ESP32-CAM boards (recorder and person detector), the serial settings, the on-device detection gate and the detector's live view. |
| [SETUP.md](SETUP.md) | user | Setting the system up on an installed Pi with already-flashed boards: the relay, the dashboard, Apache (protect/HTTPS), the Tor hidden service, the keys, end-to-end verification, and the cable-free setup Wi-Fi of the boards. |
| [MANUAL.md](MANUAL.md) | user | Daily use: the dashboard and its pages, recording ON/OFF, recordings and the person check, the detector's live view and calibration, settings pages, resets, notifications, the relay log, the OTA & LOGS page and troubleshooting. |
| [DEPLOY.md](DEPLOY.md) | developer | Shipping a new version: updating the relay and the dashboard, staging settings, over-the-air firmware updates, one-command deploys (deploy_all.sh), and upgrading older installations. |
| [DEVELOP.md](DEVELOP.md) | developer | Development: the test suite, coverage, compiling the sketches, the code-extraction markers, the device-settings schema, the security-patch check, environment snapshots. |
| [MISC.md](MISC.md) | everyone | Everything else: how the documentation set is organised, environment snapshots, the security review of the setup mode, licences, a glossary. |

[INSTALL.md](INSTALL.md) remains only as a pointer to this list, so old links keep working.

## Repository layout

```
Arduino/ESP32_CAM_Recorder/      the streaming/recording sketch (every board gets a CAMERA_ID)
Arduino/ESP32_CAM_TFLite_Person/ the on-device person detector sketch (optional, separate)
Arduino/templates/               settings templates for the serial console, setup-credentials example
nodejs/camera-relay/             the relay (server.js + lib/, tools/person_scan.py, example.config.js)
php/cameras/                     the dashboard (pages, lib/, js/, fonts, example.config.php)
apache/                         Apache snippets: folder protection, hardening, optional HTTPS, sudoers
tools/                           build/test helpers (compile_sketches.sh, gen_device_schema.sh, camdash-power.sh, ...)
tests/                           C++, Node.js, end-to-end, PHP, DOM/browser, Python and shell tests
3d/                              FreeCAD model and STL exports of a printable camera box (box + lid)
deploy.sh                        copies the dashboard into the web folder on the Pi
ota-deploy.sh                    compiles and publishes firmware for over-the-air updates
deploy_all.sh                    pulls (with --branch=NAME) and deploys everything that changed: tests, dashboard, settings, firmware, relay (see DEPLOY.md)
run_tests.sh                     runs every test suite (see DEVELOP.md)
capture-env.sh                   records an environment snapshot (see DEVELOP.md)
```

## Configuration files (never committed)

`config.js` (relay), `config.php` (dashboard), `ota.conf` (OTA deploy), `Arduino/templates/*.txt` (real settings templates) and `Arduino/<sketch>/setup_credentials.local.h` hold your secrets. All are listed in `.gitignore` — copy the shipped `example.*` files and fill them in; keep backups somewhere safe (a fresh clone has none of them).
