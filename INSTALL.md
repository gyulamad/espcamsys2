# ESP32-CAM Home Security System — Install

This document was **split into separate documents (F-32)** — the old single file had grown too fat to maintain. Everything that lived here was checked against the code, sentence by sentence, and moved to the document that owns its topic:

| Read … | when you want to … |
|---|---|
| [README.md](README.md) | know what this project is, and see the map of all documents |
| [ASSEMBLY.md](ASSEMBLY.md) | build the camera system from sketch: hardware, flashing the boards (recorder / person detector), serial settings, the on-device detection and its live view |
| [SETUP.md](SETUP.md) | set the system up on an installed Pi with already-flashed boards: relay, dashboard, Apache, Tor, keys, end-to-end verification, and the boards' cable-free setup Wi-Fi |
| [MANUAL.md](MANUAL.md) | use the running system: dashboard, recording ON/OFF, recordings and the person check, detector calibration, settings pages, resets, notifications, log, troubleshooting |
| [DEPLOY.md](DEPLOY.md) | ship a new version: relay and dashboard updates, staged settings, over-the-air firmware, one-command deploys (deploy_all.sh), upgrades from older versions |
| [DEVELOP.md](DEVELOP.md) | work on the code: tests, coverage, compiling the sketches, the generated schema, the security checks |
| [MISC.md](MISC.md) | everything else: how the documents are organised, environment snapshots, the setup-mode security review, licences, glossary |

The old `INSTALL.md` is kept only as this pointer page so existing links keep working.
