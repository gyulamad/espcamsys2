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

1. Install the ESP32 board package in Arduino IDE if you haven't already (Boards Manager → search "esp32" → install), and select **AI Thinker ESP32-CAM** as the board.
2. On your laptop, create a sketch folder containing these three files together (this sketch used to be called `sketch_sep12a_camera2_behind_NAT` — it's since been renamed):
   - `ESP32_CAM_Recorder.ino`
   - `example.config.h`
   - `logic.h`
   - *(you'll create `config.h` in the next step)*
3. Copy the template and fill in this device's real values:

   ```
   cp example.config.h config.h
   ```

   Edit `config.h`:

   ```cpp
   struct WifiNetwork { const char* ssid; const char* password; };

   // List every extender/AP here — the camera connects to whichever has the
   // strongest signal and fails over automatically if one drops.
   WifiNetwork WIFI_NETWORKS[] = {
     { "extender-1-ssid", "extender-1-password" },
     { "extender-2-ssid", "extender-2-password" },
     { "extender-3-ssid", "extender-3-password" },
   };
   const int WIFI_NETWORK_COUNT = sizeof(WIFI_NETWORKS) / sizeof(WIFI_NETWORKS[0]);

   const char* SERVER_HOST   = "192.168.4.9";   // your Pi's LAN IP
   const int   PUSH_PORT     = 8081;            // relay's raw push port — must match pushPort in the Pi's config.js
   const int   HTTP_PORT     = 8080;            // relay's HTTP port — must match port in the Pi's config.js
   const char* CAMERA_ID     = "cam1";          // unique per device — must match config.php on the Pi
   const char* API_KEY       = "<same long random string as camKey in the Pi's config.js>";

   const float PUSH_INTERVAL_MUL = 1.5;         // self-adapting push-rate backoff — leave as-is unless tuning

   // ── Alarm trigger (optional hardware input) ──────────────────────────
   const int  ALARM_GPIO_PIN           = 13;    // GPIO wired to an alarm input; -1 disables the feature entirely
   const int  ALARM_ACTIVE_STATE       = LOW;   // pin level that means "alarm!"
   const bool ALARM_RECORD_ALL_CAMERAS = false; // false: only this camera records; true: every camera does
   ```

   How long an alarm records is **not** set in `config.h`. It is stored on the relay and edited from the dashboard's **ALARM** field (applies to every camera, takes effect on the next alarm, no reflashing needed). Every recording also starts with a few seconds of footage from *before* the trigger — see "Pre-roll" in the relay setup below.

   When the alarm input fires, the camera reports it to the relay as a tiny message on the connection it already holds open for video frames, so it never stops streaming to make a separate HTTP request. (If that connection happens to be down, it falls back to a plain `POST /alarm/<id>`.) The relay announces to each camera, right after it connects, that it understands this message, and the camera only uses it after hearing that; against a relay that doesn't announce it (an older version), the camera keeps using the HTTP request, so mixing versions is safe.

   Cameras stream continuously — there is no on/off switch for a camera any more. That is what lets the relay keep the rolling pre-roll buffer.

4. Wire the FTDI programmer to the ESP32-CAM (GPIO0 to GND to enter flash mode), select the correct serial port, and hit **Upload**.
5. Disconnect GPIO0 from GND and power-cycle the board. Open the Serial Monitor (115200 baud) — you should see it connect to Wi-Fi and print its IP.
6. Repeat for every camera, giving each one a unique `CAMERA_ID` (`cam1`, `cam2`, `cam3`, `cam4`, ...) and its own `config.h`.

> Since these boards only push frames outbound, they work from any Wi-Fi network that can reach the Pi's `SERVER_HOST:PUSH_PORT`/`HTTP_PORT` — including a NAT'd guest network — no port forwarding needed on the camera side.

---

## 2. (Optional) Flash a person detector instead (TFLite Micro)

This is a second, **separate** sketch — `ESP32_CAM_TFLite_Person` — that runs fully offline, on-device person detection using TensorFlow Lite Micro, and prints the result to the Serial Monitor. It does **not** stream to the relay/dashboard; it's a standalone alternative firmware image for a board, not an add-on to step 1. Flash it to a spare AI-Thinker ESP32-CAM if you want to try it.

1. **Install the model-inference library.** Clone Espressif's `esp-tflite-micro` component, pinned to `v1.3.3` (the version this sketch was written and tested against), into your Arduino libraries folder:

   ```
   cd ~/Arduino/libraries
   git clone --branch v1.3.3 https://github.com/espressif/esp-tflite-micro.git
   ```

2. In Arduino IDE, make sure you're on the **esp32 by Espressif Systems v3.x** board package (Boards Manager). Older 2.x releases don't support building an ESP-IDF component library like this one straight out of `~/Arduino/libraries`, so if you get "no such file or directory" on the `tensorflow/lite/...` includes or link errors, check this first.

3. Create a sketch folder containing these four files together:
   - `ESP32_CAM_TFLite_Person.ino`
   - `example.config.h`
   - `person_detect_model_data.cc`
   - `person_detect_model_data.h`
   - *(you'll create `config.h` in the next step)*

4. Copy the template and adjust if you want (the defaults work out of the box):

   ```
   cp example.config.h config.h
   ```

   `config.h` controls:

   ```cpp
   #define PERSON_DETECTED_GPIO 13        // goes HIGH while a person is detected, LOW otherwise
   #define PERSON_DETECTION_THRESHOLD 0.60f  // score needed to declare "person" (Espressif's default)
   #define PERSON_CLEAR_THRESHOLD 0.50f      // score must drop below this before it clears (hysteresis)
   #define DETECTION_LOOP_DELAY_MS 10
   #define TENSOR_ARENA_SIZE (100 * 1024)
   #define PRINT_DETECTION_SCORES 1       // print a person/no-person % every inference cycle
   #define PRINT_STARTUP_INFO 1
   ```

5. Board settings: **AI Thinker ESP32-CAM**, same as step 1. If you hit a "sketch too big" error at compile time, switch **Tools → Partition Scheme** to **Huge APP (3MB No OTA)** — the TFLite Micro runtime is large.
6. Wire the FTDI programmer the same way as step 1 (GPIO0 to GND to flash), select the port, and **Upload**. Disconnect GPIO0 from GND and power-cycle.
7. Open the Serial Monitor at **115200 baud**. Point the camera at yourself (or a photo of a person) — you should see something like:

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

> This sketch is intentionally minimal (Serial + a GPIO pin) rather than wired into the relay/dashboard. If you want it to trigger a recording on another camera later, `PERSON_DETECTED_GPIO` here could feed into that other board's `ALARM_GPIO_PIN` from step 1 — but that's a hardware/software integration you'd be adding yourself, not something this sketch does today.

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

2. Copy the whole `php/cameras/` folder — `index.php`, `stream.php`, `cameras.php`, `auth.php`, `record.php`, `recordings.php`, `settings.php`, `status.php`, `example.config.php`, and the `lib/` folder (`lib/Logic.php`) — into your web root, e.g. `/var/www/camdash/`.
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
           // ...one entry per camera, ids matching each device's config.h
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
- Keep `config.php`, `config.js`, and every camera's `config.h` out of git — they're already listed in `.gitignore`; just don't force-add them.
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

With `--coverage N` (N is a minimum percentage, 0–100) the C++ tests are rebuilt with gcov instrumentation, the PHP tests are run with a coverage driver, and the run **fails** if line coverage is below N. Without the flag nothing is instrumented and the run is exactly as before. `--coverage=90` works too, and `./run_tests.sh --help` prints the usage.

- **Each area is judged on its own.** N applies separately to the Recorder sketch, the person detector sketch and the dashboard's PHP logic, so a well-tested one can't make up for a weak one. Each area prints its own `ok:` or `FAIL:` line.
- **Only code that can run on a desktop is measured.** For `ESP32_CAM_Recorder` that is `logic.h`, `remote_log.h` and the remote-logging block of the `.ino`; for `ESP32_CAM_TFLite_Person` it is the detection code of the `.ino` (`setPersonDetected()`, `detectPerson()` and `loop()`, including the hysteresis). `setup()` and the camera/WiFi/model initialisation need the real hardware and are not in the percentage, so 100% does not mean the whole sketch is covered.
- **PHP: only `php/cameras/lib/*.php` is measured** (today `Logic.php`), which is the code the PHP unit tests in `tests/php/` run. The page scripts (`index.php`, `settings.php`, …) are web entry points that are only exercised by the end-to-end tests through a real web server, so they are not in the percentage. A new file in `lib/` that no test loads is reported as `NO DATA` and fails the check instead of being silently ignored.
- **The report** lists every measured file with its percentage and the line numbers that no test reached. The sketch code is tested by extracting it from the `.ino` into `tests/cpp/build/*.inc`, so those line numbers refer to the extracted file, not the `.ino`.
- **C++ needs `gcov` version 9 or newer, matching your `g++`** (they ship together in the same package), plus `node`, which merges the per-test reports. If `gcov` is missing the run fails with a clear message.
- **PHP needs a coverage driver: PCOV or Xdebug** (PCOV is faster and preferred). On Debian, Ubuntu or Raspberry Pi OS: `sudo apt install php-pcov` (or `php-xdebug`). It doesn't matter whether the extension is switched on in `php.ini`; `run_tests.sh` enables it for the test run only. Without a driver, `--coverage` fails with this hint. The two drivers give the same percentage.

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
```

If you rename the section title comments in `ESP32_CAM_TFLite_Person.ino` (`// Model parameters`, `// GPIO / detection state`, `// Arduino loop()` and the headings that follow them) or the remote-logging markers in `ESP32_CAM_Recorder.ino`, the code extraction comes out incomplete and the C++ build fails loudly — keep those headings, or update the `sed` lines in `run_tests.sh` to match.

---

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
    at ESP32_CAM_Recorder.ino:612 loop()
    recent events (oldest first):
      -310.1s INFO heartbeat: uptime 2166s, RSSI -79 dBm, free heap 98300 (lowest ever 91220), push connection up
      -4.2s WARN slow frame push: 3900 ms for 31244 bytes — weak WiFi, or the relay is congested
```

- **Who and where:** the camera id and its IP address (the address the relay saw), then the camera's own uptime, free heap, WiFi signal (`rssi`) and a sequence number.
- **When:** every entry is filed under the time it actually **happened**. Cameras have no clock; each entry says how long ago it happened, so one that waited in the camera's memory for minutes while the relay was unreachable still lands in the right place (`late=` shows how long it was held back).
- **Trace:** the file, line and function it came from; for warnings and errors also the events that led up to it (the closest thing to a call stack a board with no debugger has).
- **`[relay]`** marks what the relay itself saw rather than what the camera reported: cameras connecting and dropping (with the reason), a connection refused (wrong key), two boards flashed with the same `CAMERA_ID`, alarms, recordings started / extended / saved, errors with their stack trace, and the stack trace of a crash that killed the relay. Even a camera that cannot speak leaves a trail this way.
- At boot a camera reports **why it restarted**: *BROWNOUT* means its power supply dipped (the usual culprit for random reboots), *watchdog* means something hung, *PANIC* means the firmware crashed.
- A heartbeat line every 10 minutes (uptime, heap, signal): a gap in them shows when a camera went quiet, and the numbers show whether memory was shrinking or the signal weakening beforehand.

**If the relay can't be reached**, the camera keeps its entries in memory (the most important — errors — are kept longest) and retries after `REMOTE_LOG_RETRY_PERIOD_SECONDS` (5 minutes), up to `REMOTE_LOG_RETRY_MAX` times (3). After that it logs to its serial port only, until its connection to the relay comes back, and then reports how many entries were lost. The same message repeating (a camera failing to connect every half second) is logged once with a count, not thousands of times. All of this is configured in the camera's `config.h` — see `example.config.h`.

**The file can't fill the SD card:** it rotates (`logMaxBytes`, default 5 MiB; `logKeepFiles`, default 2, so at most 15 MiB in total). The log endpoint needs the camera key (`X-Api-Key` header), and nothing a camera sends can forge a log line.

Cost on the camera: about 9 KB of RAM (a fixed block for 16 queued entries, no memory churn), and the HTTP delivery runs in a separate background task so it never delays the video stream.

Notes: only the **recorder** firmware reports remotely — the person-detector board (`ESP32_CAM_TFLite_Person`) has no network connection at all, so it remains serial-only. Remote logging needs the new relay and new firmware; against an older relay the camera simply gives up after its retries and keeps printing to serial.

## Troubleshooting: an alarm doesn't record, or a stream goes dark

Start with the log (`tail -n 200 nodejs/camera-relay/logs/camera.log`) — it usually answers the question directly.

1. **Is the relay actually running the new code?** `curl -s http://<relay>:8080/status` — every camera should have a `preRoll` entry, and the log starts each run with `relay started (pid …)`. If not, the relay process was never restarted after the files were copied.
2. **Did the alarm reach the relay?** Look for `alarm received (in-band)` followed by `recording started (…)` (or `recording extended`) for that camera. If a recording could not start you will instead see `error handling a alarm from the push connection …` with a stack trace and the reason (full disk, folder permissions, …) — the relay itself keeps running and the camera keeps streaming; fix the reason and the next alarm works.
3. **What did the camera do?** Its own entries show which route the alarm took: `alarm sent in-band on the push connection`, `relay hasn't announced in-band alarm support … using the HTTP request`, or `alarm: no push connection — using the HTTP request`. (On a camera with a serial monitor attached the same lines appear there.)
4. **Did a camera drop or restart?** Look for `camera disconnected after …s (reason)` from the relay and, from the camera, `booted after an abnormal restart: …`. If the relay itself restarted there is a `relay started` line, and just before it either `relay stopping (SIGTERM)` (on purpose) or `FATAL: uncaught exception` with its stack trace.
5. **A FILES button with no number** (`📼 FILES` instead of `📼 FILES (3)`) means the dashboard's web server couldn't reach the relay within 2 seconds when it built the page — check `relay_url` in `config.php` and that the relay is running. A number is written into the page by the server on every load, then kept current by the live status poll; it works with older relays too (it counts their file list instead).
