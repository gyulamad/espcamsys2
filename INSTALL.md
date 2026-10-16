# ESP32-CAM Home Security System — Install Guide

This sets up three pieces:

1. **ESP32-CAM devices** — capture JPEGs, push them to your Pi, and (optionally) record on trigger
2. **`server.js` relay** — runs on the Pi, receives frames, re-serves them as live MJPEG, and turns recording sessions into `.mp4` files
3. **PHP dashboard** — runs on the Pi, shown to you over a Tor hidden service, proxies each camera's stream/controls from the relay

```
[ESP32-CAM] --push JPEG--> [server.js relay :8080] <--fetch-- [PHP dashboard] <--Tor--> [you, anywhere]
```

Everything below assumes the Pi is the only thing with a public-facing address, and that address is a `.onion` — nothing is port-forwarded on your router.

There's also an **optional, separate sketch** (`ESP32_CAM_TFLite_Person`) that runs on-device person detection instead of streaming — see step 2 below if you want to try that on a spare board.

---

## 0. What you need

- A Raspberry Pi (or any always-on Linux box) on your home network
- One or more ESP32-CAM (AI-Thinker) boards
- An FTDI/USB-serial programmer to flash the ESP32-CAMs
- Arduino IDE on your laptop, with the ESP32 board package installed
- SSH access to the Pi

---

## 1. Flash each ESP32-CAM (streaming/recording sketch)

1. Install the ESP32 board package in Arduino IDE if you haven't already (Boards Manager → search "esp32" → install), and select **AI Thinker ESP32-CAM** as the board, and **Tools → Partition Scheme → "Minimal SPIFFS (1.9MB APP with OTA/190KB SPIFFS)"** (needed for over-the-air updates; see below).
2. On your laptop, create a sketch folder containing these files together (this sketch used to be called `sketch_sep12a_camera2_behind_NAT` — it's since been renamed):
   - `ESP32_CAM_Recorder.ino`
   - `logic.h`
   - `remote_log.h`
   - `settings_logic.h`
   - `settings_schema.h`
   - `ota_logic.h`
   - `ota.h`

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

   | Setting | Meaning |
   |---|---|
   | `WIFI` | Networks to join, as `ssid:password` pairs joined by `:` — any number up to 8 (the camera takes the strongest one in range and fails over if it drops). An open network is `ssid:` with an empty password. |
   | `SERVER_HOST` | Your Pi's LAN IP (or hostname) |
   | `PUSH_PORT` | The relay's raw push port — must match `pushPort` in the Pi's `config.js` |
   | `HTTP_PORT` | The relay's HTTP port — must match `port` in the Pi's `config.js` |
   | `CAMERA_ID` | Unique per device (`cam1`, `cam2`, ...) — must match `config.php` on the Pi. Letters, digits, `_ . -` |
   | `API_KEY` | The same long random string as `camKey` in the Pi's `config.js` |
   | `PUSH_GAP_MUL` | Self-adapting push-rate backoff, 0.1–10 — leave at `1.5` unless tuning |
   | `ALARM_GPIO_PIN` | GPIO wired to an alarm input (`2`, `4`, `13`, `14` or `15`); `-1` turns the alarm feature off |
   | `ALARM_ACTIVE` | `LOW` or `HIGH`: the pin level that means "alarm!" (only asked for when the pin isn't `-1`) |
   | `ALARM_ALL_CAMS` | `0`: only this camera records; `1`: every camera does (only asked for when the pin isn't `-1`) |
   | `LOG_ENABLED` | `1`: also send the camera's log to the relay; `0`: serial only. The other `LOG_*` settings are only asked for when this is `1` — see "Logging: finding out what went wrong" below |

   **Special characters.** `;` separates settings and `:` separates the Wi-Fi fields, so a literal `;`, `:` or `\` inside a name or password is written `\;`, `\:` or `\\` — only when it is really there. Example: the password `pa:ss;word` is typed `pa\:ss\;word`.

   **Every boot** the camera first prints all its settings (passwords and the API key are masked), then — if nothing is missing — asks `Change settings? [y/N]` and waits **5 seconds**. Type `y` and Enter to change settings (send `KEY=value` lines; an empty line or `EXIT` saves and restarts); type anything else, or do nothing, and it starts normally. So a camera is always fixable over serial, even one that can't reach its Wi-Fi. Other commands in settings mode: `SHOW` (list again), `SHOW <KEY>` (one value, unmasked), `EXPORT`, `ERASE` (forget everything; asks to be typed twice).

   **Setting up several cameras:** configure one, type `EXPORT`, and save the line it prints in a text file (see `Arduino/templates/example.recorder.template.txt`). For the next camera paste that line and then a second line that overrides what differs, e.g. `CAMERA_ID=cam2`. The line contains your Wi-Fi password and API key, so keep real template files out of git (`Arduino/templates/*.txt` is already ignored, except the examples).

   The settings live in flash and **survive uploading a new sketch**. They are wiped by **Tools → Erase All Flash Before Sketch Upload** (or `esptool.py erase_flash`) — then the camera asks for everything again.

   The boot messages also show which **Arduino-ESP32 core** version built the firmware (`Arduino-ESP32 core 3.x.x`). You can check it yourself in Arduino IDE under **Tools → Board → Boards Manager** (search "esp32"), or with `arduino-cli core list`.

   How long an alarm records is **not** a camera setting. It is stored on the relay and edited from the dashboard's **ALARM** field (applies to every camera, takes effect on the next alarm, no reflashing needed). Every recording also starts with a few seconds of footage from *before* the trigger — see "Pre-roll" in the relay setup below.

   When the alarm input fires, the camera reports it to the relay as a tiny message on the connection it already holds open for video frames, so it never stops streaming to make a separate HTTP request. (If that connection happens to be down, it falls back to a plain `POST /alarm/<id>`.) The relay announces to each camera, right after it connects, that it understands this message, and the camera only uses it after hearing that; against a relay that doesn't announce it (an older version), the camera keeps using the HTTP request, so mixing versions is safe.

   Cameras stream continuously — there is no on/off switch for a camera any more. That is what lets the relay keep the rolling pre-roll buffer.

6. Repeat for every camera, giving each one a unique `CAMERA_ID` (`cam1`, `cam2`, `cam3`, `cam4`, ...).

> Since these boards only push frames outbound, they work from any Wi-Fi network that can reach the Pi's `SERVER_HOST:PUSH_PORT`/`HTTP_PORT` — including a NAT'd guest network — no port forwarding needed on the camera side.

---

## 2. (Optional) Flash a person detector instead (TFLite Micro)

This is a second, **separate** sketch — `ESP32_CAM_TFLite_Person` — that runs fully offline, on-device person detection using TensorFlow Lite Micro, and prints the result to the Serial Monitor. It does **not** send recordings or alarms to the relay/dashboard (an optional **live view** for installation, see the end of this section, is the one exception); it's a standalone alternative firmware image for a board, not an add-on to step 1. Flash it to a spare AI-Thinker ESP32-CAM if you want to try it.

1. **Install the model-inference library.** Clone Espressif's `esp-tflite-micro` component, pinned to `v1.3.3` (the version this sketch was written and tested against), into your Arduino libraries folder:

   ```
   cd ~/Arduino/libraries
   git clone --branch v1.3.3 https://github.com/espressif/esp-tflite-micro.git
   ```

2. In Arduino IDE, make sure you're on the **esp32 by Espressif Systems v3.x** board package (Boards Manager: Tools → Board → Boards Manager, search "esp32"; `arduino-cli core list` shows it too). Older 2.x releases don't support building an ESP-IDF component library like this one straight out of `~/Arduino/libraries`, so if you get "no such file or directory" on the `tensorflow/lite/...` includes or link errors, check this first.

3. Create a sketch folder containing these files together:
   - `ESP32_CAM_TFLite_Person.ino`
   - `person_detect_model_data.cc`
   - `person_detect_model_data.h`
   - `stream_logic.h`
   - `scene_logic.h`
   - `ota_logic.h`
   - `ota.h`
   - `settings_logic.h`
   - `settings_schema.h`

   There is **no config file to edit any more**: like the recorder, the detector keeps its settings in the board's flash and you type them in over the serial port after the first flash (step 7).

4. *(Developer switches.)* Four things are not per-board settings but compile-time switches at the top of `ESP32_CAM_TFLite_Person.ino`, to edit only if you are developing: `PRINT_DETECTION_SCORES` (print a person/no-person % every inference cycle), `PRINT_STARTUP_INFO`, `PRINT_SCENE_READINGS` (print the brightness and motion numbers of every frame — switch it on while choosing `DARK_THRESH` and `MOTION_THRESH`, see "Darkness and motion gate" below) and `TENSOR_ARENA_SIZE` (tied to the model).

5. Board settings: **AI Thinker ESP32-CAM**, same as step 1, **except Tools → Partition Scheme → "Minimal SPIFFS (1.9MB APP with OTA/190KB SPIFFS)"**. The TFLite Micro runtime is large and the default scheme's app slots (1.25 MB) are too small; this scheme has two slots of 1,966,080 bytes, which is what over-the-air updates need (see "Over-the-air firmware updates" below). Do **not** use *Huge APP (3MB No OTA)*: it has no second slot, so the board could never be updated without a cable. After compiling, the IDE should say `Sketch uses ... bytes ... Maximum is 1966080 bytes`.
6. Wire the FTDI programmer the same way as step 1 (GPIO0 to GND to flash), select the port, and **Upload**. Disconnect GPIO0 from GND and power-cycle.
7. Open the Serial Monitor at **115200 baud** and set its line ending to **Newline**. The boot messages start with the **Arduino-ESP32 core** version that built the firmware (it must be 3.x; the sketch refuses to compile on a known-old core). A new board has no settings yet, so it lists what is missing and waits. Type them as `KEY=value`, several at once separated by `;`, and press Enter:

   ```
   PERSON_GPIO=13;DETECT_THRESH=0.6;CLEAR_THRESH=0.5;LOOP_DELAY_MS=10;DARK_THRESH=40;MOTION_THRESH=300;MOTION_HOLD_S=10;STREAM_ENABLED=0
   ```

   That is all a detector **without** the live view needs (no Wi-Fi is started at all). When everything is stored it restarts by itself. `HELP` lists every setting with what it means and the allowed values.

   | Setting | Meaning |
   |---|---|
   | `PERSON_GPIO` | GPIO that goes HIGH while a person is detected (`2`, `4`, `13`, `14` or `15`; 4 is the on-board flash LED) |
   | `DETECT_THRESH` | Score needed to declare "person", `0.01`–`1` (`0.6` = Espressif's default) |
   | `CLEAR_THRESH` | The score must fall **below** this before the GPIO clears (hysteresis). Not higher than `DETECT_THRESH` — to change both, send them in one line |
   | `LOOP_DELAY_MS` | Pause between detections, `0`–`1000` ms |
   | `DARK_THRESH` | Average brightness (`0`–`255`) below which the picture counts as **dark** and detection is paused; `0` = darkness check off (see below) |
   | `MOTION_THRESH` | The model only runs after motion: summed pixel change between two frames at or above this value; `0` = motion check off (see below) |
   | `MOTION_HOLD_S` | Seconds detection stays on after the last motion, `0`–`3600` |
   | `STREAM_ENABLED` | `1`: join Wi-Fi and serve the live view (see below); `0`: no Wi-Fi at all. With `0`, none of the settings below are asked for |
   | `WIFI`, `SERVER_HOST`, `HTTP_PORT`, `API_KEY`, `DETECTOR_ID`, `STREAM_USER`, `STREAM_PASS`, `STREAM_PORT`, `STREAM_MAX_FPS`, `STREAM_JPEG_Q`, `STREAM_WR_TMO_S`, `ANN_HEARTBEAT`, `ANN_RETRY` | The live view — only asked for while `STREAM_ENABLED=1`; see the live-view section below |

   Everything about typing settings works as for the recorder (step 1, item 5): `;` / `:` / `\` inside a value are written `\;` / `\:` / `\\`; a line with any mistake stores nothing; every boot prints the settings (secrets masked) and waits **5 seconds** for a `y` to change them; `SHOW`, `SHOW <KEY>`, `EXPORT`, `ERASE`, `EXIT` work the same. Templates for `EXPORT` lines: `Arduino/templates/example.person.template.txt` (live view on) and `example.person-no-wifi.template.txt`. Settings survive uploading a new sketch and are wiped by **Erase All Flash Before Sketch Upload**.

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
- The model runs only if the scene is **light and** there was motion lately. Setting `DARK_THRESH=0` and/or `MOTION_THRESH=0` switches that check off; with both `0` the detector behaves exactly as before. The live view still shows every frame, also while detection is paused.

The serial monitor says when the state changes:

```
Scene: DARK (brightness 12 < 40) - detection paused
Scene: still (motion 7 < 300) - detection paused
Scene: active (brightness 120, motion 812) - detecting
```

**Choosing the thresholds.** `40` / `300` / `10` in the templates are only starting points, they depend on your lens, the scene and the sensor's auto-exposure (a camera in a dim room raises its gain, which makes the picture noisier, so its "motion" in the dark is not zero). Set `PRINT_SCENE_READINGS` to `1` at the top of the `.ino`, flash, and watch `Brightness: … Motion: …` for every frame: note the brightness at night and in the dimmest light where you still want detection (put `DARK_THRESH` between the two), and the motion number of an empty still room versus someone walking through (put `MOTION_THRESH` well above the first and below the second). Set it back to `0` afterwards. The maximum possible motion value is 25500 (100 samples × 255).

**Updating a board that is already configured:** the three settings are new, so such a board lists them as missing at boot and waits for them on the serial port — or, if its live-view settings are stored, fetches them from the relay's staged device settings as for any new setting (`DARK_THRESH=40;MOTION_THRESH=300;MOTION_HOLD_S=10`). Use `0` for all three to keep the old behaviour.

### Optional: watch the detector from a browser (live view)

To install and aim a detector you want to see what it sees. With `STREAM_ENABLED=1`, the detector also joins Wi-Fi, serves its picture as a **password-protected video stream**, and tells the relay which IP address it got. Nothing is registered or handled anywhere: the relay just writes a line to its log.

1. Enter the live-view settings (type `y` within the 5-second window at boot, then send a line like this one — the full example is `Arduino/templates/example.person.template.txt`):

   ```
   STREAM_ENABLED=1;WIFI=extender-1-ssid:password1:extender-2-ssid:password2;SERVER_HOST=192.168.4.9;HTTP_PORT=8080;API_KEY=<camKey from the Pi's config.js>;DETECTOR_ID=detector-1;STREAM_USER=viewer;STREAM_PASS=<a real password>;STREAM_PORT=80;STREAM_MAX_FPS=10;STREAM_JPEG_Q=80;STREAM_WR_TMO_S=3;ANN_HEARTBEAT=600;ANN_RETRY=30
   ```

   `WIFI` takes any number of networks (like the recorder, it takes the strongest one in range and fails over); `SERVER_HOST` / `HTTP_PORT` / `API_KEY` are the same values as the recorder's; `DETECTOR_ID` must **not** be any recorder's `CAMERA_ID`; `STREAM_USER` is letters, digits and `_ . -`; the stream is **not served** with an empty password or the placeholder `change-me` (it is refused when typed). `STREAM_PORT` `80` means no port in the address; `STREAM_MAX_FPS` / `STREAM_JPEG_Q` tune the picture; `STREAM_WR_TMO_S` drops a viewer that stops reading after that many seconds; `ANN_HEARTBEAT` repeats the address in the relay's log every that many seconds, `ANN_RETRY` waits that long after the relay could not be reached.
2. Flash as above. In the Serial Monitor you'll see `Wi-Fi connected to '…', IP …` and `Announced http://… to the relay`.
3. On the Pi, find the address — the detector announces it at every (re)connection and whenever its network or IP changes, and repeats it every 10 minutes:

   ```
   grep "human detector stream" nodejs/camera-relay/logs/camera.log | tail -n 3
   ```

   ```
   … INFO  cam2-human@192.168.4.37 …: human detector stream available at http://192.168.4.37/ — user 'viewer' (WiFi 'extender-2', IP 192.168.4.37, -61 dBm, up 42s)
   ```

4. Open that address in a browser from a device on the same network and log in. You get the picture enlarged; `http://<ip>/stream` is the raw MJPEG stream. What you see is the 96×96 grayscale frame the model itself gets, which is what you need to aim the camera.

Things worth knowing:

- **Detection never waits for it.** All networking runs in its own task on the other CPU core; with no Wi-Fi in range, or the relay unreachable, the detector works exactly as without a live view (the announcement is retried every 30 s).
- **One viewer at a time**; opening the stream again replaces the previous viewer.
- **It is plain HTTP**, so the password crosses your LAN unencrypted. Use one you don't reuse, and never forward this port to the internet. (The picture is only reachable from the network the detector is on; it does not go through the relay.)
- **Power:** Wi-Fi transmissions draw current spikes. A detector with a marginal supply can brown out with the live view on (the relay's log would show `BROWNOUT`-style restarts on recorders; here, watch the Serial Monitor). Set `STREAM_ENABLED=0` for such a unit once it is installed (it then starts no Wi-Fi at all).

> This sketch is otherwise intentionally minimal (Serial + a GPIO pin) rather than wired into the relay/dashboard. If you want it to trigger a recording on another camera later, `PERSON_GPIO` here could feed into that other board's `ALARM_GPIO_PIN` from step 1 — but that's a hardware/software integration you'd be adding yourself, not something this sketch does today.

---

## 3. Set up the relay (`server.js`) on the Pi

1. Install Node.js and ffmpeg on the Pi if needed (ffmpeg is required for the recording feature — the relay turns saved frames into `.mp4` files with it):

   ```
   curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
   sudo apt install -y nodejs ffmpeg
   ```

2. Copy the whole `nodejs/camera-relay/` folder (including `server.js`, `example.config.js`, `package.json`, and the `lib/` folder) onto the Pi, e.g. `/opt/camrelay/`.
3. Create the real config:

   ```
   cd /opt/camrelay
   cp example.config.js config.js
   ```

   Edit `config.js`:

   ```js
   module.exports = {
     port: 8080,          // HTTP: /stream, /snapshot, /status, /record, /alarm
     pushPort: 8081,      // raw TCP: cameras push frames here continuously
     camKey: '<generate with: openssl rand -hex 24>',  // must match every camera's API_KEY
     preRollSeconds: 5,   // optional: seconds of footage BEFORE a trigger that every recording starts with (default 5, 0 = off)
     controlKey: '<generate with: openssl rand -hex 24>',  // for the dashboard's recording ON/OFF buttons — see "Switching recording ON / OFF"
     // optional log file settings — see "Logging" at the end of this guide:
     // logFile: 'logs/camera.log', logMaxBytes: 5 * 1024 * 1024, logKeepFiles: 2,
   };
   ```

   **Pre-roll.** The relay always keeps the last `preRollSeconds` of every camera's frames in memory (nothing is written to disk until a recording starts). When a recording starts — an alarm, the person detector, or the dashboard's RECORD button — those buffered frames become the first part of the clip, so the footage begins *before* the trigger even if the trigger took a while to reach the relay over slow Wi-Fi. Each recording is therefore `preRollSeconds` longer than its recording length. Pre-roll costs a few MB of RAM per camera (capped at 8 MiB per camera by default; set `preRollMaxBytes` in `config.js` to change that). `curl http://localhost:8080/status` shows each camera's buffer fill under `preRoll`. Keep the value comfortably above the total delay between something happening and the relay hearing about it (detector inference + alarm request) — 5 s is a good start.

4. Install dependencies (already listed in `package.json`) and do a test run:

   ```
   npm install
   node server.js
   ```

   You should see `Camera relay (HTTP) listening on :8080` and `Camera relay (raw push) listening on :8081`. Leave it running and check that a camera shows up:

   ```
   curl http://localhost:8080/status
   ```

5. Once a camera is pushing frames, stop the test run (Ctrl+C) and set it up as a systemd service so it survives reboots:

   ```
   # /etc/systemd/system/camrelay.service
   [Unit]
   Description=ESP32-CAM relay
   After=network.target

   [Service]
   WorkingDirectory=/opt/camrelay
   ExecStart=/usr/bin/node server.js
   Restart=on-failure
   User=pi

   [Install]
   WantedBy=multi-user.target
   ```

   ```
   sudo systemctl daemon-reload
   sudo systemctl enable --now camrelay
   sudo systemctl status camrelay
   ```

6. **Important:** the relay's `/stream`, `/snapshot`, `/status`, `/record`, `/alarm`, and `/settings` routes have no auth of their own — only `/upload` (the camera's push endpoint) is key-protected. Make sure nothing forwards ports 8080/8081 to the internet and your Pi's firewall (`ufw`/`iptables`) only allows them from `localhost` or your LAN, since only the PHP layer should ever talk to the relay directly.

---

## 4. Set up the PHP dashboard on the Pi

1. Install a web server + PHP:

   ```
   sudo apt install -y apache2 php libapache2-mod-php
   sudo a2enmod headers
   ```

2. Copy the whole `php/cameras/` folder — `index.php`, `stream.php`, `cameras.php`, `auth.php`, `relay.php`, `record.php`, `recordings.php`, `recording-switch.php`, `settings.php`, `status.php`, `example.config.php`, and the `lib/` folder (`lib/Logic.php`) — into your web root, e.g. `/var/www/camdash/`.
3. Create the real config:

   ```
   cd /var/www/camdash
   cp example.config.php config.php
   ```

   Edit `config.php`:

   ```php
   return [
       'auth_user' => 'pick-a-username',
       'auth_pass' => '<long random password>',
       'relay_url' => 'http://127.0.0.1:8080',   // or the relay's LAN IP if on a different host
       'cameras' => [
           ['id' => 'cam1', 'name' => 'Front Door', 'icon' => '🚪'],
           ['id' => 'cam2', 'name' => 'Back Yard',  'icon' => '🌿'],
           // ...one entry per camera, ids matching each device's `CAMERA_ID` setting
       ],
   ];
   ```

4. Point an Apache vhost at that folder:

   ```
   # /etc/apache2/sites-available/camdash.conf
   <VirtualHost 127.0.0.1:80>
       DocumentRoot /var/www/camdash
       <Directory /var/www/camdash>
           AllowOverride All
           Require all granted
       </Directory>
   </VirtualHost>
   ```

   Bind this to `127.0.0.1` only — Tor will be the only thing reaching it (see next step).

   ```
   sudo a2ensite camdash
   sudo systemctl reload apache2
   ```

5. Sanity check from the Pi itself:

   ```
   curl -u pick-a-username:yourpassword http://127.0.0.1:80/
   ```

   You should get the dashboard HTML back. From a LAN browser you should get a Basic Auth prompt, then see live streams, per-camera record controls, and recordings.

---

## 5. Set up the Tor hidden service

1. Install Tor on the Pi:

   ```
   sudo apt install -y tor
   ```

2. Edit `/etc/tor/torrc` and add:

   ```
   HiddenServiceDir /var/lib/tor/camdash/
   HiddenServicePort 80 127.0.0.1:80
   ```

3. Restart Tor and grab your onion address:

   ```
   sudo systemctl restart tor
   sudo cat /var/lib/tor/camdash/hostname
   ```

4. On a device with the Tor Browser (or any Tor-enabled client), visit `http://<your-address>.onion/`. You should hit the Basic Auth prompt, then see your cameras.

---

## 6. Verify end-to-end

- [ ] Each camera's serial monitor shows `Connected, IP: ...` and no repeated `Push failed` errors
- [ ] `curl http://localhost:8080/status` on the Pi shows a recent `lastSeen` for every camera
- [ ] `http://127.0.0.1:80/` on the Pi (with `-u user:pass`) shows all cameras live
- [ ] Starting a recording from the dashboard (or `POST /record/:id?seconds=10`) produces a playable `.mp4` under the relay's `recordings/` folder — if it doesn't, check `ffmpeg` is installed and on `$PATH`
- [ ] The `.onion` address, opened in Tor Browser, prompts for Basic Auth and then shows all cameras live
- [ ] Port 8080 and 8081 are **not** reachable from outside your LAN (check your router's port-forwarding list — there should be none for this project)
- [ ] *(If you flashed the optional person detector)* its Serial Monitor prints changing `Person: NN% No person: NN%` lines and flips to `>>> PERSON DETECTED - GPIO HIGH <<<` when someone steps in front of it

---

## 7. Before you consider this done

- Rotate the `camKey` / `API_KEY` — the one currently in the files was sitting in tracked source before this cleanup. Generate a new one (`openssl rand -hex 24`), put it in the Pi's `config.js`, and re-flash every camera's `config.h` with the same value.
- Pick a real Basic Auth password in `config.php` — don't leave it at any placeholder.
- Keep `config.php`, `config.js` and your real settings templates (`Arduino/templates/*.txt`) out of git — they're already listed in `.gitignore`; just don't force-add them.
- Back up your `config.*` files somewhere safe (password manager, encrypted volume) — they're gitignored on purpose, so a fresh clone of the repo won't have them.

---

## Running the tests (and checking coverage)

`run_tests.sh` in the repo root runs every test suite: the Arduino C++ logic of **both** sketches, the relay's Node.js logic, the end-to-end tests and the PHP dashboard logic. Nothing needs flashing — it all runs on your laptop or the Pi.

```bash
./run_tests.sh
```

You need `g++`, `node` and `php` on `PATH` (and `gdb`, which gives a backtrace if a C++ test crashes; without it the tests still run). The end-to-end tests also need `npm install` to have been run in `nodejs/camera-relay/`. A missing tool is reported as a failure rather than silently skipped. The exit code is `0` only if everything passed.

### Failing the run when coverage is too low: `--coverage N`

```bash
./run_tests.sh --coverage 90
```

With `--coverage N` (N is a minimum percentage, 0–100) the C++ tests are rebuilt with gcov instrumentation, the PHP tests are run with a coverage driver, the Node.js tests (unit and end-to-end) are run with Node's built-in coverage, and the run **fails** if line coverage is below N. Without the flag nothing is instrumented and the run is exactly as before. `--coverage=90` works too, and `./run_tests.sh --help` prints the usage.

- **Each area is judged on its own.** N applies separately to the Recorder sketch, the person detector sketch, the dashboard's PHP logic, the relay's Node.js logic and the relay's `server.js`, so a well-tested one can't make up for a weak one. Each area prints its own `ok:` or `FAIL:` line.
- **Only code that can run on a desktop is measured.** For `ESP32_CAM_Recorder` that is `logic.h`, `remote_log.h` and the remote-logging block of the `.ino`; for `ESP32_CAM_TFLite_Person` it is the detection code of the `.ino` (`setPersonDetected()`, `detectPerson()` and `loop()`, including the hysteresis). `setup()` and the camera/WiFi/model initialisation need the real hardware and are not in the percentage, so 100% does not mean the whole sketch is covered.
- **PHP: only `php/cameras/lib/*.php` is measured** (today `Logic.php`), which is the code the PHP unit tests in `tests/php/` run. The page scripts (`index.php`, `settings.php`, …) are web entry points that are only exercised by the end-to-end tests through a real web server, so they are not in the percentage. A new file in `lib/` that no test loads is reported as `NO DATA` and fails the check instead of being silently ignored.
- **Node.js is measured as two areas.** `nodejs/camera-relay/lib/*.js` is judged by the unit tests in `tests/node/`. `nodejs/camera-relay/server.js` (the relay itself) is judged by the end-to-end tests in `tests/e2e/`: the relay processes they start record their own coverage and write it when the test stops them. A `lib/` file that no test loads shows as `NO DATA` and fails the check. Comment-only and blank lines are not counted, so the percentages can read a little lower than what other tools such as c8 print for the same code (they count comments as covered lines); the list of uncovered lines is the same.
- **The report** lists every measured file with its percentage and the line numbers that no test reached. The sketch code is tested by extracting it from the `.ino` into `tests/cpp/build/*.inc`, so those line numbers refer to the extracted file, not the `.ino`.
- **C++ needs `gcov` version 9 or newer, matching your `g++`** (they ship together in the same package), plus `node`, which merges the per-test reports. If `gcov` is missing the run fails with a clear message.
- **PHP needs a coverage driver: PCOV or Xdebug** (PCOV is faster and preferred). On Debian, Ubuntu or Raspberry Pi OS: `sudo apt install php-pcov` (or `php-xdebug`). It doesn't matter whether the extension is switched on in `php.ini`; `run_tests.sh` enables it for the test run only. Without a driver, `--coverage` fails with this hint. The two drivers give the same percentage.
- **Node.js needs nothing extra** beyond Node 12 or newer: the coverage comes from Node itself (`NODE_V8_COVERAGE`), no `nyc`/`c8` and no `npm install` for it.

Example of the output:

```
Recorder sketch (ESP32_CAM_Recorder) — line coverage (union of all C++ test binaries):
  Arduino/ESP32_CAM_Recorder/logic.h                   100.0%  (43/43)
  ...
ok: Recorder sketch (ESP32_CAM_Recorder) coverage 97.2% >= required 90%

Person detector sketch (ESP32_CAM_TFLite_Person) — line coverage (union of all C++ test binaries):
  tests/cpp/build/person_glue.inc                      100.0%  (58/58)
ok: Person detector sketch (ESP32_CAM_TFLite_Person) coverage 100.0% >= required 90%

Dashboard PHP logic (php/cameras/lib) — line coverage (union of all PHP test processes):
  php/cameras/lib/Logic.php                            100.0%  (92/92)
ok: Dashboard PHP logic (php/cameras/lib) coverage 100.0% >= required 90%

Relay Node.js logic (nodejs/camera-relay/lib) — line coverage (union of all Node.js test processes):
  nodejs/camera-relay/lib/logfile.js                   100.0%  (67/67)
  ...
ok: Relay Node.js logic (nodejs/camera-relay/lib) coverage 100.0% >= required 90%

Relay server (nodejs/camera-relay/server.js, run by the end-to-end tests) — line coverage (union of all Node.js test processes):
  nodejs/camera-relay/server.js                         96.3%  (659/684)
      uncovered lines: 83-85, 109-110, ...
ok: Relay server (nodejs/camera-relay/server.js, run by the end-to-end tests) coverage 96.3% >= required 90%
```

If you rename the section title comments in `ESP32_CAM_TFLite_Person.ino` (`// Model parameters`, `// GPIO / detection state`, `// Arduino loop()` and the headings that follow them) or the remote-logging and settings markers (`Remote logging glue` / `Settings glue` and their `end of ...` lines) in `ESP32_CAM_Recorder.ino`, the code extraction comes out incomplete and the C++ build fails loudly — keep those headings, or update the `sed` lines in `run_tests.sh` to match.

---

## Upgrading a recorder to flash-stored settings

The recorder no longer has a `config.h`: its settings are stored in the board's flash. A camera that already runs the old firmware keeps running until you reflash it. After you do, it has no settings yet: open the Serial Monitor (115200, line ending **Newline**) and type them in (step 1, item 5) — keep the old `config.h` values at hand. A few names changed because flash keys are limited to 15 characters: `ALARM_ACTIVE_STATE` → `ALARM_ACTIVE`, `ALARM_RECORD_ALL_CAMERAS` → `ALARM_ALL_CAMS`, `PUSH_INTERVAL_MUL` → `PUSH_GAP_MUL`, and `REMOTE_LOG_*` → `LOG_*` (`REMOTE_LOG_ENABLED` → `LOG_ENABLED`, `…_MIN_LEVEL` → `LOG_MIN_LEVEL`, `…_ECHO_TO_SERIAL` → `LOG_ECHO`, `…_RETRY_MAX` → `LOG_RETRY_MAX`, `…_RETRY_PERIOD_SECONDS` → `LOG_RETRY_SEC`, `…_FLUSH_SECONDS` → `LOG_FLUSH_SEC`, `…_REPEAT_WINDOW_SECONDS` → `LOG_REPEAT_SEC`, `…_HEARTBEAT_SECONDS` → `LOG_HEARTBEAT`, `…_LOW_HEAP_BYTES` → `LOG_LOW_HEAP`). The old `config.h` can be deleted. Later firmware that adds a new setting asks only for that one.

## Upgrading a person detector to flash-stored settings

The person detector no longer has a `config.h` either. After reflashing it asks for its settings over serial (section 2, step 7) — keep the old `config.h` values at hand. Renamed settings (flash keys are limited to 15 characters): `PERSON_DETECTED_GPIO` → `PERSON_GPIO`, `PERSON_DETECTION_THRESHOLD` → `DETECT_THRESH`, `PERSON_CLEAR_THRESHOLD` → `CLEAR_THRESH`, `DETECTION_LOOP_DELAY_MS` → `LOOP_DELAY_MS`, `STREAM_PASSWORD` → `STREAM_PASS`, `STREAM_JPEG_QUALITY` → `STREAM_JPEG_Q`, `STREAM_WRITE_TIMEOUT_S` → `STREAM_WR_TMO_S`, `ANNOUNCE_HEARTBEAT_SECONDS` → `ANN_HEARTBEAT`, `ANNOUNCE_RETRY_SECONDS` → `ANN_RETRY`. `TENSOR_ARENA_SIZE`, `PRINT_DETECTION_SCORES` and `PRINT_STARTUP_INFO` are now developer switches at the top of the `.ino`. The old `config.h` can be deleted.

---

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

- Only settings that are **missing or invalid** are taken from the relay. A setting that is stored and valid is never changed by it, whatever the staged line says. So you can't use this to change the Wi-Fi password, server or key of a board that works — that stays a serial job.
- The line is checked like typed input and is **all or nothing**: one bad value and nothing is stored (the serial log says why).
- It doesn't help when the settings needed to *reach* the relay are the ones missing or wrong (Wi-Fi, server, port, API key, id), nor a detector run without its live view (it has no Wi-Fi settings): those still need the serial port.
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

- **Adding a setting? Stage it BEFORE deploying.** Settings have no defaults, so after an update a board lacking a new setting can't run. If its Wi-Fi/server/port/key/id are stored it fetches the value from the relay (previous section) — but only what you staged:
  1. `curl -X PUT -H "X-Control-Key: ..." --data-binary 'NEW_KEY=value' http://PI:8080/device-settings/<type>`
  2. then `./ota-deploy.sh`.

  Staged first, the update is invisible (one extra restart of ~45 s). Staged afterwards, the camera restarts about once a minute until you stage it. A release that **changes the Wi-Fi / server / port / API key / id settings, renames a setting, or tightens a range** so that a stored value becomes invalid still needs a cable.
- A detector with `STREAM_ENABLED=0` never joins Wi-Fi and **cannot be updated over the air**. While someone watches a detector's live view its network task is busy streaming, so its update check waits for the viewer to leave.
- The camera keeps streaming during a download; the flash writes briefly stall the other CPU core. A weak power supply can brown out during the ~1.5 MB download — if a board resets mid-update, check its supply.
- A build that boots but can't reach the relay (bad release) can't be rescued over the air: **recover by cable** (USB upload of a good build; settings are kept).
- Plain HTTP on the relay's port for now, with the same trust as the rest of the camera traffic: anyone on the LAN who has the camera key could fetch the firmware, and the control key travels in clear to publish it. There is no signing, rollback or boot-loop protection yet; HTTPS is the planned next step.

## Upgrading from the version with camera power on/off

Cameras can no longer be switched off from the dashboard (pre-roll needs them streaming all the time), and the dashboard's "camera on" alarm setting is gone.

1. **Relay first.** Copy the new `nodejs/camera-relay/` over the old one and **restart the relay process** (copying files does not change the running one). New firmware works with an older relay too (it falls back to the HTTP alarm), but you only get the no-gap alarm and pre-roll with the new relay. Add `preRollSeconds` to `config.js` if you want something other than 5. The relay sends one harmless "resume" byte to every camera when it connects, so a camera running the *old* firmware that happened to be switched off at upgrade time starts streaming again by itself.
2. **Dashboard.** Run `deploy.sh` (it now also removes the retired `control.php` from the web root).
3. **Firmware (whenever convenient).** Reflash the recorder boards with the new `ESP32_CAM_Recorder` sketch. This is what removes the gap in the footage right after an alarm (the old firmware's alarm request froze the camera until it finished); it also drops the unused pause code. Old firmware keeps working with the new relay in the meantime, using the HTTP alarm request as before — pre-roll works with either.
4. An existing `settings.json` with an `alarmPowerSeconds` value is fine; it is simply ignored.

---

## Switching recording ON / OFF

When people are at the surveilled place the cameras would otherwise record all that movement for no reason, and someone has to sort the footage by hand afterwards. The dashboard has **⏻ OFF / ⏻ ON** buttons:

- **Per camera** (on each camera card): switches that camera only.
- **ALL OFF / ALL ON** (in the header): sets every camera the relay knows at that moment, one by one — afterwards each camera can be changed on its own, and a camera the relay hasn't seen yet is unaffected.
- **OFF takes a number of minutes** (default 60). `0` or a negative number means "OFF until I press ON": no countdown. A timed OFF switches itself back ON when the time is up (and says so in the log).
- **While a camera is OFF nothing can start a recording** — not an alarm, not the person detector, not the RECORD button (which says so) — and a recording in progress is stopped (what it captured so far is saved). Live viewing is unaffected, and the camera keeps streaming.
- **When recording is switched back ON, footage from the OFF period is never part of a clip** (the rolling pre-roll buffer is skipped past that moment).
- **It survives a relay restart.** The state is kept in `recording-switch.json` next to `server.js`; a timed OFF is stored as the time it ends, so it keeps counting while the relay is down. If that file is damaged, every camera simply records (fail towards recording, never towards silence).

### Setup: one secret, in two places

Switching recording off is exactly what someone who wants to go unrecorded would try, so it needs its own key, **different from the cameras' key** (that one is flashed into every camera board — anyone who got hold of a board could otherwise switch your system off):

```
openssl rand -hex 24
```

Put the same value in both places:

1. the relay's `config.js`: `controlKey: '<the value>'`
2. the dashboard's `config.php`: `'relay_control_key' => '<the value>'`

Then restart the relay and run `deploy.sh`. Without a key the buttons are shown as "not set up" and the relay refuses to switch anything — it never falls back to "open".

How it is protected: the dashboard login → a request header only the dashboard's own script can send (so a page on another website can't trigger "OFF" using your cached login) → the control key, added by the dashboard's server (the browser never sees it) and checked by the relay in constant time. Every change is written to the log with who did it (`recording switched OFF until … by alice (via 127.0.0.1)`), and so is every refused attempt, with its address.

Direct use (e.g. from the Pi, with `curl`):

```
curl -X POST -H "X-Control-Key: <key>" "http://localhost:8080/recording/camera/cam2/off?minutes=30"
curl -X POST -H "X-Control-Key: <key>" "http://localhost:8080/recording/all/off?minutes=0"
curl -X POST -H "X-Control-Key: <key>"  http://localhost:8080/recording/all/on
curl http://localhost:8080/recording/state          # who is OFF (no key needed to read)
```

Notes: the relay's *other* HTTP routes (RECORD, delete recordings, …) are not authenticated at the relay — they rely on the dashboard login in front of them, so keep the relay's port 8080 on a trusted network. A timed OFF uses the Pi's clock; a Pi without a battery-backed clock may be off by a little right after boot until it has synchronised.

## The SETTINGS page (dashboard → ⚙ SETTINGS)

Every setting of the main system can be changed from the dashboard instead of editing `config.js` / `config.php` over ssh: the relay's ports, camera key, control key, pre-roll, alarm recording length, log and folders, plus the dashboard's own login and relay address. The form is generated from the relay's list of settings, so each one comes with its description and limits.

- **Saving applies the change for you.** Dashboard settings (login, relay address) apply at once. Relay settings that are read at startup are marked *restarts relay*; after saving, the dashboard asks the relay to restart itself and the page waits until it answers again. The alarm length applies immediately with no restart. Nothing needs to be redeployed.
- **Where it is stored.** The relay keeps what you save in `system-settings.json` next to `server.js`, laid over `config.js` at startup (so `config.js` stays the starting point and is never rewritten). The dashboard rewrites `config.php` (keeping a `config.php.bak` and your cameras). Environment variables (`PORT`, `CAM_KEY`, …) still win over both; such a field is shown read-only.
- **The relay must be started by systemd or pm2** so it comes back by itself — the unit in the relay setup above (`Restart=on-failure`) is enough, the relay exits with code 75 to be restarted. A relay started by hand refuses to restart (the page tells you) instead of just stopping; set `RELAY_SUPERVISED=1` if something else restarts it.
- **One-time requirements:** `relay_control_key` in `config.php` and `controlKey` in `config.js` (see above) — the page uses it to talk to the relay — and `config.php` must be writable by the web server (`deploy.sh` runs `chown www-data` on it).
- **Safety nets.** A new relay address is tested before it is saved (a wrong one would lock the dashboard out of the relay); changing the relay's HTTP port updates the dashboard's address with it; rotating the control key updates the dashboard's copy; the camera key and the camera push port are flashed into every board, so changing them asks for confirmation. If the saved settings file is ever damaged, the relay starts with `config.js` and logs a warning.

## Logging: finding out what went wrong

Assembled cameras have no serial monitor attached, so **the cameras send what they would print to the relay**, and the relay writes it — together with what the relay itself observes — into one plain-text file:

```
tail -f nodejs/camera-relay/logs/camera.log
```

(`logs/camera.log` next to `server.js`; change it with `logFile` in the relay's `config.js`.) A few lines look like this:

```
2026-10-03T12:00:01.234Z INFO  cam2@192.168.4.20 [relay]: camera connected
2026-10-03T12:00:05.012Z INFO  cam2@192.168.4.20 up=12.8s heap=121004 rssi=-62 seq=3: connected to WiFi 'upstairs', IP 192.168.4.20, RSSI -62 dBm
2026-10-03T12:41:17.680Z WARN  cam2@192.168.4.20 up=2476.2s heap=98112 rssi=-81 seq=57 late=312.4s fw="Oct  3 2026 11:02:44": push write failed after 4000 ms (wrote 5120 of 31244 bytes, disconnected) — dropping the connection, reconnecting
    at ESP32_CAM_Recorder.ino:612 pushFrame()
    recent events (oldest first):
      -310.1s INFO heartbeat: WiFi 'upstairs', IP 192.168.4.20, RSSI -79 dBm, uptime 2166s, free heap 98300 (lowest ever 91220), push connection up
      -4.2s WARN slow frame push: 3900 ms for 31244 bytes — weak WiFi, or the relay is congested
```

- **Who and where:** the camera id and its IP address (the address the relay saw), then the camera's own uptime, free heap, WiFi signal (`rssi`) and a sequence number.
- **When:** every entry is filed under the time it actually **happened**. Cameras have no clock; each entry says how long ago it happened, so one that waited in the camera's memory for minutes while the relay was unreachable still lands in the right place (`late=` shows how long it was held back).
- **Trace:** the file, line and function it came from; for warnings and errors also the events that led up to it (the closest thing to a call stack a board with no debugger has).
- **`[relay]`** marks what the relay itself saw rather than what the camera reported: cameras connecting and dropping (with the reason), a connection refused (wrong key), two boards flashed with the same `CAMERA_ID` (only reported when **both** are actually sending at the same moment — a camera that simply reconnected after its old connection died is not a clash), alarms, recordings started / extended / saved, errors with their stack trace, and the stack trace of a crash that killed the relay. Even a camera that cannot speak leaves a trail this way.
- **Which camera is on which Wi-Fi, with what address:** every recorder and detector writes `WiFi '<network>', IP <address>` when it connects, on **every reconnect** (it may land on a different extender with a different address) and in its periodic heartbeat. The camera's address as the relay sees it is also in each line's `cam2@192.168.4.20`, but that's the relay's view; the network name only comes from the camera. All lines, then just the newest per camera:

  ```
  grep -E "WiFi '[^']*', IP " nodejs/camera-relay/logs/camera.log
  grep -E "WiFi '[^']*', IP " nodejs/camera-relay/logs/camera.log | awk '{split($3,a,"@"); last[a[1]]=$0} END{for(c in last) print last[c]}'
  ```

  (Only the current `camera.log` is searched; after a rotation, older lines are in the previous file. A camera silent for longer than a heartbeat period — 10 minutes — is the thing to look at, not whatever its last line says.)
- At boot a camera reports **why it restarted**: *BROWNOUT* means its power supply dipped (the usual culprit for random reboots), *watchdog* means something hung, *PANIC* means the firmware crashed.
- A heartbeat line every 10 minutes (the Wi-Fi network and IP address, signal, uptime, heap): a gap in them shows when a camera went quiet, and the numbers show whether memory was shrinking or the signal weakening beforehand.

**If the relay can't be reached**, the camera keeps its entries in memory (the most important — errors — are kept longest) and retries after `LOG_RETRY_SEC` (5 minutes), up to `LOG_RETRY_MAX` times (3). After that it logs to its serial port only, until its connection to the relay comes back, and then reports how many entries were lost. The same message repeating (a camera failing to connect every half second) is logged once with a count, not thousands of times. All of this is set with the camera's `LOG_*` settings (type `HELP` in settings mode for what each means; the values above are the usual ones).

**The file can't fill the SD card:** it rotates (`logMaxBytes`, default 5 MiB; `logKeepFiles`, default 2, so at most 15 MiB in total). The log endpoint needs the camera key (`X-Api-Key` header), and nothing a camera sends can forge a log line.

Cost on the camera: about 9 KB of RAM (a fixed block for 16 queued entries, no memory churn), and the HTTP delivery runs in a separate background task so it never delays the video stream.

Notes: the **recorder** firmware reports everything above. The person-detector board (`ESP32_CAM_TFLite_Person`) reports only its live-view address line (see section 2) — no queue, no retries beyond that line, no error reports — and has no network connection at all with `STREAM_ENABLED 0`. Remote logging needs the new relay and new firmware; against an older relay the camera simply gives up after its retries and keeps printing to serial.

## Troubleshooting: an alarm doesn't record, or a stream goes dark

Start with the log (`tail -n 200 nodejs/camera-relay/logs/camera.log`) — it usually answers the question directly.

1. **Is the relay actually running the new code?** `curl -s http://<relay>:8080/status` — every camera should have a `preRoll` entry, and the log starts each run with `relay started (pid …)`. If not, the relay process was never restarted after the files were copied.
2. **Did the alarm reach the relay?** Look for `alarm received (in-band)` followed by `recording started (…)` (or `recording extended`) for that camera. If a recording could not start you will instead see `error handling a alarm from the push connection …` with a stack trace and the reason (full disk, folder permissions, …) — the relay itself keeps running and the camera keeps streaming; fix the reason and the next alarm works.
3. **What did the camera do?** Its own entries show which route the alarm took: `alarm sent in-band on the push connection`, `relay hasn't announced in-band alarm support … using the HTTP request`, or `alarm: no push connection — using the HTTP request`. (On a camera with a serial monitor attached the same lines appear there.)
4. **Did a camera drop or restart?** Look for `camera disconnected after …s (reason)` from the relay and, from the camera, `booted after an abnormal restart: …`. If the relay itself restarted there is a `relay started` line, and just before it either `relay stopping (SIGTERM)` (on purpose) or `FATAL: uncaught exception` with its stack trace.
5. **A FILES button with no number** (`📼 FILES` instead of `📼 FILES (3)`) means the dashboard's web server couldn't reach the relay within 2 seconds when it built the page — check `relay_url` in `config.php` and that the relay is running. A number is written into the page by the server on every load, then kept current by the live status poll; it works with older relays too (it counts their file list instead).
6. **A camera with a weak WiFi signal** (`rssi` of about -80 dBm or worse; the log shows it on every line). A full-size frame can then take many seconds to send. The system copes in three ways, all automatic:
   - the camera sends **smaller frames** while the link is slow (`link is slow, sending smaller frames: JPEG quality 12 -> 18`) and brings the picture back when it recovers (`link recovered, improving the picture`). The resolution never changes. The coarsest quality it will use is `JPEG_QUALITY_WORST` in `ESP32_CAM_Recorder.ino`;
   - it waits at most `PUSH_MAX_GAP_MS` (1 s) between frames, and rides out a bad few seconds (`PUSH_WRITE_TIMEOUT_MS`, 8 s) before it gives up on a connection;
   - when it does reconnect, the relay recognises the **same board returning**: `the camera reconnected — closed its previous connection …, which had been silent for …s`. That is normal on a bad link, not an error. The relay also drops a connection that has been completely silent for 60 s (`camera disconnected after …s (no data for 60s)`; set `PUSH_IDLE_TIMEOUT_MS` in the relay's environment to change it; a connection that has not sent its first line within 10 s is dropped too, `PUSH_AUTH_TIMEOUT_MS`).

   The warning `another connection with the SAME camera id is still sending frames (from <ip>, last data <n>s ago)` is different: it means two connections are delivering frames **at the same time**, i.e. two boards really are flashed with the same `CAMERA_ID`. Give each board its own.

   Software can only do so much at -87 dBm: expect a coarse picture and a frame every few seconds. A camera with an external antenna (many ESP32-CAM boards have a small resistor to switch from the printed antenna to the connector), or a repeater nearer to it, fixes it properly.
