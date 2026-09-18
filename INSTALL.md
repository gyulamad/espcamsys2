# ESP32-CAM Home Security System — Install Guide

This sets up three pieces:

1. **ESP32-CAM devices** — capture JPEGs, push them to your Pi
2. **`server.js` relay** — runs on the Pi, receives frames, re-serves them as live MJPEG
3. **PHP dashboard** — runs on the Pi, shown to you over a Tor hidden service, proxies each camera's stream from the relay, and lets you pause/resume each camera's capture (power + bandwidth saving)

```
[ESP32-CAM] --push JPEG--> [server.js relay :8080] <--fetch-- [PHP dashboard] <--Tor--> [you, anywhere]
```

Everything below assumes the Pi is the only thing with a public-facing address, and that address is a `.onion` — nothing is port-forwarded on your router.

---

## 0. What you need

- A Raspberry Pi (or any always-on Linux box) on your home network
- One or more ESP32-CAM (AI-Thinker) boards
- An FTDI/USB-serial programmer to flash the ESP32-CAMs
- Arduino IDE on your laptop, with the ESP32 board package installed
- SSH access to the Pi

---

## 1. Flash each ESP32-CAM

1. Install the ESP32 board package in Arduino IDE if you haven't already (Boards Manager → search "esp32" → install), and select **AI Thinker ESP32-CAM** as the board.
2. On your laptop, create a sketch folder containing these three files together:
   - `sketch_sep12a_camera2_behind_NAT.ino`
   - `example.config.h`
   - *(you'll create `config.h` in the next step)*
3. Copy the template and fill in this device's real values:
   ```bash
   cp example.config.h config.h
   ```
   Edit `config.h`. List every Wi-Fi extender this camera might be near — it connects
   to whichever has the strongest signal and fails over automatically if one drops,
   so you don't need to know in advance which extender it'll end up closest to:
   ```cpp
   WifiNetwork WIFI_NETWORKS[] = {
     { "extender-1-ssid", "extender-1-password" },
     { "extender-2-ssid", "extender-2-password" },
     { "extender-3-ssid", "extender-3-password" },
   };
   const int WIFI_NETWORK_COUNT = sizeof(WIFI_NETWORKS) / sizeof(WIFI_NETWORKS[0]);

   const char* SERVER_HOST   = "192.168.4.9";   // your Pi's LAN IP
   const int   PUSH_PORT     = 8081;            // relay's raw push port — must match pushPort in server's config.js
   const char* CAMERA_ID     = "cam1";          // unique per device — must match its id in config.php
   const char* API_KEY       = "<same long random string as camKey in the Pi's config.js>";
   ```
4. Wire the FTDI programmer to the ESP32-CAM (GPIO0 to GND to enter flash mode), select the correct serial port, and hit **Upload**.
5. Disconnect GPIO0 from GND and power-cycle the board. Open the Serial Monitor (115200 baud) — you should see it connect to Wi-Fi and print its IP.
6. Repeat for every camera, giving each one a unique `CAMERA_ID` (`cam1`, `cam2`, `cam3`, `cam4`, ...) and its own `config.h`.

> Since these boards only push frames outbound, they work from any Wi-Fi network that can reach the Pi's `SERVER_HOST:PUSH_PORT` — including a NAT'd guest network — no port forwarding needed on the camera side.

---

## 2. Set up the relay (`server.js`) on the Pi

1. Install Node.js on the Pi if needed:
   ```bash
   curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
   sudo apt install -y nodejs
   ```
2. Copy `server.js`, `example.config.js`, and `package.json` (create one if you don't have it — `npm init -y` then `npm install express`) into a folder on the Pi, e.g. `/opt/camrelay/`.
3. Create the real config:
   ```bash
   cd /opt/camrelay
   cp example.config.js config.js
   ```
   Edit `config.js` and set `camKey` to a long random string — the **same** string you put in every camera's `config.h`:
   ```js
   module.exports = {
     port: 8080,
     pushPort: 8081,
     camKey: '<generate with: openssl rand -hex 24>',
   };
   ```
4. Install dependencies and do a test run:
   ```bash
   npm install
   node server.js
   ```
   You should see `Camera relay (HTTP) listening on :8080` and `Camera relay (raw push) listening on :8081`. Leave it running and check that a camera shows up:
   ```bash
   curl http://localhost:8080/status
   ```
5. Once a camera is pushing frames, stop the test run (Ctrl+C) and set it up as a systemd service so it survives reboots:
   ```ini
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
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now camrelay
   sudo systemctl status camrelay
   ```
6. **Important:** the relay has no auth on `/stream`, `/snapshot`, `/status`, or `/control` — only `/upload` is key-protected. Make sure nothing forwards ports 8080/8081 to the internet and your Pi's firewall (`ufw`/`iptables`) only allows them from `localhost` or your LAN, since only the PHP layer should ever talk to it.

---

## 3. Set up the PHP dashboard on the Pi

1. Install a web server + PHP:
   ```bash
   sudo apt install -y apache2 php libapache2-mod-php
   sudo a2enmod headers
   ```
2. Copy `index.php`, `stream.php`, `control.php`, `cameras.php`, `auth.php`, and `example.config.php` into your web root, e.g. `/var/www/camdash/`.
3. Create the real config:
   ```bash
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
4. Point an Apache vhost at that folder. Since Tor is going to hand this straight to port 80, and nothing else on the Pi needs port 80, the vhost can just listen there directly — no extra port to keep track of:
   ```apache
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
   ```bash
   sudo a2ensite camdash
   sudo systemctl reload apache2
   ```
5. Sanity check from the Pi itself:
   ```bash
   curl -u pick-a-username:yourpassword http://127.0.0.1/
   ```
   You should get the dashboard HTML back. From a LAN browser you should get a Basic Auth prompt, then see live streams, with a power button on each camera to pause/resume its capture.

---

## 4. Set up the Tor hidden service

1. Install Tor on the Pi:
   ```bash
   sudo apt install -y tor
   ```
2. Edit `/etc/tor/torrc` and add — external port 80 straight to Apache's port 80, no remapping needed:
   ```
   HiddenServiceDir /var/lib/tor/camdash/
   HiddenServicePort 80 127.0.0.1:80
   ```
3. Restart Tor and grab your onion address:
   ```bash
   sudo systemctl restart tor
   sudo cat /var/lib/tor/camdash/hostname
   ```
4. On a device with the Tor Browser (or any Tor-enabled client), visit `http://<your-address>.onion/`. You should hit the Basic Auth prompt, then see your cameras.

---

## 5. Verify end-to-end

- [ ] Each camera's serial monitor shows `Connected, IP: ...` and no repeated `Push failed` errors
- [ ] `curl http://localhost:8080/status` on the Pi shows a recent `lastSeen` for every camera
- [ ] `http://127.0.0.1/` on the Pi (with `-u user:pass`) shows all cameras live
- [ ] The `.onion` address, opened in Tor Browser, prompts for Basic Auth and then shows all cameras live
- [ ] The power button on a camera's card pauses it (its serial monitor prints `(paused)`, its stream stops updating) and resumes it again
- [ ] Ports 8080 and 8081 are **not** reachable from outside your LAN (check your router's port-forwarding list — there should be none for this project)

---

## 6. Before you consider this done

- Rotate the `camKey` / `API_KEY` — the one currently in the files was sitting in tracked source before this cleanup. Generate a new one (`openssl rand -hex 24`), put it in the Pi's `config.js`, and re-flash every camera's `config.h` with the same value.
- Pick a real Basic Auth password in `config.php` — don't leave it at any placeholder.
- Keep `config.php`, `config.js`, and every camera's `config.h` out of git — they're already listed in `.gitignore`; just don't force-add them.
- Back up your `config.*` files somewhere safe (password manager, encrypted volume) — they're gitignored on purpose, so a fresh clone of the repo won't have them.
