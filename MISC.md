# MISC — everything that has no other home

*The odd documents, meta-information and small facts of the ESP32-CAM Home Security System. The main documents are [README.md](README.md) (overview), [ASSEMBLY.md](ASSEMBLY.md) (build a board), [SETUP.md](SETUP.md) (set the system up), [MANUAL.md](MANUAL.md) (daily use), [DEPLOY.md](DEPLOY.md) (ship a new version) and [DEVELOP.md](DEVELOP.md) (development).*

## About this documentation

Until F-32, everything lived in one `INSTALL.md`, which grew too fat to maintain. It was split sentence by sentence: every statement was checked against the code and either moved to the document that owns that topic, or dropped as outdated. The ownership rules, so new content lands in the right file:

- **README.md** — what the project is, and the map of the documents. No how-to.
- **ASSEMBLY.md** — everything that happens on a *board* or on the developer's laptop until the firmware runs: hardware, flashing, the serial settings, the on-device detection, the detector's live view.
- **SETUP.md** — everything that happens *on the Pi* to bring the system up from flashed boards: relay, dashboard, Apache, Tor, keys, end-to-end verification — and the boards' cable-free setup Wi-Fi, which is part of commissioning.
- **MANUAL.md** — everything a user does *with the running system*: the dashboard pages, recording, recordings and the person check, the detector's calibrate and reset menus, notifications, the log, troubleshooting.
- **DEPLOY.md** — everything about *changing the software of a running system*: relay and dashboard updates, staged settings, over-the-air firmware, upgrades from older versions.
- **DEVELOP.md** — tests, coverage, toolchain, generated code, checks — everything a developer runs in the repository.
- **MISC.md** — this file. Anything that does not belong to one of the above: meta-information, snapshots, licences, glossary.

Cross-links between the documents are relative Markdown links with anchors; `tests/shell/test_docs.sh` fails the run when a link points at a file or heading that does not exist, or when code comments still name a document that no longer holds that topic. When you move a section, keep anchors stable or update the links — `./run_tests.sh` is the checker.

## Environment snapshots

Two committed snapshots record the machines this project runs on, in the format `capture-env.sh` produces:

- `dev-2026-10-23.md` — the developer laptop (Ubuntu 24.04, g++ 13, arduino-cli state at the time).
- `relay-2026-10-23.md` — the Pi (Raspberry Pi 5, Debian 13, Node 24, PHP 8.4, Tor 0.4.9, the esp32 core 3.3.12).

Regenerate one with `./capture-env.sh` and commit it with a new date in the name; see [DEVELOP.md](DEVELOP.md#environment-snapshots).

## Security review of the setup mode

`F-21-S10-security-review.md` at the repo root is the findings document of the security review of the boards' setup Wi-Fi (code reading + fuzz tests; the fuzz test is registered in `run_tests.sh` as `test_setup_fuzz`). Its findings F1–F3 are fixed; F4 (CSRF-token entropy before the radio is up) is open and to be verified on hardware. It stays at the root because `run_tests.sh` points at it.

## Licences

- The project code itself has no licence file yet; ask the repository owner before redistributing.
- The YOLO model weights used by the person check are published by Ultralytics under the **AGPL-3.0** — check that it fits your use (see [MANUAL.md](MANUAL.md#2-get-the-model-once-on-your-laptop-or-on-the-pi)).
- The dashboard's fonts (Share Tech Mono, Barlow) are self-hosted in `php/cameras/fonts/`, with their licence in `OFL.txt` (SIL Open Font License).
- `esp-tflite-micro` and the person-detection model data come from Espressif's repository (Apache-2.0); the Arduino-ESP32 core is Apache-2.0 as well.

## Glossary

| Term | Meaning |
|---|---|
| **relay** | `nodejs/camera-relay/server.js` — receives the boards' frames, serves them to the dashboard, records. |
| **camKey / API_KEY** | The long random string shared by the relay's `config.js` (`camKey`) and every board (`API_KEY`); flashed into the boards, so rotate it with a serial cable (see [SETUP.md](SETUP.md#5-before-you-consider-this-done)). |
| **control key** | A second key (`controlKey` / `relay_control_key`) that protects everything the dashboard does against the relay. |
| **master password** | The WPA2 password of a board's setup Wi-Fi (`SETUP_PASSWORD`), default `Admin1234` until the first setup. |
| **push port** | The relay's raw TCP port (8081) the cameras stream JPEG frames to. |
| **discovery** | UDP 8082: a board that lost the relay asks the network where it is; the relay proves its identity with an HMAC over the board's nonce (see [SETUP.md](SETUP.md#cameras-find-the-relay-by-themselves-the-pis-address-may-change)). |
| **pre-roll** | The rolling buffer of the last seconds of every camera in relay RAM, so a clip starts before its trigger. |
| **mux** | One long-lived stream (`GET /mux` on the relay, `mux.php` on the dashboard) that carries all live pictures, detector readings and recording states. |
| **armed (SETUP_MODE=1)** | A board told to open its setup Wi-Fi at its next restart instead of working normally; the dashboard shows a red banner until it reports back. |
| **staged settings** | A `KEY=value` line PUT to the relay (`/device-settings/<type>`) that boards with a missing setting fetch instead of waiting for a serial cable (see [DEPLOY.md](DEPLOY.md#missing-settings-after-a-firmware-update-no-usb-cable-needed)). |
| **fleet line** | The staged line for every board of a type: `device-settings/<type>/_fleet.txt`; a per-board `<type>/<id>.txt` wins over it. |
| **gate (dark/still)** | The detector's cheap pre-check before running the model: brightness below `DARK_THRESH` or no motion since `MOTION_HOLD_S` pauses it (see [ASSEMBLY.md](ASSEMBLY.md#darkness-and-motion-gate-fewer-false-positives-less-work)). |
| **person check** | The relay-side YOLO scan that sorts recordings without a person into the archive (see [MANUAL.md](MANUAL.md#sorting-out-footage-without-a-person)). |
| **archive** | `recordings/<camera>/no-person/` — clips the person check found nobody in; restorable from the dashboard. |
| **WATCH** | The dashboard button that switches a resting detector's live view on for a while. |
