# ESP32-CAM Home Security System — Deploy (shipping a new version)

*For developers: how to get a new version of the relay, the dashboard or the firmware onto your running system. For the one-time setup of the system see [SETUP.md](SETUP.md); for daily use see [MANUAL.md](MANUAL.md); for building a board from scratch see [ASSEMBLY.md](ASSEMBLY.md).*

## The order of an update

The system has three parts that are updated together, in this order:

1. **The relay** (`nodejs/camera-relay/`): copy the new folder over the old one and **restart the relay process** — copying files does not change the running one. Firmware works with an older relay in most cases (each feature's notes below say when not), but the reverse is not always true: update the relay first.
2. **The dashboard** (`php/cameras/`): run `sudo ./deploy.sh` from the repo root.
3. **The boards** (firmware): reflash with a cable, or publish over the air with `./ota-deploy.sh` (below).

When a feature spans several of these (the live view, the Wi-Fi display, in-band alarms, device settings), its documentation says which versions have to be current before the feature appears. The general rule from the detector's live view holds: **update the Pi first, then the board**.

A quick check that the relay is actually running the new code: `curl -s -H "X-Control-Key: YOUR_CONTROL_KEY" http://<relay>:8080/status` — the log starts each run with `relay started (pid …)`, and features like pre-roll show up in the status.

## Deploying a new version in one go: `deploy_all.sh`

On the Pi, in the repository, as the user who runs the relay (not as root: the script asks for root by itself, for the dashboard copy only):

```bash
./deploy_all.sh --branch=master --dry-run     # what would be done: pulls nothing, changes nothing
./deploy_all.sh --branch=master --run-tests   # the real thing: pull, tests, deploy
```

`--branch=NAME` makes the script do the pull itself: it fetches that branch of `origin`, checks it out and fast-forwards it, and what changed between the version **before** and **after** the pull is what gets deployed. It refuses to pull with uncommitted changes, or when the local branch has commits `origin` does not have (nothing is switched or deployed then). Without it, `git pull` yourself first and run `./deploy_all.sh`.

It deploys only what changed since the version that is running, **in this order**, and stops at the first step that fails:

1. `--run-tests`: `./run_tests.sh` (with `--no-sketch-compile` when no sketch changed). A failure stops everything before anything is touched.
2. `php/` changed: `sudo ./deploy.sh`.
3. A sketch's `settings_schema.h` changed: the settings are **staged on the relay** (`PUT /device-settings/<type>`) from `Arduino/templates/recorder.txt` (recorder) or `Arduino/templates/person.txt` (detector) — the files you keep from your first flash. The lines that are per board or secret (`WIFI`, `SERVER_HOST`, `HTTP_PORT`, `PUSH_PORT`, `API_KEY`, `CAMERA_ID`, `DETECTOR_ID`, `SETUP_PASSWORD`, `SETUP_MODE`) are **left out**: the relay never takes them from a fleet line, and a staged line can be fetched by every board of the type. A board that lacks a new setting then fills it in by itself after the update (see [*Missing settings after a firmware update*](#missing-settings-after-a-firmware-update-no-usb-cable-needed) below). The staged fleet line is replaced by this one.
4. A sketch changed: `./ota-deploy.sh recorder|detector|all --wait SECS` (default 600, change with `--wait`). Every camera of that type is updated and watched; one that does not come back stops the deploy.
5. `nodejs/` changed: `npm ci` (only if `package.json` / the lockfile changed), then `POST /restart` and a wait until the relay answers again. The relay is the **last** on purpose: if a camera got a bad firmware, the relay is still the old, working one, so you can still reach the camera and put the last good version back. When the firmware step fails the script says so, does not restart the relay and prints the commands: `git checkout <old revision> && ./ota-deploy.sh <type> --wait SECS`.

"Changed" is compared with the revision in `.deployed-rev` (written at the end of a good run, not for a tree with uncommitted changes); the first time with the version the Pi had before the pull (before `--branch` pulled, or else before your own `git pull`, `ORIG_HEAD`). Without any of these, name it with `--since REV`, or deploy everything with `--all`. Everything the script needs (`ota.conf`, the settings files, the tools) is checked **before** the first step, so a missing file does not leave a deploy half done. The restart needs the relay to run under systemd or pm2 (see `POST /restart` in [MANUAL.md](MANUAL.md)). Checking that the cameras stream and the dashboard works is still done by hand afterwards (the end-to-end checks of [SETUP.md](SETUP.md)).

The script is tested by `tests/shell/test_deploy_all.sh` (against fake deploy/ota/curl tools; registered in `run_tests.sh`).

## Missing settings after a firmware update (no USB cable needed)

Settings have no defaults, so a firmware that needs **one more setting** than a board has stored can't run: at boot the board lists what is missing and waits. You used to need a USB cable for that. If the board's **Wi-Fi, server, port, API key and id** are stored (so it can reach the relay), it now asks the relay for the missing settings instead — you stage them on the relay once, ideally *before* you roll the new firmware out.

**What the board does.** After printing what is missing it gives the serial port **5 seconds** to itself (a person who types — anything at all — always wins, and then the board never restarts behind their back). Then it joins Wi-Fi (up to 20 s), asks the relay every 5 s for up to **30 s**, and:

- a staged line arrives -> the missing settings in it are stored and the board restarts, complete;
- nothing arrives -> it restarts and tries again (about once a minute), until you stage something.

**What you do on the relay.** Send the missing settings as one line, in the same `KEY=value;KEY=value` form the serial console takes (control key in `X-Control-Key`, the `controlKey` from `config.js`). `<type>` is `recorder` or `detector`:

```bash
# for every recorder:
curl -X PUT -H "X-Control-Key: YOUR_CONTROL_KEY" --data-binary 'LOG_NEW_SETTING=30' \
     http://PI:8080/device-settings/recorder
# for one board only (its own line wins over the one for the type):
curl -X PUT -H "X-Control-Key: YOUR_CONTROL_KEY" --data-binary 'LOG_NEW_SETTING=60' \
     http://PI:8080/device-settings/recorder/cam2
# remove what is staged (an empty body):
curl -X PUT -H "X-Control-Key: YOUR_CONTROL_KEY" --data-binary '' http://PI:8080/device-settings/recorder
```

The relay log shows what happened, with the setting **names only** (values can be passwords): `... staged settings for every recorder: LOG_NEW_SETTING` and, when a board asks, `cam2 (recorder) is missing settings (LOG_NEW_SETTING) and was sent the fleet line ...` — or a warning that nothing is staged for it, which is your cue to stage something. Staged files live in `nodejs/camera-relay/device-settings/` (`<type>/_fleet.txt` and `<type>/<id>.txt`; the folder is not in git — change it with `deviceSettingsDir` in `config.js`).

**Safety rules** (the relay can't reconfigure a working board):

- Only settings that are **missing or invalid** are taken from the relay. A setting that is stored and valid is never changed by it, whatever the staged line says. So you can't use this to change the Wi-Fi password, server or key of a board that works — that stays a serial job. (Changing the other stored settings of a working camera has its own mechanism: see [MANUAL.md, *Camera settings page*](MANUAL.md#camera-settings-page-a-cameras--settings-button).)
- The line is checked like typed input and is **all or nothing**: one bad value and nothing is stored (the serial log says why).
- It doesn't help when the settings needed to *reach* the relay are the ones missing or wrong (Wi-Fi, server, port, API key, id): those still need the serial port.
- The line travels over plain HTTP together with the camera key, like everything else between the cameras and the relay. Don't stage anything you wouldn't be happy to have on your LAN.

## Over-the-air firmware updates

Recompile on one machine, run one script, and every camera updates itself. The cameras can't be reached from outside (NAT), so they **poll**: about once a minute each board asks the relay which firmware is current; if that differs from what it runs it downloads it, flashes it and reboots. The version is the **git revision** you built from, and "different" (not "newer") triggers the update, so checking out an older commit and deploying it **downgrades** the cameras the same way.

### One-time preparation

1. **Core 3.x, partition scheme.** Both sketches need the Arduino-ESP32 core 3.x (they print its version at boot). Compile with the **Minimal SPIFFS (1.9MB APP with OTA/190KB SPIFFS)** scheme: two app slots of 1,966,080 bytes. The default scheme's slots (1,310,720) are too small for the person detector, and *Huge APP* has no second slot at all.
2. **Every camera needs one USB flash** with that scheme (and the new sketch, which contains the updater): the partition table cannot be changed over the air. Upload normally from the Arduino IDE — the board's settings are kept (they live in NVS, which a normal upload leaves alone). **Don't** tick *Erase All Flash Before Sketch Upload*: that wipes the settings.
3. **Relay:** set `controlKey` in `config.js` (the same key that protects the recording switch). Firmware is stored in `nodejs/camera-relay/firmware/` (not in git; change it with `firmwareDir`). Publishing needs the **control** key, never the camera key — the camera key is flashed into every board.
4. **Central machine** (where you compile; may be the Pi if it has `arduino-cli` with the esp32 core): `cp ota.example.conf ota.conf`, then fill in `RELAY_URL` and `CONTROL_KEY`. Check the board options with `arduino-cli board details -b esp32:esp32:esp32cam`; if your core doesn't accept `PartitionScheme=min_spiffs` in the FQBN, set `EXTRA_COMPILE_ARGS` in `ota.conf` (the example shows the build-property form).

### Deploying

```bash
./ota-deploy.sh all --wait 300      # or: recorder | detector
```

It writes the git revision into `fw_version.h` (gitignored, removed afterwards), compiles, refuses an image that doesn't fit a slot, and only when everything built publishes the binaries to the relay. With `--wait SECS` it then watches the relay until every device of the deployed type(s) runs the new version, prints a table (id, running version, state, last error) and exits non-zero if any device isn't updated. A tree with uncommitted changes deploys as `<revision>-dirty.t<time>` (with a warning), so dev builds always re-flash; commit first for a stable version.

### What you will see in the relay log

- `... published recorder firmware f5959f7 (1234567 bytes, md5 ...)` — the upload
- `cam1 is downloading recorder firmware f5959f7 (...)` — a board started
- `cam1 now runs f5959f7 (was e1c95ad)` — it rebooted into the new version; every log line also carries the version
- `WARN cam1 firmware update failed: md5_failed` — it tried and failed (other reasons: `http_404`, `short_write`, `no_ota_partition`, `no_length`, `http_err<N>`); it retries after 5 minutes
- A board that never shows up (weak Wi-Fi, no power) is `offline` in the status. Ask any time:
  `curl -s -H "X-Control-Key: YOUR_CONTROL_KEY" http://PI:8080/ota/status` — one line per device: `id type target running state last-seen last-error`, state `updated` / `pending` / `offline`. The relay only knows devices that polled since it last started.

### Rules and caveats

- **Adding a setting? Stage it BEFORE deploying.** Settings have no defaults, so after an update a board lacking a new setting can't run. If its Wi-Fi/server/port/key/id are stored it fetches the value from the relay (see *Missing settings after a firmware update* above) — but only what you staged:
  1. `curl -X PUT -H "X-Control-Key: ..." --data-binary 'NEW_KEY=value' http://PI:8080/device-settings/<type>`
  2. then `./ota-deploy.sh`.

  Staged first, the update is invisible (one extra restart of ~45 s). Staged afterwards, the camera restarts about once a minute until you stage it. A release that **changes the Wi-Fi / server / port / API key / id settings, renames a setting, or tightens a range** so that a stored value becomes invalid still needs a cable.
- A detector checks for an update from its network task between two pictures, so an update does not need anyone to stop watching.
- The camera keeps streaming during a download; the flash writes briefly stall the other CPU core. A weak power supply can brown out during the ~1.5 MB download — if a board resets mid-update, check its supply.
- A build that boots but can't reach the relay (bad release) can't be rescued over the air: **recover by cable** (USB upload of a good build; settings are kept).
- Plain HTTP on the relay's port for now, with the same trust as the rest of the camera traffic: anyone on the LAN who has the camera key could fetch the firmware, and the control key travels in clear to publish it. There is no signing, rollback or boot-loop protection yet; HTTPS is the planned next step.

## Upgrading a recorder to flash-stored settings

The recorder no longer has a `config.h`: its settings are stored in the board's flash. A camera that already runs the old firmware keeps running until you reflash it. After you do, it has no settings yet: open the Serial Monitor (115200, line ending **Newline**) and type them in (see [ASSEMBLY.md](ASSEMBLY.md#1-flash-each-esp32-cam-streamingrecording-sketch)) — keep the old `config.h` values at hand. A few names changed because flash keys are limited to 15 characters: `ALARM_ACTIVE_STATE` → `ALARM_ACTIVE`, `ALARM_RECORD_ALL_CAMERAS` → `ALARM_ALL_CAMS`, `PUSH_INTERVAL_MUL` → `PUSH_GAP_MUL`, and `REMOTE_LOG_*` → `LOG_*` (`REMOTE_LOG_ENABLED` → `LOG_ENABLED`, `…_MIN_LEVEL` → `LOG_MIN_LEVEL`, `…_ECHO_TO_SERIAL` → `LOG_ECHO`, `…_RETRY_MAX` → `LOG_RETRY_MAX`, `…_RETRY_PERIOD_SECONDS` → `LOG_RETRY_SEC`, `…_FLUSH_SECONDS` → `LOG_FLUSH_SEC`, `…_REPEAT_WINDOW_SECONDS` → `LOG_REPEAT_SEC`, `…_HEARTBEAT_SECONDS` → `LOG_HEARTBEAT`, `…_LOW_HEAP_BYTES` → `LOG_LOW_HEAP`). The old `config.h` can be deleted. Later firmware that adds a new setting asks only for that one.

## Upgrading a person detector to flash-stored settings

The person detector no longer has a `config.h` either. After reflashing it asks for its settings over serial (see [ASSEMBLY.md](ASSEMBLY.md#2-optional-flash-a-person-detector-instead-tflite-micro)) — keep the old `config.h` values at hand. Renamed settings (flash keys are limited to 15 characters): `PERSON_DETECTED_GPIO` → `PERSON_GPIO`, `PERSON_DETECTION_THRESHOLD` → `DETECT_THRESH`, `PERSON_CLEAR_THRESHOLD` → `CLEAR_THRESH`, `DETECTION_LOOP_DELAY_MS` → `LOOP_DELAY_MS`, `STREAM_JPEG_QUALITY` → `STREAM_JPEG_Q`, `STREAM_WRITE_TIMEOUT_S` → `STREAM_WR_TMO_S`, `ANNOUNCE_HEARTBEAT_SECONDS` → `ANN_HEARTBEAT`, `ANNOUNCE_RETRY_SECONDS` → `ANN_RETRY`. (The stream's user, password and port of the older LAN-server version no longer exist: the live view is pushed to the relay, see [ASSEMBLY.md, *live view*](ASSEMBLY.md#optional-see-the-detector-under-its-camera-on-the-dashboard-live-view--aim-and-tune-per-camera).) `TENSOR_ARENA_SIZE`, `PRINT_DETECTION_SCORES` and `PRINT_STARTUP_INFO` are now developer switches at the top of the `.ino`. The old `config.h` can be deleted.

## Upgrading from the version with camera power on/off

Cameras can no longer be switched off from the dashboard (pre-roll needs them streaming all the time), and the dashboard's "camera on" alarm setting is gone. (Switching **recording** ON/OFF still exists — see [MANUAL.md](MANUAL.md#switching-recording-on--off).)

1. **Relay first.** Copy the new `nodejs/camera-relay/` over the old one and **restart the relay process** (copying files does not change the running one). New firmware works with an older relay too (it falls back to the HTTP alarm), but you only get the no-gap alarm and pre-roll with the new relay. Add `preRollSeconds` to `config.js` if you want something other than 5. The relay sends one harmless "resume" byte to every camera when it connects, so a camera running the *old* firmware that happened to be switched off at upgrade time starts streaming again by itself.
2. **Dashboard.** Run `deploy.sh` (it now also removes the retired `control.php` from the web root).
3. **Firmware (whenever convenient).** Reflash the recorder boards with the new `ESP32_CAM_Recorder` sketch. This is what removes the gap in the footage right after an alarm (the old firmware's alarm request froze the camera until it finished); it also drops the unused pause code. Old firmware keeps working with the new relay in the meantime, using the HTTP alarm request as before — pre-roll works with either.
4. An existing `settings.json` with an `alarmPowerSeconds` value is fine; it is simply ignored.
