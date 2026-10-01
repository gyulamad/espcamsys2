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
   const int  ALARM_RECORD_SECONDS     = 60;    // recording length per trigger (re-trigger extends it)
   const bool ALARM_RECORD_ALL_CAMERAS = false; // false: only this camera records; true: every camera does
   ```

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
     port: 8080,          // HTTP: /stream, /snapshot, /status, /control, /record
     pushPort: 8081,      // raw TCP: cameras push frames here continuously
     camKey: '<generate with: openssl rand -hex 24>',  // must match every camera's API_KEY
   };
   ```

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

6. **Important:** the relay's `/stream`, `/snapshot`, `/status`, `/control`, and `/record` routes have no auth of their own — only `/upload` (the camera's push endpoint) is key-protected. Make sure nothing forwards ports 8080/8081 to the internet and your Pi's firewall (`ufw`/`iptables`) only allows them from `localhost` or your LAN, since only the PHP layer should ever talk to the relay directly.

---

## 4. Set up the PHP dashboard on the Pi

1. Install a web server + PHP:

   ```
   sudo apt install -y apache2 php libapache2-mod-php
   sudo a2enmod headers
   ```

2. Copy the whole `php/cameras/` folder — `index.php`, `stream.php`, `cameras.php`, `auth.php`, `control.php`, `record.php`, `recordings.php`, `status.php`, `example.config.php`, and the `lib/` folder (`lib/Logic.php`) — into your web root, e.g. `/var/www/camdash/`.
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

   You should get the dashboard HTML back. From a LAN browser you should get a Basic Auth prompt, then see live streams, per-camera power/record controls, and recordings.

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
