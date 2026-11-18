# ESP32-CAM Home Security System — Setup (on the Pi, with flashed boards)

*User manual for setting the system up: the Pi is installed, SSH works, and the ESP32-CAM boards are already flashed (if not, see [ASSEMBLY.md](ASSEMBLY.md)). This brings the relay, the dashboard, Apache and Tor up, sets the keys, and verifies the whole chain. For daily use see [MANUAL.md](MANUAL.md); for shipping a new version see [DEPLOY.md](DEPLOY.md); for the project overview see [README.md](README.md).*

## 1. Set up the relay (`server.js`) on the Pi

1. Install Node.js and ffmpeg on the Pi if needed (ffmpeg is required for the recording feature — the relay turns saved frames into `.mp4` files with it):

   ```
   curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
   sudo apt install -y nodejs ffmpeg
   ```

2. Copy the whole `nodejs/camera-relay/` folder (including `server.js`, `example.config.js`, `package.json`, `package-lock.json`, and the `lib/` and `tools/` folders) onto the Pi, e.g. `/opt/camrelay/`. (Optional: to have recordings without a person sorted out automatically, also see [MANUAL.md, *Person check*](MANUAL.md#sorting-out-footage-without-a-person) once the relay runs.)
3. Create the real config:

   ```
   cd /opt/camrelay
   cp example.config.js config.js
   ```

   Edit `config.js`:

   ```js
   module.exports = {
     port: 8080,          // HTTP: /mux, /snapshot, /status, /record, /alarm, /recordings, ...
     pushPort: 8081,      // raw TCP: cameras push frames here continuously
     camKey: '<generate with: openssl rand -hex 24>',  // must match every camera's API_KEY
     preRollSeconds: 5,   // optional: seconds of footage BEFORE a trigger that every recording starts with (default 5, 0 = off)
     controlKey: '<generate with: openssl rand -hex 24>',  // for the dashboard's recording ON/OFF buttons — see "Switching recording ON / OFF" in MANUAL.md
     // optional log file settings — see MANUAL.md, "Logging":
     // logFile: 'logs/camera.log', logMaxBytes: 5 * 1024 * 1024, logKeepFiles: 2,
   };
   ```

   **Pre-roll.** The relay always keeps the last `preRollSeconds` of every camera's frames in memory (nothing is written to disk until a recording starts). When a recording starts — an alarm, the person detector, or the dashboard's RECORD button — those buffered frames become the first part of the clip, so the footage begins *before* the trigger even if the trigger took a while to reach the relay over slow Wi-Fi. Each recording is therefore `preRollSeconds` longer than its recording length. Pre-roll costs a few MB of RAM per camera (capped at 8 MiB per camera by default; set `preRollMaxBytes` in `config.js` to change that). `curl -H "X-Control-Key: YOUR_CONTROL_KEY" http://localhost:8080/status` shows each camera's buffer fill under `preRoll`. Keep the value comfortably above the total delay between something happening and the relay hearing about it (detector inference + alarm request) — 5 s is a good start.

4. Install dependencies (already listed in `package.json`) and do a test run:

   ```
   npm install
   node server.js
   ```

   You should see `Camera relay (HTTP) listening on :8080` and `Camera relay (raw push) listening on :8081`. Leave it running and check that a camera shows up:

   ```
   curl -H "X-Control-Key: YOUR_CONTROL_KEY" http://localhost:8080/status
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

6. **Important:** every route of the relay needs a key except `POST /alarm/...` (see the notes under ["Switching recording ON / OFF"](MANUAL.md#switching-recording-on--off) in MANUAL.md): the cameras' routes (`/upload`, `/log`, the push port, settings and firmware) need the camera key, and everything the dashboard does — watching (`/mux`, `/snapshot`, `/status`, `/recordings`, ...) as well as changing things — needs the control key, which is why **setting `controlKey` in the relay's `config.js` (and the same value as `relay_control_key` in the dashboard's `config.php`) is part of the installation, not an extra**. Without a `controlKey` the relay refuses reads with **503** by default (start the relay with `READ_KEY_REQUIRED=0` in the environment only on a trusted LAN with no Tor exposure to get the old read-everything behaviour). Still make sure nothing forwards ports 8080/8081 to the internet and your Pi's firewall (`ufw`/`iptables`) only allows them from `localhost` or your LAN, since only the PHP layer should ever talk to the relay directly.

## 2. Set up the PHP dashboard on the Pi

1. Install a web server + PHP:

   ```
   sudo apt install -y apache2 php libapache2-mod-php
   sudo a2enmod headers
   ```

2. Copy the dashboard into the web root with the script in this repo. From the repo root on the Pi:

   ```
   sudo ./deploy.sh
   ```

   It copies every page of `php/cameras/`, the `lib/` folder (pages and the shared `recordings-list.js` script), the self-hosted `fonts/`, the page icons and the hidden `.htaccess` (a plain `cp *.php` or a file manager would miss the last one) into `/var/www/html/camdash/`, so the dashboard is at `http://<the Pi>/camdash/` (another folder: `sudo CAMDASH_DIR=/your/folder ./deploy.sh`). Run it again after every update of the dashboard. The first time it says there is no `config.php` yet: the next item creates it.
3. Create the real config:

   ```
   cd /var/www/html/camdash
   sudo cp example.config.php config.php
   ```

   Edit `config.php`:

   ```php
   return [
       'auth_user' => 'pick-a-username',
       'auth_pass' => '<long random password>',
       'relay_url' => 'http://127.0.0.1:8080',   // or the relay's LAN IP if on a different host
       'relay_control_key' => '<the same value as controlKey in the relay config.js>',
       'cameras' => [
           ['id' => 'cam1', 'name' => 'Front Door', 'icon' => '🚪'],
           ['id' => 'cam2', 'name' => 'Back Yard',  'icon' => '🌿'],
           // ...one entry per camera, ids matching each device's `CAMERA_ID` setting
       ],
   ];
   ```

   `relay_control_key` is part of the installation, not an extra: with the relay's `controlKey` set, the relay refuses everything the dashboard does (watching as well as changing things) unless the dashboard sends that key. Then run `sudo ./deploy.sh` once more from the repo root: it makes `config.php` read-only for the web server (see ["Where settings live"](#where-settings-live) below).

4. Protect that folder with the config file shipped in this repo (`apache/camdash-protect.conf`). It is **not** a new site: nothing is disabled and your existing Apache setup keeps serving the dashboard exactly as before, on your **LAN** (`http://<the Pi>/camdash/`) and over **Tor** (step 3). It only adds rules for the dashboard folder: no folder listings, `lib/`, `config.php` and every copy or backup of it are never served, the security headers, and (with the second file) Apache stops announcing its version.

   ```
   sudo cp apache/camdash-protect.conf /etc/apache2/conf-available/camdash-protect.conf
   sudo cp apache/camdash-hardening.conf /etc/apache2/conf-available/camdash-hardening.conf   # optional: server-wide, hides the Apache version
   sudo a2enmod headers
   sudo a2enconf camdash-protect camdash-hardening
   sudo apache2ctl configtest && sudo systemctl reload apache2
   ```

   If your dashboard is in another folder than `/var/www/html/camdash`, change the one `Define CAMDASH_DIR` line at the top of `camdash-protect.conf` (and run `sudo CAMDASH_DIR=/your/folder ./deploy.sh`).

### Where settings live

`sudo ./deploy.sh` (from the repo root) copies the dashboard into the folder, makes `config.php` **read-only** for the web server (owner `root`, group `www-data`, mode `640`) and creates a small `data/` folder that only the web server may use (never `chown -R` the whole web folder, and never make the code folder writable). What you change on the dashboard's settings pages (login, relay address, control key, cameras, recording lengths) is saved in `data/settings.json`: a JSON file, so it can never run as code, that Apache never serves, written in one piece with `rename()` under a lock — a power cut leaves the old file or the new one, and two people saving at once cannot undo each other. It is laid over `config.php`: **what was saved on the dashboard wins** over the value written in `config.php`, and a re-deploy never overwrites it. To change such a value by hand, change it on the dashboard or delete it from `data/settings.json`. If `data/settings.json` ever gets damaged it is ignored and logged and `config.php` is used; the next save repairs it. Until you run `deploy.sh` as root the old way keeps working (the dashboard rewrites `config.php` itself, which then has to belong to `www-data`).

   **Plain HTTP on the LAN — what it means.** Basic auth sends the username and password unencrypted, so anyone who can watch the traffic on your LAN (a compromised device, someone on your Wi-Fi) can read them. The login also slows down guessing (see the security notes below), but it cannot stop sniffing. Over Tor this does not apply: Tor encrypts everything. If your LAN is only people you trust, plain HTTP is a reasonable convenience; if not, use the optional HTTPS below.

   **Optional: HTTPS for the LAN.** Skip this if plain HTTP is fine for you; nothing else depends on it. It adds a site on port 443 with a certificate the Pi signs for itself, so the password is encrypted on the LAN (the plain HTTP address keeps working next to it):

   ```
   sudo ./apache/make-selfsigned-cert.sh raspberrypi raspberrypi.local 192.168.1.20
   sudo cp apache/camdash-ssl.conf /etc/apache2/sites-available/camdash-ssl.conf
   sudo a2enmod ssl
   sudo a2ensite camdash-ssl
   sudo apache2ctl configtest && sudo systemctl restart apache2
   ```

   Give the script every name and address you use to reach the Pi (replace the example ones). Then open `https://<the Pi>/camdash/`. The certificate is signed by itself, so the browser warns **once**: compare the SHA-256 fingerprint the script printed with the one the browser shows, and accept it. The certificate is valid for 825 days; to renew it, run the script again with `--force` as the first argument and reload Apache. No HSTS header is sent on purpose: with a self-signed certificate it would make the warning impossible to click through. (If Debian's own HTTPS site is enabled, `sudo a2dissite default-ssl` first — the camdash site serves the same web root.)

5. Sanity check from the Pi itself:

   ```
   curl -u pick-a-username:yourpassword http://127.0.0.1:80/camdash/
   ```

   (Use `http://127.0.0.1:80/camdash/` if the dashboard is in `/var/www/html/camdash`, `http://127.0.0.1:80/` if your own site has that folder as its web root.) You should get the dashboard HTML back. Then, from another computer on your LAN, open the same address with the Pi's LAN address instead of `127.0.0.1` (or `https://` if you set up the optional HTTPS): you should get the login prompt. Also check that `curl -sI http://127.0.0.1/camdash/lib/` and `curl -sI http://127.0.0.1/camdash/config.php` answer `403`, and that the response headers include `X-Content-Type-Options: nosniff`.

## 3. Set up the Tor hidden service

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

4. On a device with the Tor Browser (or any Tor-enabled client), visit `http://<your-address>.onion/camdash/` (without `/camdash/` if the dashboard folder is your site's web root). You should hit the Basic Auth prompt, then see your cameras.

## 4. Verify end-to-end

- [ ] Each camera reports `connected to WiFi '<network>', IP <address>` and no repeated `push write failed` warnings — on its serial monitor (while `LOG_ECHO=1`) or in the relay's log (`grep "connected to WiFi" nodejs/camera-relay/logs/camera.log`)
- [ ] `curl -H "X-Control-Key: YOUR_CONTROL_KEY" http://localhost:8080/status` on the Pi shows a recent `lastSeen` for every camera
- [ ] `http://127.0.0.1/camdash/` on the Pi (with `-u user:pass`) shows all cameras live
- [ ] Starting a recording from the dashboard (or `POST /record/:id?seconds=10`) produces a playable `.mp4` under the relay's `recordings/` folder — if it doesn't, check `ffmpeg` is installed and on `$PATH`
- [ ] The `.onion` address (`http://<your-address>.onion/camdash/`), opened in Tor Browser, prompts for Basic Auth and then shows all cameras live
- [ ] **⏻ LOG OUT** shows the "logged out" page; after pressing Cancel on the login prompt, reloading the dashboard asks for the login again (try it in each browser you use — see [MANUAL.md, *Login and logout*](MANUAL.md#login-and-logout))
- [ ] Ports 8080 and 8081 (and UDP 8082, see ["Cameras find the relay by themselves"](#cameras-find-the-relay-by-themselves-the-pis-address-may-change)) are **not** reachable from outside your LAN (check your router's port-forwarding list — there should be none for this project)
- [ ] *(If you flashed the optional person detector)* its Serial Monitor prints changing `Person: NN% No person: NN%` lines and flips to `>>> PERSON DETECTED - GPIO HIGH <<<` when someone steps in front of it

## 5. Before you consider this done

- Rotate the `camKey` / `API_KEY` — the one currently in the files was sitting in tracked source before this cleanup. Generate a new one (`openssl rand -hex 24`), put it in the Pi's `config.js` as `camKey`, and set the same value as `API_KEY` on every recorder and every detector with the live view on. `API_KEY` is one of the settings that connect a board to the relay, so it is changed over the serial port only (settings mode: `API_KEY=<the new key>`, see [ASSEMBLY.md](ASSEMBLY.md#1-flash-each-esp32-cam-streamingrecording-sketch)), not from the dashboard and not over the air. Do the boards promptly and then restart the relay: a board still holding the old key counts as a key guesser, and after 10 wrong keys its address is locked out for a while (see [MANUAL.md, *Switching recording ON / OFF* (there: "Guessing a key is slowed down, then stopped")](MANUAL.md#switching-recording-on--off)); restarting the relay clears every lock.
- Pick a real Basic Auth password in `config.php` — don't leave it at any placeholder.
  The dashboard enforces this: with an empty username or password, a password under 8 characters, or the template's `change-me`, it answers **503** and shows nothing (the reason is in the web server's error log). Generate one with `openssl rand -base64 24`.
- Wrong logins are logged (`camdash: failed login for user ...` in the Apache error log) and slowed down; the details, and how to keep strangers from even reaching the login over Tor, are in [MANUAL.md, *Login and logout*](MANUAL.md#login-and-logout).
- Keep `config.php`, `config.js` and your real settings templates (`Arduino/templates/*.txt`) out of git — they're already listed in `.gitignore`; just don't force-add them.
- Back up your `config.*` files somewhere safe (password manager, encrypted volume) — they're gitignored on purpose, so a fresh clone of the repo won't have them.

## Cameras find the relay by themselves (the Pi's address may change)

You do not need a fixed address for the Pi. `SERVER_HOST` is only where a board looks **first**. If its connection to the relay has been down for 30 seconds, the board asks the network *"where is the relay?"*, stores the address the relay answers from as its new `SERVER_HOST`, and restarts to use it. While the relay works at the stored address none of this runs: a healthy system sends no discovery packet at all.

- **How it asks** (UDP, port 8082): first the stored address; then a broadcast (finds the relay anywhere on the same Wi-Fi); then every address of the `/24` the stored `SERVER_HOST` is in (about 3 seconds). The last step is what finds the relay from **behind a NAT router** (a Wi-Fi extender in router mode): broadcasts and mDNS names such as `raspberrypi.local` do not cross a NAT router, but ordinary unicast packets do. A search that finds nothing is repeated after 15 s, 30 s, 60 s ... up to every 5 minutes.
- **Why it is safe to ask everyone:** the question carries no secret. The relay answers with a one-time proof that only a machine knowing `camKey` can make (HMAC-SHA256 over a fresh random number from the board), so the key is never sent to a printer or a stranger, a machine that merely says "yes, I'm the relay" is ignored, and an old answer cannot be replayed. It does **not** protect against someone who can already sit in the middle of your LAN; the cameras' HTTP is plain, as before.
- **On the Pi:** nothing to configure; the relay listens on UDP 8082 (`discoveryPort` in `config.js`, `DISCOVERY_PORT` in the environment, `0` = off; it must equal the sketches' `RF_PORT` setting, default 8082). If the Pi has a firewall, allow it: `sudo ufw allow 8082/udp`. If the port is taken the relay still runs and says so in its log.
- **Flash the cameras with an IP address in `SERVER_HOST`** (any address in the Pi's subnet will do, it does not have to be right). A name that does not resolve gives the board no subnet to search except its own, which is wrong behind a NAT router.
- **What you see:** the relay's log has `a camera at <ip> asked where the relay is` (once an hour per camera). The camera's log has `the relay is at <new ip> now (SERVER_HOST was <old ip>) - stored, restarting to use it`, or `relay not found ... is UDP 8082 blocked on it?` (the first time, then one in twelve).
- **Limits:** a relay older than this update does not answer (the boards then behave exactly as before, with one search of a few seconds every 5 minutes while the relay is unreachable). The search finds only a relay that answers with your `camKey`. IPv4 only. Switch it off per board with the `RF_ENABLED` setting (0) over the serial port or on the detector's settings page — since F-29 the port and the search timings (`RF_PORT`, `RF_FIRST_S`, `RF_OK_S`, `RF_RETRY_MIN_S`, `RF_RETRY_MAX_S`) are settings too, each with the value this document describes as its default.

## First setup without a cable (the board's own setup WiFi)

Typing a board's settings over the serial port (see [ASSEMBLY.md](ASSEMBLY.md#1-flash-each-esp32-cam-streamingrecording-sketch)) needs a cable and an opened case. A board can instead open **its own WiFi network** and show a small settings page that you reach with a phone or a laptop. It works the same for the recorder and the detector. The firmware itself still has to be on the board (flashed once with a cable, or over the air on a board that already runs a newer one); this replaces only the typing of the settings.

### When a board opens its setup WiFi

- **A board that cannot reach the relay** (a new one, or one whose Wi-Fi, server, port, API key or id are missing or invalid) opens it at power-up. The serial prompt keeps working at the same time: whichever you use first wins. A board that has those but lacks some *newer* setting does not: it asks the relay for it, see [DEPLOY.md, *Missing settings after a firmware update*](DEPLOY.md#missing-settings-after-a-firmware-update-no-usb-cable-needed).
- **A board you armed** (`SETUP_MODE=1`, below) opens it at its next restart instead of working normally.
- **Never otherwise.** A configured board whose Wi-Fi has disappeared does *not* open it by itself, on purpose: if it did, a router outage would be an invitation. Such a board needs the cable.
- **There is no time limit.** The setup WiFi stays up until you press **Save and restart** or **Exit setup mode**. A board in setup does not work: no live view, no recording, no alarm.

### First setup of a new board

1. **Power the board.** Its WiFi is called `espcamsys2-recorder-d4e5f6` or `espcamsys2-detector-d4e5f6`; the last six characters are the end of the board's own MAC address, so every board has a different name. The serial monitor (115200) says `setup WiFi up: join "…" and open http://192.168.4.1/`; it never prints the password.
2. **Join it** from a phone or laptop with the **master password**: `Admin1234` for a board that has none yet (or your own build-time default, see below). The phone may say *no internet*: stay connected. Many phones then offer to "sign in to the network" and open the page by themselves; if yours does not, open **`http://192.168.4.1/`** in the browser (typed with `http://`; a browser set to HTTPS-only may refuse it).
3. **Fill in the form.** The settings are the same as in [ASSEMBLY.md](ASSEMBLY.md#1-flash-each-esp32-cam-streamingrecording-sketch) (the form is generated from the firmware's own list); the ones the board still lacks are marked *required*. WiFi has one row per network: its name and password, or tick *open network*; blank rows are there to add more. A blank field means *leave as it is*. Passwords are never sent back to the page: a field only says *set* or *not set*. Unlike the dashboard's camera settings page, this form can change the Wi-Fi, the relay address, the API key and the id too: you are standing at the board.
4. **Choose your own master password**, twice. A board that still has the default refuses to save without it. It is 8 to 63 characters of letters, digits, spaces and punctuation (no accents), because it is also the WPA2 password of the setup WiFi. It is **one password for the whole system**: you will type it whenever you join any board's setup WiFi, so write it down.
5. **Press *Save and restart*.** Nothing at all is stored unless the whole form is valid. If something is wrong the page lists every problem under *Nothing was saved* and keeps what you typed (except passwords: type those again). When it works the page says *Saved*, the setup WiFi disappears after a couple of seconds and the board restarts into normal operation and joins your Wi-Fi.
6. **Repeat for the next board, one at a time.** A phone joins one network at a time; boards powered together show up under different names.

### Changing a working board's settings (arming it)

1. On the dashboard open the camera's **⚙ SETTINGS** page, set **`SETUP_MODE`** to **1** and press **APPLY TO CAMERA**. Within about 30 seconds the board restarts into its setup WiFi. This works only while the board is still online.
2. From then on **every dashboard page shows a red banner** naming the armed boards until they report back as normal. It cannot be dismissed.
3. Join the board's WiFi with the master password (now your own) and open `http://192.168.4.1/` as above. Change what you want and press **Save and restart**, or press **Exit setup mode (change nothing)**, which sends the board back to normal operation without touching any other setting. The exit button is only there on a board that is already configured.
4. Either way the board switches `SETUP_MODE` back to 0 by itself, restarts, and its next report clears the banner.

The switch is a one-shot with no time limit, and a board waiting in setup is offline, so **the dashboard cannot switch it off again**: only the form can (or the cable). A forgotten armed board is a camera that is not recording, with its setup WiFi on, until somebody saves or exits; the banner keeps saying so.

### Replacing the router (many boards at once)

1. While every camera is still online, arm each one (`SETUP_MODE=1`). Each restarts into its setup WiFi and **stops working from that moment**.
2. Replace the router.
3. Go to each board with a phone, join its setup WiFi, enter the **new Wi-Fi name and password** in the form and save.

There is no timeout precisely so that this works: a timer would send a board back to a router that no longer exists.

### Your own default master password (optional, at build time)

The built-in `Admin1234` is in the repository, so everybody knows it. If you would rather a new board never uses it, copy `Arduino/templates/setup_credentials.example.h` to `setup_credentials.local.h` in **each** sketch folder, change the text (8 to 63 printable ASCII characters; anything else stops the build) and build as usual. Git ignores that file. Boards without a master password of their own then open their setup WiFi with yours, and the form still makes you choose a real one; it does not change a board that already has its own.

### If it does not work

| What you see | Why, and what to do |
|---|---|
| The board's WiFi is not in the list | The board is not in setup: it is configured and not armed. Arm it from the dashboard (if it is online), or use the cable. Otherwise check the range: the ESP32 is 2.4 GHz only, so a 5 GHz-only phone cannot see it |
| "Incorrect password" | The master password. `Admin1234` works only until the first setup (or your build-time default); after that it is your own |
| The phone drops the network ("no internet") | Tell it to stay connected (Android: *keep connection*); the board answers every name so most phones then open the page |
| The page does not open | Type `http://192.168.4.1/` (not `https`). At most 4 devices can be joined at once |
| *Forbidden: open the setup page again and resubmit it* | The page is older than the board's last restart: load `http://192.168.4.1/` again and resubmit |
| *Choose your own master password* | The board still has the default: type a new one in both fields |
| Saved, but the board does not come back | Probably the Wi-Fi name or password you entered is wrong (the form can check the format, not whether the router accepts it). There is no automatic fallback: use the cable |
| You forgot the master password | A board that is **not armed** offers the serial prompt at boot (see [ASSEMBLY.md](ASSEMBLY.md#1-flash-each-esp32-cam-streamingrecording-sketch)): `SHOW SETUP_PASSWORD` prints it, or send `SETUP_PASSWORD=<a new one>`. An **armed** board goes straight into setup and does not offer the serial prompt, so there is no way in short of erasing its flash (the settings go with it) and flashing it again |

### Security notes

- The setup WiFi is protected by WPA2 with the master password, and only a device that has joined it can reach the page. Anyone who knows the master password and is in range can reconfigure a board that is in setup, which is why the dashboard banner stays up while a board is armed.
- **Until its first setup a board uses the public default password.** Set new boards up where nobody you do not trust is in range, or use a build-time default.
- The page is plain HTTP inside the WPA2 WiFi: private from outsiders, not from others who know the master password. It runs no script, never shows a secret, refuses any POST without its per-session token, and stores nothing unless the whole form is valid.
- The master password (`SETUP_PASSWORD`) can only be set in the form or over serial, never from the dashboard. `SHOW SETUP_PASSWORD` and `EXPORT` on the serial console print it unmasked, like the API key: keep exported lines private.
- `SETUP_MODE` can be switched on from the dashboard (that traffic is plain HTTP on your LAN), but whoever does it still needs radio range and the master password to do anything with the board.
- There is deliberately **no automatic fallback and no timeout** (see above): a board only opens its setup WiFi because a cable-free first setup or an armed switch asked it to.
