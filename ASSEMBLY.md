# ESP32-CAM Home Security System — Assembly (build it from sketch)

*For developers: this is the full walkthrough for building the camera system from scratch — the hardware you need, flashing the boards, and what the firmware can do. If the Pi is already installed and the boards are already flashed, start with [SETUP.md](SETUP.md) instead. For an overview of the project and the rest of the documentation, see [README.md](README.md).*

The system has three pieces:

1. **ESP32-CAM devices** — capture JPEGs, push them to the Pi, and (optionally) record on trigger
2. **`server.js` relay** — runs on the Pi, receives frames, re-serves them as live pictures (one `GET /mux` stream), and turns recording sessions into `.mp4` files (set up in [SETUP.md](SETUP.md))
3. **PHP dashboard** — runs on the Pi, shown to you over a Tor hidden service, proxies each camera's stream/controls from the relay (set up in [SETUP.md](SETUP.md))

The boards only push frames outbound, so they work from any Wi-Fi network that can reach the Pi's `SERVER_HOST:PUSH_PORT`/`HTTP_PORT` — including a NAT'd guest network — with no port forwarding on the camera side.

## 0. What you need

- A Raspberry Pi (or any always-on Linux box) on your home network
- One or more ESP32-CAM (AI-Thinker) boards
- An FTDI/USB-serial programmer to flash the ESP32-CAMs
- Arduino IDE on your laptop, with the ESP32 board package installed
- SSH access to the Pi

A printable housing for a camera exists in `3d/`: a FreeCAD model (`camera-box2.FCStd`, `camera-box2_1.FCStd`) with STL exports of box and lid for both variants — print `camera-box2-Box.stl` + `camera-box2-lid.stl` (or the `_1` pair).

---

## 1. Flash each ESP32-CAM (streaming/recording sketch)

1. Install the ESP32 board package in Arduino IDE if you haven't already (Boards Manager → search "esp32" → install), and select **AI Thinker ESP32-CAM** as the board, and **Tools → Partition Scheme → "Minimal SPIFFS (1.9MB APP with OTA/190KB SPIFFS)"** (needed for over-the-air updates; see [DEPLOY.md](DEPLOY.md#over-the-air-firmware-updates)).
2. On your laptop, create a sketch folder containing these files together (this sketch used to be called `sketch_sep12a_camera2_behind_NAT` — it's since been renamed):
   - `ESP32_CAM_Recorder.ino`
   - `logic.h`
   - `remote_log.h`
   - `settings_logic.h`
   - `settings_schema.h`
   - `settings_sync.h`
   - `ota_logic.h`
   - `ota.h`
   - `relay_find_logic.h`
   - `relay_find.h`
   - `relay_health.h`
   - `setup_boot.h`
   - `setup_form.h`
   - `setup_logic.h`
   - `setup_mode.h`
   - `setup_session.h`

   (Simply copy every file of `Arduino/ESP32_CAM_Recorder/` — the sketch will not compile with one of them missing. `fw_version.h`, which the sketch includes only if it exists, is written by `ota-deploy.sh`; a sketch built by hand without it reports the firmware version `dev`.)

   There is **no config file to edit any more**: the camera's settings (Wi-Fi, relay address, camera id, API key, ...) are stored in the board's flash and typed in over the serial port after the first flash — see step 5 below.
3. Wire the FTDI programmer to the ESP32-CAM (GPIO0 to GND to enter flash mode), select the correct serial port, and hit **Upload**.
4. Disconnect GPIO0 from GND and power-cycle the board. Open the Serial Monitor at **115200 baud** and set its line ending to **Newline** (or Both NL & CR).
5. **Enter the settings.** A new board has none, so it shows what is missing and waits. Type settings as `KEY=value`, and several at once separated by `;`, then press Enter:

   ```
   CAMERA_ID=cam1;SERVER_HOST=192.168.4.9;PUSH_PORT=8081;HTTP_PORT=8080;API_KEY=<same long random string as camKey in the Pi's config.js>;PUSH_GAP_MUL=1.5
   WIFI=extender-1-ssid:extender-1-password:extender-2-ssid:extender-2-password
   ALARM_GPIO_PIN=13;ALARM_ACTIVE=LOW;ALARM_ALL_CAMS=0
   LOG_ENABLED=1;LOG_MIN_LEVEL=1;LOG_ECHO=1;LOG_RETRY_MAX=3;LOG_RETRY_SEC=300;LOG_FLUSH_SEC=10;LOG_REPEAT_SEC=30;LOG_HEARTBEAT=600;LOG_LOW_HEAP=30000
   ```

   You can send them as one long line or several lines; each line is checked as a whole (nothing from a line with a mistake is stored) and the camera tells you what is still missing. When everything is stored it restarts by itself. `HELP` lists every setting with what it means and what values are allowed.

   **No cable for the settings?** A board can also open its own WiFi and show a settings page for a phone: see [SETUP.md, "First setup without a cable"](SETUP.md#first-setup-without-a-cable-the-boards-own-setup-wifi). The firmware itself still has to get onto the board once.

   | Setting | Meaning |
   |---|---|
   | `WIFI` | Networks to join, as `ssid:password` pairs joined by `:` — any number up to 16 (the camera takes the strongest one in range and fails over if it drops). An open network is `ssid:` with an empty password. |
   | `SERVER_HOST` | Your Pi's LAN IP (or hostname). Use an **IP address**, even a stale one: if the Pi's address changes later the board finds the relay again by itself and replaces it (see [SETUP.md, *Cameras find the relay by themselves*](SETUP.md#cameras-find-the-relay-by-themselves-the-pis-address-may-change)), and an IP also tells it which subnet to search. |
   | `PUSH_PORT` | The relay's raw push port — must match `pushPort` in the Pi's `config.js` |
   | `HTTP_PORT` | The relay's HTTP port — must match `port` in the Pi's `config.js` |
   | `CAMERA_ID` | Unique per device (`cam1`, `cam2`, ...) — must match `config.php` on the Pi. Letters, digits, `_ . -` |
   | `API_KEY` | The same long random string as `camKey` in the Pi's `config.js` |
   | `PUSH_GAP_MUL` | Self-adapting push-rate backoff, 0.1–10 — leave at `1.5` unless tuning |
   | `ALARM_GPIO_PIN` | GPIO wired to an alarm input (`2`, `4`, `13`, `14` or `15`); `-1` turns the alarm feature off |
   | `ALARM_ACTIVE` | `LOW` or `HIGH`: the pin level that means "alarm!" (only asked for when the pin isn't `-1`) |
   | `ALARM_ALL_CAMS` | `0`: only this camera records; `1`: every camera does (only asked for when the pin isn't `-1`) |
   | `LOG_ENABLED` | `1`: also send the camera's log to the relay; `0`: serial only. The other `LOG_*` settings are only asked for when this is `1` — see [MANUAL.md, "Logging"](MANUAL.md#logging-finding-out-what-went-wrong) |

   **Special characters.** `;` separates settings and `:` separates the Wi-Fi fields, so a literal `;`, `:` or `\` inside a name or password is written `\;`, `\:` or `\\` — only when it is really there. Example: the password `pa:ss;word` is typed `pa\:ss\;word`.

   **Every boot** the camera first prints all its settings (passwords and the API key are masked), then — if nothing is missing — asks `Change settings? [y/N]` and waits **5 seconds**. Type `y` and Enter to change settings (send `KEY=value` lines; an empty line or `EXIT` saves and restarts); type anything else, or do nothing, and it starts normally. So a camera is always fixable over serial, even one that can't reach its Wi-Fi. Other commands in settings mode: `SHOW` (list again), `SHOW <KEY>` (one value, unmasked), `EXPORT`, `ERASE` (forget everything; asks to be typed twice).

   **Setting up several cameras:** configure one, type `EXPORT`, and save the line it prints in a text file (see `Arduino/templates/example.recorder.template.txt`). For the next camera paste that line and then a second line that overrides what differs, e.g. `CAMERA_ID=cam2`. The line contains your Wi-Fi password and API key, so keep real template files out of git (`Arduino/templates/*.txt` is already ignored, except the examples).

   The settings live in flash and **survive uploading a new sketch**. They are wiped by **Tools → Erase All Flash Before Sketch Upload** (or `esptool.py erase_flash`) — then the camera asks for everything again.

   The boot messages also show which **Arduino-ESP32 core** version built the firmware (`Arduino-ESP32 core 3.x.x`). You can check it yourself in Arduino IDE under **Tools → Board → Boards Manager** (search "esp32"), or with `arduino-cli core list`.

   How long an alarm records is **not** a camera setting. It is stored on the relay and edited from the dashboard's **ALARM** field (applies to every camera, takes effect on the next alarm, no reflashing needed). Every recording also starts with a few seconds of footage from *before* the trigger — see [SETUP.md, *Pre-roll*](SETUP.md#1-set-up-the-relay-serverjs-on-the-pi).

   When the alarm input fires, the camera reports it to the relay as a tiny message on the connection it already holds open for video frames, so it never stops streaming to make a separate HTTP request. (If that connection happens to be down, it falls back to a plain `POST /alarm/<id>`.) The relay announces to each camera, right after it connects, that it understands this message, and the camera only uses it after hearing that; against a relay that doesn't announce it (an older version), the camera keeps using the HTTP request, so mixing versions is safe.

   The alarm is sent on every edge into the active level **and then once a second for as long as the pin stays active**, so a sensor or person detector that goes high and stays high keeps the recording rolling (each message just extends it by the relay's alarm length); it stops being extended when the pin goes inactive, and the recording ends that length later. A pin that is already active when the board boots does not alarm until it has gone inactive and active again. Keep the relay's **ALARM** length at 1 s or more (its minimum), ideally several seconds.

   Cameras stream continuously — there is no on/off switch for a camera any more. That is what lets the relay keep the rolling pre-roll buffer.

6. Repeat for every camera, giving each one a unique `CAMERA_ID` (`cam1`, `cam2`, `cam3`, `cam4`, ...).

---

## 2. (Optional) Flash a person detector instead (TFLite Micro)

This is a second, **separate** sketch — `ESP32_CAM_TFLite_Person` — that runs fully offline, on-device person detection using TensorFlow Lite Micro, and prints the result to the Serial Monitor. It does **not** send recordings or alarms to the relay/dashboard (an optional **live view** for installation, see [the end of this section](#optional-see-the-detector-under-its-camera-on-the-dashboard-live-view--aim-and-tune-per-camera), is the one exception); it's a standalone alternative firmware image for a board, not an add-on to step 1. Flash it to a spare AI-Thinker ESP32-CAM if you want to try it.

1. **Install the model-inference library.** Clone Espressif's `esp-tflite-micro` component, pinned to `v1.3.3` (the version this sketch was written and tested against), into your Arduino libraries folder:

   ```
   cd ~/Arduino/libraries
   git clone --branch v1.3.3 https://github.com/espressif/esp-tflite-micro.git
   ```

2. In Arduino IDE, make sure you're on the **esp32 by Espressif Systems v3.x** board package (Boards Manager: Tools → Board → Boards Manager, search "esp32"; `arduino-cli core list` shows it too). Older 2.x releases don't support building an ESP-IDF component library like this one straight out of `~/Arduino/libraries`, so if you get "no such file or directory" on the `tensorflow/lite/...` includes or link errors, check this first. The sketch refuses to compile on a known-old core (`#error` at the top of the `.ino`).

3. Create a sketch folder containing these files together:
   - `ESP32_CAM_TFLite_Person.ino`
   - `person_detect_model_data.cc`
   - `person_detect_model_data.h`
   - `scene_logic.h`
   - `motion_baseline.h`
   - `report_logic.h`
   - `remote_log.h`
   - `ota_logic.h`
   - `ota.h`
   - `settings_logic.h`
   - `settings_schema.h`
   - `settings_sync.h`
   - `relay_find_logic.h`
   - `relay_find.h`
   - `relay_health.h`
   - `setup_boot.h`
   - `setup_form.h`
   - `setup_logic.h`
   - `setup_mode.h`
   - `setup_session.h`

   (Again: simply copy every file of `Arduino/ESP32_CAM_TFLite_Person/`.)

   There is **no config file to edit any more**: like the recorder, the detector keeps its settings in the board's flash and you type them in over the serial port after the first flash (step 7).

4. *(Developer switches.)* Four things are not per-board settings but compile-time switches at the top of `ESP32_CAM_TFLite_Person.ino`, to edit only if you are developing: `PRINT_DETECTION_SCORES` (print a person/no-person % every inference cycle), `PRINT_STARTUP_INFO`, `PRINT_SCENE_READINGS` (print the brightness, motion and motion-limit numbers of every frame — switch it on while choosing `DARK_THRESH` and `MOTION_THRESH`, see "Darkness and motion gate" below) and `TENSOR_ARENA_SIZE` (tied to the model).

5. Board settings: **AI Thinker ESP32-CAM**, same as step 1, **except Tools → Partition Scheme → "Minimal SPIFFS (1.9MB APP with OTA/190KB SPIFFS)"**. The TFLite Micro runtime is large and the default scheme's app slots (1.25 MB) are too small; this scheme has two slots of 1,966,080 bytes, which is what over-the-air updates need (see [DEPLOY.md, *Over-the-air firmware updates*](DEPLOY.md#over-the-air-firmware-updates)). Do **not** use *Huge APP (3MB No OTA)*: it has no second slot, so the board could never be updated without a cable. After compiling, the IDE should say `Sketch uses ... bytes ... Maximum is 1966080 bytes`.
6. Wire the FTDI programmer the same way as step 1 (GPIO0 to GND to flash), select the port, and **Upload**. Disconnect GPIO0 from GND and power-cycle.
7. Open the Serial Monitor at **115200 baud** and set its line ending to **Newline**. The boot messages start with the **Arduino-ESP32 core** version that built the firmware (it must be 3.x). A new board has no settings yet, so it lists what is missing and waits. Type them as `KEY=value`, several at once separated by `;`, and press Enter:

   ```
   PERSON_GPIO=13;DETECT_THRESH=0.6;CLEAR_THRESH=0.5;LOOP_DELAY_MS=10;DARK_THRESH=40;MOTION_THRESH=300;MOTION_HOLD_S=10;MOTION_X0=0;MOTION_Y0=0;MOTION_X1=96;MOTION_Y1=96;MOTION_EMA_LEN=0;WIFI=extender-1-ssid:password1:extender-2-ssid:password2;SERVER_HOST=192.168.4.9;HTTP_PORT=8080;API_KEY=<camKey from the Pi's config.js>;DETECTOR_ID=detector-1;STREAM_MAX_FPS=10;STREAM_JPEG_Q=80;STREAM_WR_TMO_S=3;ANN_HEARTBEAT=600;ANN_RETRY=30
   ```

   That is everything a detector needs: the detection settings and the live view's (Wi-Fi and the relay) — the live view is not optional. The full example is `Arduino/templates/example.person.template.txt`. When everything is stored it restarts by itself. `HELP` lists every setting with what it means and the allowed values.

   **No cable for the settings?** The detector can open its own setup WiFi too, exactly like the recorder: see [SETUP.md, "First setup without a cable"](SETUP.md#first-setup-without-a-cable-the-boards-own-setup-wifi) (its WiFi is called `espcamsys2-detector-…`).

   *Upgrading a detector that has the old `STREAM_ENABLED` setting:* it is gone. With `STREAM_ENABLED=1` nothing changes (the stored value stays in flash and is ignored). A detector that was run with `STREAM_ENABLED=0` never had Wi-Fi settings, so after the update it lists the live-view settings as missing and waits for them on the serial port (or in the setup WiFi).

   | Setting | Meaning |
   |---|---|
   | `PERSON_GPIO` | GPIO that goes HIGH while a person is detected (`2`, `4`, `13`, `14` or `15`; 4 is the on-board flash LED) |
   | `DETECT_THRESH` | Score needed to declare "person", `0.01`–`1` (`0.6` = Espressif's default) |
   | `CLEAR_THRESH` | The score must fall **below** this before the GPIO clears (hysteresis). Not higher than `DETECT_THRESH` — to change both, send them in one line |
   | `LOOP_DELAY_MS` | Pause between detections, `0`–`1000` ms |
   | `DARK_THRESH` | Average brightness (`0`–`255`) below which the picture counts as **dark** and detection is paused; `0` = darkness check off (see below) |
   | `MOTION_THRESH` | The model only runs after motion: summed pixel change between two frames at or above this value; `0` = motion check off (see below) |
   | `MOTION_HOLD_S` | Seconds detection stays on after the last motion, `0`–`3600` |
   | `MOTION_X0`, `MOTION_Y0`, `MOTION_X1`, `MOTION_Y1` | The **motion area**: the part of the 96×96 picture that is watched for motion, in pixels — left and top edge (inside), right and bottom edge (first column / row outside). `0`,`0`,`96`,`96` is the whole picture. At least 10 pixels wide and high; the four are checked together, so send them in one line (see below) |
   | `MOTION_EMA_LEN` | **Motion auto-calibration** (optional): the motion threshold follows a moving average of the motion readings over this many **frames** (`0`–`100000`; a few minutes' worth, e.g. `3000`), so wind and rain raise it instead of keeping the model busy. `MOTION_THRESH` stays its lowest value. `0` = **off**: the threshold stays fixed as before (see below) |
   | `MOTION_EMA_PCT` | How far **above** the moving average the threshold lies, in percent (`0`–`1000`, `30` is a good start). Only asked for while `MOTION_EMA_LEN` is not `0` |
   | `WIFI`, `SERVER_HOST`, `HTTP_PORT`, `API_KEY`, `DETECTOR_ID`, `STREAM_MAX_FPS`, `STREAM_JPEG_Q`, `STREAM_WR_TMO_S`, `ANN_HEARTBEAT`, `ANN_RETRY` | The live view: Wi-Fi and the relay the detector sends its picture and values to (see the live-view section below). Always needed |

   Everything about typing settings works as for the recorder (step 1, item 5): `;` / `:` / `\` inside a value are written `\;` / `\:` / `\\`; a line with any mistake stores nothing; every boot prints the settings (secrets masked) and waits **5 seconds** for a `y` to change them; `SHOW`, `SHOW <KEY>`, `EXPORT`, `ERASE`, `EXIT` work the same. The template for `EXPORT` lines is `Arduino/templates/example.person.template.txt` (live view on). Settings survive uploading a new sketch and are wiped by **Erase All Flash Before Sketch Upload**.

   Point the camera at yourself (or a photo of a person) — you should see something like:

   ```
   ==============================
   ESP32-CAM TFLite Micro
   Person Detection v1.3.3
   ==============================
   PSRAM: YES
   Free PSRAM: 4148728 bytes
   Detection GPIO: 13
   Detection threshold: 60%
   Clear threshold: 50%

   Camera initialized.
   Detector ready.

   Person:   8%   No person:  92%
   Person:  11%   No person:  89%
   Person:  74%   No person:  26%   -> DETECT
   >>> PERSON DETECTED - GPIO HIGH <<<
   Person:  81%   No person:  19%   -> PERSON
   Person:  32%   No person:  68%   -> CLEAR
   >>> NO PERSON - GPIO LOW <<<
   ```

   The model expects 96×96 grayscale frames — the sketch already configures the camera for that, so there's nothing to adjust there.

### Darkness and motion gate (fewer false positives, less work)

The person model reports false positives on dark pictures (it is looking at sensor noise), and there is no point running it on a picture where nothing moves. So before every inference the detector looks at the frame with a very cheap check on **sample pixels — every 10th pixel in both directions** (on the 96×96 frame that is 10 × 10 = 100 pixels):

- **Brightness** = the average gray value (0–255) of the sample pixels. Below `DARK_THRESH` the scene is *dark*: the model is **not run**, and if a person was flagged the GPIO is cleared (in the dark that can only be a false detection). The scene counts as light again only once the brightness is 5 above the threshold, so dusk does not flip it on every frame.
- **Motion** = the sum, over the sample pixels, of the absolute difference to the same pixel in the previous frame. Motion at or above `MOTION_THRESH` switches detection on, and it stays on for `MOTION_HOLD_S` seconds after the *last* motion. While a person is flagged the model keeps running even without motion, so someone standing still is not lost, and the model itself decides when they are gone.
- The **motion area** (`MOTION_X0` / `Y0` / `X1` / `Y1`) limits the motion reading to a rectangle of the picture: only sample pixels inside it add to *Motion*. Use it to keep something that always moves — trees in the wind, a rotating machine — out of the reading. By default it is the whole picture. *Brightness* always uses the whole picture. The area is at least 10 × 10 pixels, which guarantees that a sample pixel lies inside it. Draw it on the dashboard rather than typing numbers (see [MANUAL.md, *Calibrating the detector*](MANUAL.md#calibrating-the-detector-from-the-browser)).
- **Motion auto-calibration** (optional, `MOTION_EMA_LEN` > 0): a fixed `MOTION_THRESH` suits a calm scene. When a storm moves the trees (or rain and insects cross the lens) the *Motion* of an **empty** scene rises above it and the model runs on every frame for nothing. With the auto-calibration on, the detector keeps an exponential moving average of the motion readings over the last `MOTION_EMA_LEN` frames and uses **average + `MOTION_EMA_PCT` %** as the threshold, but never less than `MOTION_THRESH`. So in a calm scene nothing changes, in a storm the threshold goes up a little, and when the storm is over it comes back down. A person walking through the picture for some seconds barely moves a long average, so they still stand out. The average is counted in frames, not seconds (at 10 frames a second, `3000` frames are 5 minutes) and starts over at every boot. The average only learns the motion of an **empty** scene: one reading counts for at most **twice the threshold in force**, and the first reading after a boot is capped so the derived threshold never starts above `MOTION_THRESH`. So a camera warm-up (the picture jumps while the exposure settles) or a person busy in the picture for a minute or two does not raise the threshold above the next person's walk, while real storm noise, which stays above the threshold, still raises it (in about the time the average spans). The dashboard's motion bar shows the reading against the threshold **in force** (`motion/limit`, and *raised by the auto-calibration* in its sub-line); the stick on it still sets `MOTION_THRESH`, the lowest value. `MOTION_EMA_LEN=0` switches it off and the threshold is exactly `MOTION_THRESH`, as before.
- The model runs only if the scene is **light and** there was motion lately. Setting `DARK_THRESH=0` and/or `MOTION_THRESH=0` switches that check off; with both `0` the detector behaves exactly as before. The live view still shows every frame, also while detection is paused.

The serial monitor says when the state changes:

```
Scene: DARK (brightness 12 < 40) - detection paused
Scene: still (motion 7 < 300) - detection paused
Scene: active (brightness 120, motion 812) - detecting
```

With the motion auto-calibration on, the number after `<` is the threshold in force at that moment (the average plus its percentage), not the fixed `MOTION_THRESH`.

**Choosing the thresholds.** `40` / `300` / `10` in the templates are only starting points, they depend on your lens, the scene and the sensor's auto-exposure (a camera in a dim room raises its gain, which makes the picture noisier, so its "motion" in the dark is not zero). Set `PRINT_SCENE_READINGS` to `1` at the top of the `.ino`, flash, and watch `Brightness: … Motion: …` for every frame: note the brightness at night and in the dimmest light where you still want detection (put `DARK_THRESH` between the two), and the motion number of an empty still room versus someone walking through (put `MOTION_THRESH` well above the first and below the second). Set it back to `0` afterwards. The maximum possible motion value is 255 × the number of sample pixels inside the motion area (25500 for the whole picture). After narrowing the area the motion numbers get smaller: choose `MOTION_THRESH` again.

**Updating a board that is already configured:** (this is about `DARK_THRESH` / `MOTION_THRESH` / `MOTION_HOLD_S`, added in an earlier version) the three settings are new, so such a board lists them as missing at boot and waits for them on the serial port — or, if its live-view settings are stored, fetches them from the relay's staged device settings as for any new setting (`DARK_THRESH=40;MOTION_THRESH=300;MOTION_HOLD_S=10`). Use `0` for all three to keep the old behaviour.

**Updating a board from before the motion auto-calibration:** the new `MOTION_EMA_LEN` setting has no default either, so such a board lists it (and `MOTION_EMA_PCT`) as missing at boot and waits for it. To keep the old behaviour stage or type `MOTION_EMA_LEN=0` (for every detector at once: `nodejs/camera-relay/device-settings/detector/_fleet.txt`), **before** flashing or publishing the new firmware, or the detector pauses until it has it. `MOTION_EMA_PCT` is not asked for while `MOTION_EMA_LEN=0`. To try the auto-calibration, set for example `MOTION_EMA_LEN=3000;MOTION_EMA_PCT=30` (from the dashboard's CALIBRATE page, or over the serial port) and watch the `Limit` column of `PRINT_SCENE_READINGS` in a windy hour.

**Updating a board from before the motion area:** the four `MOTION_X0` / `MOTION_Y0` / `MOTION_X1` / `MOTION_Y1` settings are new, and settings have no defaults, so such a board lists them as missing at boot and waits for them (serial port, or the relay's staged device settings if its live-view settings are stored). To keep the old behaviour — the whole picture watched — stage or type `MOTION_X0=0;MOTION_Y0=0;MOTION_X1=96;MOTION_Y1=96` (for every detector at once: `nodejs/camera-relay/device-settings/detector/_fleet.txt`). Do this **before** flashing or publishing the new firmware, or the detector pauses until it has them. The dashboard shows no area for a detector that still runs the old firmware. (Staging is described in [DEPLOY.md, *Staged settings*](DEPLOY.md#missing-settings-after-a-firmware-update-no-usb-cable-needed).)

### Optional: see the detector under its camera on the dashboard (live view — aim and tune per camera)

To aim a detector and to choose `DARK_THRESH`, `MOTION_THRESH`, `DETECT_THRESH` and `CLEAR_THRESH` per camera you want to see what the detector sees and what its numbers do. The detector joins Wi-Fi and keeps **one connection open to the relay**, pushing its 96×96 grayscale picture and the numbers behind its alarm line up it (a few times a second). The relay hands them to the dashboard, which shows them **under the camera's picture** — from anywhere the dashboard is reachable, to any number of viewers.

The detector connects **out**, so it can sit behind a NAT router or on another network than the Pi; it serves nothing, so there is no port, user or password to set up for a viewer. The connection is an HTTP *Upgrade* on the relay's normal HTTP port (`HTTP_PORT`), authenticated with the same `API_KEY` as everything else — **no extra setting and no extra port**. (This replaces an earlier version in which the detector served its own password-protected stream on the LAN and, separately, POSTed a picture to the relay four times a second.)

1. **The live-view settings** are entered with the others at the first start (step 7 above). To change them later, type `y` within the 5-second window at boot, then send a line like this one — the full example is `Arduino/templates/example.person.template.txt`:

   ```
   WIFI=extender-1-ssid:password1:extender-2-ssid:password2;SERVER_HOST=192.168.4.9;HTTP_PORT=8080;API_KEY=<camKey from the Pi's config.js>;DETECTOR_ID=detector-1;STREAM_MAX_FPS=10;STREAM_JPEG_Q=80;STREAM_WR_TMO_S=3;ANN_HEARTBEAT=600;ANN_RETRY=30
   ```

   `WIFI` takes any number of networks (like the recorder, it takes the strongest one in range and fails over); `SERVER_HOST` / `HTTP_PORT` / `API_KEY` are the same values as the recorder's. **`DETECTOR_ID` must equal the detector id you pair with the camera in SETUP.md** (it is how the dashboard finds this board's picture) and must **not** be any recorder's `CAMERA_ID`. `STREAM_MAX_FPS` / `STREAM_JPEG_Q` tune the picture; `STREAM_WR_TMO_S` drops the connection and opens it again if the relay accepts nothing for that many seconds; `ANN_HEARTBEAT` is how often the detector writes a status line (Wi-Fi, signal, memory, the state of the link) to the relay's log, `ANN_RETRY` the longest wait between attempts to reach the relay (the first retries come after 2, 4, 8 … seconds, so a relay restart costs seconds, not half a minute).
2. **Pair the detector with its camera.** Open the camera's **⚙ SETTINGS** page on the dashboard, type the detector's `DETECTOR_ID` into *Person detector id* and press **SAVE DETECTOR** (or add `'detector' => 'detector-1'` to that camera in `config.php`, see `example.config.php`). One detector belongs to one camera, and its id must not be a camera id. The pairing lives only in `config.php`: no board is touched, re-pairing needs no reflashing.
3. **Update the Pi first, then the board.** Copy the new `nodejs/camera-relay/` over the old one and **restart the relay process** (copying files does not change the running one), run `deploy.sh` for the dashboard, then flash the detector (or `./ota-deploy.sh detector`; `remote_log.h` is a new file of the sketch). A board that is already configured needs **no new setting** — `STREAM_USER`, `STREAM_PASS` and `STREAM_PORT` of the old version are simply ignored if they are still stored in its flash. A detector running the new firmware against an old relay says so in its log (see [MANUAL.md](MANUAL.md#logging-finding-out-what-went-wrong)); an old detector against the new relay gets a plain `404`.
4. On the camera's card, below its picture, you now see on the left the detector's picture (enlarged, pixelated) and on the right:

   | Line | What it shows |
   |---|---|
   | **DETECTOR** | The gate: `ACTIVE — detecting`, `DARK — paused`, `STILL — paused` or `GATE OFF` (both checks off) |
   | **BRIGHTNESS** | The sample pixels' average (0–255) as a bar, a **red mark at `DARK_THRESH`**: left of it the picture counts as dark |
   | **MOTION** | The frame-to-frame change as a bar, a **red mark at `MOTION_THRESH`**: the bar turns green once it is reached (detection then stays on for `MOTION_HOLD_S`). The bar's scale follows the threshold |
   | **HUMAN** | The model's person score, a **red mark at `DETECT_THRESH`** (person flagged at or above it) and an **amber mark at `CLEAR_THRESH`** (cleared below it). `model paused` while the gate is dark or still |
   | **Dashed rectangle** over the picture | The motion area. **Drag it** to move it, **drag an edge or corner** to resize it (never outside the picture, never under 10 × 10 pixels); what lies outside is dimmed. A moved area gets a white outline and waits, with any moved thresholds, until **APPLY** sends all of it in one change (the detector restarts). **RESET** puts it back. Not shown for a detector with old firmware |
   | **ALARM PIN** | `HIGH` / `LOW`: the level the detector drives on its `PERSON_GPIO` — the wire into that camera's alarm input |

   Below them a small line says where the board is and how it is doing: its IP, uptime, free memory, the firmware it runs (did the update reach it?) and any reconnects or JPEG failures it counted. The numbers update every second. Thresholds are changed from the browser with the **⚙ CALIBRATE** button of the detector row (see [MANUAL.md, *Calibrating the detector*](MANUAL.md#calibrating-the-detector-from-the-browser)), or over the detector's serial console as above — the readings on the dashboard show the effect.

Things worth knowing:

- **Detection never waits for it.** All networking runs in its own tasks on the other CPU core; with no Wi-Fi in range, or the relay unreachable, the detector keeps detecting and driving its alarm line exactly as before and keeps trying in the background.
- A detector is **not** a recording camera — it is never recorded, never appears in the recording counts and is not touched by "alarm all".
- **It is plain HTTP** on your LAN like the camera frames are; the only secret on the wire is the camera key, as with the recorder.
- **Power:** Wi-Fi transmissions draw current spikes. A detector with a marginal supply can brown out with the live view on; the relay's log then shows `booted after an abnormal restart: BROWNOUT` for it. Give such a unit a stronger 5 V supply and a shorter, thicker cable.
- **When the detector does not show up** — on the dashboard the picture says *why* it is not showing instead of a bare "offline": see the table in [MANUAL.md, *A detector does not show up*](MANUAL.md#a-detector-does-not-show-up--where-to-look), and its lines in the relay log (also in MANUAL.md). Every step reports what it finds, so you should not need a serial cable.
- **The detector's camera speed:** the detector firmware reads its camera with two frame buffers at 20 MHz (as the recorder does), so the small picture and the brightness / motion numbers can run at the camera's own rate instead of a few a second. `MOTION_THRESH` compares each frame with the one before it, so with more frames per second the same movement gives a *smaller* motion number: after updating a detector's firmware, watch its MOTION reading on the CALIBRATE page and lower `MOTION_THRESH` if people no longer start the model.

> This sketch is otherwise intentionally minimal (Serial + a GPIO pin): it does not start recordings itself. If you want it to trigger a recording on another camera later, `PERSON_GPIO` here could feed into that other board's `ALARM_GPIO_PIN` from step 1 — but that's a hardware/software integration you'd be adding yourself, not something this sketch does today.
