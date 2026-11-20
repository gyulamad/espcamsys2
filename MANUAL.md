# ESP32-CAM Home Security System — User Manual

*How to use and configure the running system: the dashboard and its pages, recording, the person check, the detector, settings, resets, notifications, the log and troubleshooting. For the one-time setup see [SETUP.md](SETUP.md); for deploying new versions see [DEPLOY.md](DEPLOY.md); for building a board see [ASSEMBLY.md](ASSEMBLY.md).*

## Login and logout

Every page of the dashboard sits behind **HTTP Basic Auth** (realm `Camera Dashboard`). The login cannot be weak: with an empty username or password, a password under 8 characters, or the template's `change-me`, the dashboard answers **503** and shows nothing (the reason is in the web server's error log). Generate a good password with `openssl rand -base64 24`.

Wrong logins are logged (`camdash: failed login for user ...` in the Apache error log) and slowed down: after 10 wrong logins in a row every attempt gets **429** for 15 s, doubling up to 15 minutes — even with the right password. Over Tor every visitor looks like 127.0.0.1, so the counter is global: someone guessing can lock the owner out for a while. Tor v3 *client authorization* (an `authorized_clients/*.auth` file in the hidden service directory) keeps strangers from reaching the login over Tor at all and is the recommended second lock for the `.onion` address; on the LAN the equivalent is the optional HTTPS (see [SETUP.md](SETUP.md#2-set-up-the-php-dashboard-on-the-pi)) plus a password only you know.

**Logging out.** The navigation bar, on every page behind the login, has a **⏻ LOG OUT** button at its right end. The login is HTTP Basic Auth, which the *browser* remembers, so the server cannot end it: the button makes `logout.php` answer with a login prompt for the same realm, which tells the browser to forget the saved login, and shows a "logged out" page. **Press Cancel on that prompt** (typing the login into it just asks for the same page again); *LOG IN AGAIN* on the page goes back to the dashboard. Browsers differ in how reliably they forget a login (Safari is the least reliable), so on a shared computer also close every window of the browser — in Tor Browser use *New Identity*. Each logout leaves a `camdash audit: <user>@<address> logged out` line in the web server's error log.

## The navigation bar and the pages

Every page behind the login starts with a **navigation bar** that stays at the top of the window: **⊞ DASHBOARD** (the cameras as a grid — the old GRID/LIST pair is one dashboard now, F-43a), **▣ SIMPLE VIEW**, **▦ SIMPLE LIST**, **📼 ALL FILES**, **⚙ SETTINGS** (the main system's settings page, F-41) and **🛰 OTA & LOGS**, the current page highlighted, and **⏻ LOG OUT** at its right end. On a phone the bar is a **☰ button** (F-42): opening it stacks the pages' links with LOG OUT at the end; a click outside, ESC, or turning the phone closes it. It is the only place with these buttons (no page has its own copy, and the former dashboard button **DELETE ALL FOOTAGE** is now the **🗑 DELETE ALL** of the ALL FILES page, which asks the same confirmation and deletes the recordings of every camera). It is hidden while a picture or a recording plays full screen. **Developer mode** (the *Developer mode* switch in the ⚙ SETTINGS page's Dashboard category, ON by default) decides whether **⊞ DASHBOARD** and **🛰 OTA & LOGS** are in the bar at all (F-43b): with it OFF the bar shows only SIMPLE VIEW, SIMPLE LIST, ALL FILES and SETTINGS — for an everyday operator — and while it is ON every page carries an amber notice at the very top: *Developer mode is active, turn off in settings.*.

- **Camera icon**: every page shows the icon set for a camera (⚙ SETTINGS) in front of its name (📷 when none is set).
- **Recording frame** (dashboard, simple list and simple view): a camera that is recording has a **blinking red frame** around its picture; otherwise the frame is there but transparent, so nothing moves. With *reduce motion* set in the system the frame stays steady red.
- **▦ SIMPLE LIST** (`simple-list.php`): every camera as a live thumbnail and nothing else. The thumbnails are as big as all of them fit on the screen, but never narrower than 160 px (below that a picture is no longer recognisable): with many cameras the page scrolls instead. Click a thumbnail to open it in the simple view.
- **▣ SIMPLE VIEW** (`simple-view.php?cam=<id>`, no `cam` = the first camera): one camera in large, a **← PREV** / **NEXT →** pager (the arrow keys work too) and a status line: time, camera name and **RECORDING: ON / off** (`–` while the relay cannot be asked). **Click the picture to show it full screen**; another click (or Esc) leaves. On the dashboard, a click on a camera's picture opens that camera in this view.

The pages' scripts are the files in `js/` (copied by `deploy.sh`); they are plain files with no secrets, everything they show comes from the dashboard's own pages behind the login.

### The one live connection (`mux.php`)

A browser allows only about 6 connections per address over HTTP/1.1, so a live picture per camera would use them all up, and the file list, a clip or any other request of the page could wait for ever. Therefore every page (the dashboard, SIMPLE LIST and SIMPLE VIEW) holds exactly ONE long-lived request, `mux.php`, which passes on the relay's `GET /mux` stream; everything else is a short request (a page load, the answer to a click). It is always on: there is no switch for it in `config.php` (a leftover `'mux_enabled'` line is ignored) and no older way to fall back to.

- **What rides on it:** the cameras' pictures, the person detectors' pictures (a detector's picture comes as its camera's), the detectors' live numbers (the sensor bars) and the cameras' recording state (the REC pills, the FILES counts and the ON/OFF switches). `mux.php` renames and shapes what the relay sends and passes on only what the page asked for. The relay works out the recording state once every 2 seconds for all tabs together; the page's own clock ticks every second. The connection is downlink only; the page's own commands are ordinary short requests (and every 5 seconds the relay writes a heartbeat into the stream, so the page can tell a dead connection from a quiet one).
- **It never gives up:** if it breaks (the relay restarts, a phone is locked, the network drops) the page reopens it by itself, after 1, 2, 4, 8 and then every 15 seconds, and the bars and pills say `NO DATA` and the pictures stay blank until it is back. Hiding or showing a camera reopens the connection with the new list, so every picture blinks for a moment (over Tor, a second or two). Hiding every camera keeps the connection, so the numbers and the REC pills keep moving. A phone that was locked reconnects when the page is shown again.
- **Apache:** each open browser tab holds one PHP worker for as long as the page is open, so `MaxRequestWorkers` must be above the number of tabs you keep open. The relay accepts at most 16 of these connections at the same time (one per open tab); the 17th is refused (the relay answers `503`, which the browser sees as `502` from `mux.php`) and retries until a tab is closed. Apache must not buffer or compress `mux.php` (no `mod_deflate` or proxy buffering for it; the pictures would arrive in bursts or not at all). `mux.php` switches PHP's own buffering off and sends `X-Accel-Buffering: no`, so the usual setup needs nothing; check this first if the pictures arrive in bursts behind another proxy.
- **Updating:** the relay and the dashboard go together, the relay first (`deploy.sh` ships both). A dashboard with an older relay gets no pictures, because an old relay has no `/mux`.
- **When it does not work:** the browser only gets `502 Could not connect to the relay` (the same when 16 tabs are already open); the web server's error log has the reason as a `mux.php:` line, at most one per kind of problem every 5 minutes:

  | The log line says | Means | Do this |
  |---|---|---|
  | `mux.php: could not reach the relay for GET /mux (…): is it running, and is relay_url in config.php right?` | The dashboard's PHP cannot connect | Start the relay; fix `relay_url` in `config.php` |
  | `mux.php: the relay answered GET /mux with a redirect (HTTP …)` | A redirect is never followed, so that the control key is not sent anywhere else | Point `relay_url` at the relay itself, not at something that redirects |
  | `mux.php: the relay answered GET /mux with HTTP … and not the mux stream: is the relay … older than this dashboard?` | The relay has no `/mux` (or is something else). With `HTTP 503` it is the opposite: 16 tabs already hold the connection | Update and restart the relay on the Pi, then the dashboard; for `503`, close tabs |

### The slideshow

- **▶ SLIDESHOW** (button on the simple view; it is **on by default** when the page opens, the button stops and restarts it): shows the cameras one after the other, each for **Slideshow time per camera** seconds (⚙ SETTINGS, `slideshow_seconds` in `config.php`, 2-300, default 10). Cameras that are busy come first:
  1. A camera that **starts recording**, or whose paired person detector reports **motion at or above its MOTION_THRESH**, is shown at once, without waiting for the time to run out. **A human always keeps the view:** motion never pulls it away from a camera that records or whose detector sees a person; only a human on another camera does (a recording is not displaced by a mere person seen, which turns into a recording a moment later).
  2. When the time is up, only the cameras of the highest priority take part: while any camera has a **human** (it records, or its detector sees a person), only those take their turns — **a camera with a human is never left for one without**, so with a single human the slideshow stays on it however often the time is up and whatever moves elsewhere; with no human anywhere, the ones in motion; with none of either, all of them. Human beats motion, motion beats the rest. **A camera that is not connected** (the relay got no frame from it for 5 s; `online: false` in `GET /status`) comes last: it is skipped as long as any other camera is connected, and only when every camera is offline do they take their turns.
  3. Pressing PREV / NEXT during a slideshow shows that camera for a full time. While the slideshow runs, **NEXT IN n s** (status line) and a thin bar under the picture show the time left before the next camera; both are hidden while there is nowhere to go (one camera, or the only camera that records). Pressing the button again ends the slideshow.
  4. The PREV / NEXT buttons still go to a camera that is not connected, and the **simple view** and **simple list** then cover its (stale) last picture with a spinner and *Waiting for the camera…* until it sends again.

  A person detector that **sees a person** counts above plain motion; a person seen and a recording are both a human. The cameras are looked at every 2 s (the pushed status arrives on the mux connection at that rate) and a look can be lost (the relay is busy, a request fails): a camera therefore **keeps its human for 6 s** after the data stops showing one (`HUMAN_HOLD_MS` in `js/simple-logic.js`), so one lost look cannot take the view away from a human; a human who really left holds the view for those 6 s longer, then the time moves it on. A detector rests while nobody watches (see ["The detector live view switch"](#the-detector-live-view-switch-watch-button)), so while the slideshow runs it switches the live view on for **all** detectors and renews it every 20 s; it takes up to ~30 s until a resting detector answers the first time. The views lapse by themselves after the slideshow ends. Motion needs a person detector paired with the camera: a camera without one can only take part by recording.

  **Screen stays on:** the simple view and the dashboard keep a phone or tablet screen from going dark while the pictures run (`js/screen-keeper.js`). The simple view's status line says what holds the screen: **SCREEN: KEPT ON** (the browser's Screen Wake Lock), **SCREEN: KEPT ON (VIDEO)** (the fallback below) or **SCREEN: NOT HELD – TOUCH THE PAGE** (the browser wants a touch before it starts the fallback). Only the page that is open and visible holds the screen; the device's own battery-saver may still override it.

  - The Wake Lock works only on **HTTPS** (or `localhost`). On plain `http://` (a Pi on the home network, e.g. `http://raspberrypi.local`) a tiny silent video plays out of sight instead; some browsers start it only after the first touch on the page, and on some tablets it is not enough to keep the screen on.
  - **Android Chrome, plain http:** make Chrome treat the Pi's address as secure so the real Wake Lock works (only on that device):
    1. Open `chrome://flags/#unsafely-treat-insecure-origin-as-secure` on the tablet.
    2. Enter the exact address you open the dashboard with, e.g. `http://raspberrypi.local`, and set the flag to **Enabled**.
    3. Tap **Relaunch**. The status line then shows **SCREEN: KEPT ON**.
  - **iPhone / iPad** have no such flag: serve the dashboard over HTTPS instead (see [SETUP.md](SETUP.md#2-set-up-the-php-dashboard-on-the-pi)).

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

How it is protected: the dashboard login → a request header only the dashboard's own script can send (`X-Requested-With: camdash`, so a page on another website can't trigger "OFF" using your cached login) → the control key, added by the dashboard's server (the browser never sees it) and checked by the relay in constant time. Every change is written to the log with who did it (`recording switched OFF until … by alice (via 127.0.0.1)`), and so is every refused attempt, with its address.

Direct use (e.g. from the Pi, with `curl`):

```
curl -X POST -H "X-Control-Key: <key>" "http://localhost:8080/recording/camera/cam2/off?minutes=30"
curl -X POST -H "X-Control-Key: <key>" "http://localhost:8080/recording/all/off?minutes=0"
curl -X POST -H "X-Control-Key: <key>"  http://localhost:8080/recording/all/on
curl -H "X-Control-Key: <key>" http://localhost:8080/recording/state          # who is OFF
```

Notes: **the same control key also protects everything that changes things from the dashboard**: saving the alarm length (`POST /settings`), the RECORD / STOP buttons (`POST /record/...`), and deleting or marking recordings (`DELETE /recordings/...`, `POST /recordings/.../seen`). The dashboard already sends it on those calls, so with `relay_control_key` / `controlKey` set as above nothing changes for you. **Without `controlKey` in the relay's `config.js` those actions are refused (503), never left open** — if RECORD or DELETE suddenly stops working after an update, that is the first thing to check; direct calls need `-H "X-Control-Key: <key>"` like the examples above. **Watching needs the control key too.** Live video, snapshots, recordings, `GET /status`, `/settings`, `/record/<id>`, `/detectors` and `/recording/state` answer **401** without it — before this, anyone who could reach port 8080 could watch the cameras and download the recordings. The dashboard already sends the key on every one of these calls (and the browser never talks to the relay directly), so nothing changes for you once `controlKey` / `relay_control_key` are set. **And with no `controlKey` at all the relay refuses reads too (503)** — there is nothing to check against, so it fails closed; older versions read through instead. Set `READ_KEY_REQUIRED=0` in the relay's environment only on a trusted LAN with no Tor exposure to get that old behaviour back; the relay logs a loud warning at every start while `controlKey` is missing — treat that line as an error to fix. What stays open (no key): only `POST /alarm/<id>` / `POST /alarm/all`, which a camera board falls back to over plain HTTP when its in-band alarm can't be sent — the firmware has no key for that call, so it cannot be protected without reflashing the boards. An alarm can only start a recording; it can't delete or reconfigure anything. Even so, keep the relay's port 8080 on a trusted network (firewall it to the dashboard and the cameras).

**Guessing a key is slowed down, then stopped.** After 10 wrong keys from one address within a minute, the relay refuses that address for 60 seconds — HTTP **429** with a `Retry-After` header (a camera's push connection is simply dropped) — and every further lock doubles in length, up to 15 minutes. While an address is locked out even the *right* key is refused, and the log gets one `LOCKED OUT` line. The camera key and the control key are counted separately, so a camera with an old key cannot lock the dashboard out; a request with *no* key at all is not counted. If you see 429 after changing a key, fix the key and wait out the `Retry-After` (or restart the relay, which forgets all locks). The numbers can be changed with the environment variables `AUTH_MAX_FAILURES`, `AUTH_LOCK_SECONDS` and `AUTH_LOCK_MAX_SECONDS`.

**The folder settings are confined.** The log file, the recording on/off state file, the firmware folder, the alarm sounds folder and the staged device-settings folder can be changed on the dashboard's settings page only to a path **inside the relay's own folder** (for example `firmware` or `data/firmware`): no absolute path, no `..`, nothing starting with a dot, not under `lib/`, `node_modules/` or `recordings/`, and a file setting must end in `.log` / `.json` and cannot be one of the relay's own files (`server.js`, `config.js`, `package.json` ...). A location elsewhere (a USB disk, `/var/log/...`) is set by hand in `config.js` (`logFile`, `switchFile`, `firmwareDir`, `deviceSettingsDir`), which is not restricted; the settings page leaves such a value alone as long as you do not change it. A timed OFF uses the Pi's clock; a Pi without a battery-backed clock may be off by a little right after boot until it has synchronised.

## The ALL FILES page (navigation bar → 📼 ALL FILES)

The **📼 ALL FILES** button of the navigation bar opens one list with the saved recordings of **every camera**, newest first (by the time in the clip's name, which is the moment the recording was triggered). Each row names its camera and has the same buttons as a camera's own **📼 FILES** list: **▶ PLAY**, **⬇ GET**, **🗑 DEL** and a tick box, and at the bottom **SELECT ALL / SELECT ALL SEEN / DOWNLOAD SELECTED / DELETE SELECTED**; **DELETE ALL** at the top deletes the recordings of every camera (after a confirmation). Clips nobody has played or downloaded yet are bold and bright; playing or downloading one marks it seen for every device, as on the dashboard. **↺ REFRESH** loads the list again (the page does not redraw itself while you watch a clip). If one camera's recordings cannot be read, the others are still listed and the list says which camera is missing.

Nothing new is exposed: the page asks `recordings.php` for each camera's list and for every play, download, delete and "seen" mark, so the dashboard login, the anti-forgery header, the file-name check and the audit log are the same as for the per-camera lists. The list code lives in one file, `php/cameras/lib/recordings-list.js`, which both the dashboard and the ALL FILES page include (`deploy.sh` copies it to `lib/`, which the web server never serves; PHP writes it into the pages).

**A FILES button with no number** (`📼 FILES` instead of `📼 FILES (3)`) means the dashboard's web server couldn't reach the relay within 2 seconds when it built the page — check `relay_url` in `config.php` and that the relay is running. A number is written into the page by the server on every load, then kept current by the live status push; it works with older relays too (it counts their file list instead).

## The OTA & LOGS page (navigation bar → 🛰 OTA & LOGS)

After a release you can watch it from the browser instead of over SSH. The **🛰 OTA & LOGS** button of the navigation bar opens one page with two parts, each refreshed on its own timer:

- **OTA STATUS** — a table of every board that has asked the relay for firmware: the same columns `curl -H 'X-Control-Key: …' http://127.0.0.1:8080/ota/status` prints (**ID, TYPE, PUBLISHED** (the version the relay offers), **RUNNING** (what the board reports), **STATE**, **LAST SEEN, LAST ERROR**). The state is coloured: `updated` green, `pending` (it has not taken the published version yet) amber, `offline` red, `nothing-published` grey. **Refresh (s)** (default 10) says how often it is read again.
- **LOGS** — the end of the relay's log (`nodejs/camera-relay/logs/camera.log`) and of Apache's error log (`/var/log/apache2/error.log`), each under a `==> path <==` heading as `tail` prints it — like `tail -f` of both files piped through `grep -E '\b(WARN|ERROR)\b'`. The level boxes **WARN, ERROR, DEBUG, INFO** choose what is shown (WARN and ERROR by default); **All** shows every line. **Tail length** (default 1000, 1 to 5000) is how many lines of each file are looked at, **Refresh (s)** (default 10) how often they are read again. A change is applied at once. The log follows the newest line while you are at its bottom and stays where it is when you scroll up to read. A tab that is hidden is not refreshed until you come back to it. Apache's error log is `0640 root:adm` on Raspberry Pi OS / Debian, so a relay that is not in the `adm` group cannot read it: the page then says `(cannot be read: the relay is not allowed to read it (permission denied) …)` with the one-line fix — `sudo usermod -aG adm <relay user>` and a relay restart (see [SETUP.md](SETUP.md#1-set-up-the-relay-serverjs-on-the-pi)). The relay's own log is the relay's file and is always readable.

How it differs from the command you would type: the last N lines of each file are taken first and THEN filtered, as `tail -n N | grep` does (a quiet log shows fewer than N lines, never older ones); only the current file is read, not the rotated `camera.log.1`; a line counts for a level when it holds the word (`WARN`, `ERROR`, …) — and an Apache line also by its own `[module:level]` tag (`[php:error]` is an ERROR, `[core:warn]` a WARN), because Apache never writes the words and the plain grep would never find one of its errors; the lines of a multi-line relay entry that do not hold a level word are left out, exactly as the grep leaves them out; control characters in a line are shown as `?`. With no level ticked the page asks you to choose one.

**Setting it up**

1. `relay_control_key` in the dashboard's `config.php` must be the same as `controlKey` in the relay's `config.js` — see [\"Setup: one secret, in two places\"](#setup-one-secret-in-two-places). The page asks the relay for both parts through `ota-status.php` and `logs-tail.php`, which add the key; **it never reaches the browser**. When it is missing or wrong, the part says so in the relay's own words (`Could not load the OTA status: missing or wrong control key`).
2. The relay needs the route `GET /logs/tail`: deploy it with [`deploy_all.sh`](DEPLOY.md#deploying-a-new-version-in-one-go-deploy_allsh), which updates the dashboard first and the relay last — until the relay has restarted, the LOGS part says `Could not load the log: …` and OTA STATUS works as before.
3. The **relay** reads the two files, not the web server, so the user it runs as must be allowed to read Apache's log. On Raspberry Pi OS the default user `pi` is in the group `adm`, which is enough (check with `id`; otherwise `sudo usermod -aG adm <user>` and restart the relay). When it is not allowed, the page shows `(cannot be read: the relay is not allowed to read it (permission denied))` under that file and still shows the other. No `sudo` and no extra privilege is involved.
4. Another place for Apache's log: the setting `apacheErrorLog` (`config.js`, or the `APACHE_ERROR_LOG` environment variable; SETTINGS page → Log, expert level). Set from the page it must be a `.log` file inside the relay's own folder; a file elsewhere can only be named on the machine itself. `APACHE_ERROR_LOG=` (set to nothing) leaves Apache's log out of the page.

**What to know:** anyone who can log in to the dashboard can read these logs (Apache's error log can hold client addresses, paths and PHP error messages). Only the two files the relay's settings name are ever read — never a path from the browser — and only their last lines (at most 4 MB of a file, 5000 lines, 2000 characters a line). Reading is **not** written to the relay's log (the page polls; each poll would add a line to the log it shows); a wrong control key is, as for every other route, at most once a minute.

## Sorting out footage without a person

A badly tuned motion/person alarm records a lot of clips with nobody in them. The relay can check every recording with a YOLO person detector (OpenCV's DNN module on the Pi's CPU — no GPU, no PyTorch on the Pi) and set the empty ones aside.

How it works, per clip: the detector reads the recording frame by frame in colour and **stops at the first frame with a person** — that frame (person boxed) is saved next to the clip as `<clip>.mp4.thumb.jpg` and shown as a small picture in the file list, so you see who it is without playing it. Only if the **whole** clip was read and nobody was found is it "without a person": it is then **moved** to `recordings/<camera>/no-person/` (default, nothing is lost) or **deleted** (`action: 'delete'`). Every failure — model missing, detector crashed or timed out, clip unreadable or cut short, clip still being encoded — leaves the clip exactly where it is and shows `⚠ check failed: <reason>` next to it. Clips are checked one at a time, at low priority, so cameras keep being served.

### 1. Install the detector's packages (on the Pi)

```
sudo apt install -y python3-opencv python3-numpy
python3 -c "import cv2, numpy; print(cv2.__version__)"
```

### 2. Get the model (once, on your laptop or on the Pi)

The detector reads a standard Ultralytics YOLO model exported to ONNX (class 0 = person, the COCO order every Ultralytics model uses). Both the classic output (YOLOv5/v8/v11, `1 × 84 × N`) and the end-to-end output (YOLOv10/YOLO26, `1 × N × 6`) are understood. Export a **nano** model at 640 px. The export tool is only needed for this one step, so install it in a throwaway virtual environment (Raspberry Pi OS / Debian refuse `pip install` system-wide: `error: externally-managed-environment` — do not work around that with `--break-system-packages`). The relay itself keeps using the system `python3-opencv` from step 1:

```
sudo apt install -y python3-venv
python3 -m venv ~/yolo-export
~/yolo-export/bin/pip install ultralytics onnx
cd ~ && ~/yolo-export/bin/yolo export model=yolo26n.pt format=onnx imgsz=640 opset=12   # or yolo11n.pt if yolo26n is not available to you
rm -rf ~/yolo-export        # optional: it pulls in PyTorch (about 1 GB)
```

The export writes `yolo26n.onnx` into the folder you ran it from (`~` above); `find ~ -name '*.onnx'` shows where it is. (If you export on a laptop instead, do the same there and `scp` the `.onnx` file to the Pi.)

**Put the model in the folder the relay runs from, as `models/person.onnx`.** That is the folder that holds `server.js` — the `nodejs/camera-relay/` folder of your checkout (for example `~/espcamsys2/nodejs/camera-relay`), or wherever you copied it (such as `/opt/camrelay`). If it is not there the file list shows `⚠ check failed: the person detector model is not installed (expected at <path>)` next to the clip, and that path is where to put it:

```
mkdir -p ~/espcamsys2/nodejs/camera-relay/models        # use your relay folder
cp ~/yolo26n.onnx ~/espcamsys2/nodejs/camera-relay/models/person.onnx
ls -l ~/espcamsys2/nodejs/camera-relay/models/person.onnx
rm ~/yolo26n.*              # the copy in your home folder is no longer needed
```

No relay restart is needed for a newly placed model (it is looked for at every check). To keep the file somewhere else, set `model: '/full/path/to/file.onnx'` in the `personScan` block of `config.js` (step 4).

(Model weights are published by Ultralytics under the AGPL-3.0 licence — check it fits your use. Use a `yolo*n` model first; the larger `s` model is more accurate but several times slower on a Pi.)

### 3. Try it on one clip (on the Pi)

```
cd ~/espcamsys2/nodejs/camera-relay        # your relay folder (the one with server.js)
python3 tools/person_scan.py --model models/person.onnx --video recordings/<camera>/<some clip>.mp4 --thumbnail /tmp/test-thumb.jpg
```

It prints one line of JSON: `{"ok": true, "person": true, "confidence": 0.81, "frameIndex": 42, ...}` (and writes `/tmp/test-thumb.jpg`) or `{"ok": true, "person": false, ...}`; `"ok": false` carries the reason. Try a clip you know has a person and one that is empty before switching anything on. Time it: on a Pi 5 expect a few frames per second at 640 px — if clips take too long, raise `stride` (every Nth frame is analysed; a person is on screen for many frames, so `stride: 3` loses little).

### 4. Switch it on (SETTINGS page, or relay `config.js`)

Once the model is installed, switch the check on at the dashboard's **SETTINGS** page: **Person check** → *Person check (sort out recordings without a person)* → **ON**, then SAVE. It applies at once (no restart, no SSH), also **OFF** again: from then on nothing new is checked, and clips still waiting for their check are left where they are (they report "the person check is switched off"). The switch is kept over restarts and wins over `personScan.enabled` in `config.js`, which only gives the starting state (off unless you set it). Everything else below stays in `config.js`:

```
  personScan: {
    enabled: true,           // the starting state; changeable on the SETTINGS page
    auto: true,              // check every recording right after it is saved
    action: 'move',          // 'move' to recordings/<camera>/no-person/ (safe), or 'delete'
    confidence: 0.4,         // the starting sensitivity; lower keeps more doubtful clips (changeable on the SETTINGS page)
    stride: 1,
  },
```

All the options are listed in `example.config.js`. Restart the relay process (copying files does not change the running one). A bad value is reported at start (`[config] personScan...`) and the default is used.

### 5. Use it from the dashboard

In every file list (a camera's **📼 FILES** and **📼 ALL FILES**): **🧑 SORT OUT ALL** checks every clip not checked yet, **🧑 SORT OUT SELECTED** only the ticked ones. A clip waiting or being checked shows `⏳ processing…`; the list reloads itself until all are done (not while a clip is playing). Clips with a person get their picture in the row; **click it to see the frame in large** (click again or press Esc to close). To get a moved clip back, press **📂 BROWSE ARCHIVE** (see ["The archive and a full disk"](#the-archive-and-a-full-disk) below) and **♻ RESTORE** it — or copy it by hand from `recordings/<camera>/no-person/` into `recordings/<camera>/`.

### The archive and a full disk

The `no-person/` folders are the *archive*: clips the check found nobody in, kept (`action: 'move'`) but off the lists. They still take disk space, so when the dashboard warns that the storage is almost full, delete them: **🗄 DELETE ARCHIVE (N)**, next to **🧑 SORT OUT ALL** in the file list, shows how many archived clips (N) the cameras of that list have, and deletes them **for good** after a confirmation. Hover the button for the short explanation. The button only appears while the archive is not empty, also when the list itself is empty (everything was sorted out). **To check what is in the archive first**, press **📂 BROWSE ARCHIVE** (it appears next to **🗄 DELETE ARCHIVE**): the archived clips are listed under the header, newest first, each with **▶ PLAY**, **⬇ GET** and **♻ RESTORE**; **RESTORE** puts the clip back into the normal list (and out of the archive and the N of the delete button). A clip is never restored over a recording of the same name — you get a message and nothing changes. A restored clip has no person picture and is checked again by the next **SORT OUT ALL**; it is not checked again by itself. **📂 HIDE ARCHIVE** closes the list. You can also look at `recordings/<camera>/no-person/` on the relay over SSH (`ls recordings/*/no-person/`). Only plain clip files (`<name>.mp4`) are deleted; a folder, a link or any other file you put in `no-person/` is left alone. Like every action that deletes recordings it needs the dashboard's login and control key, and leaves a line in the web server's error log (who and which camera) and in the relay's log. With the person check switched off, the buttons answer "the person check is switched off" and say where to switch it on.

**Safety notes.** `no-person/` is not shown in the lists and is not cleaned up by the relay on its own — delete it with **DELETE ARCHIVE** (above) or by hand (`recordings/*/no-person/`) when you trust the detector. **The sensitivity is on the dashboard's SETTINGS page** ("Person check" → *Person detection sensitivity*, a number above 0 up to 1, default 0.4): no SSH, no restart — a saved value counts from the next clip checked (a check already running keeps the one it started with) and is kept over restarts; it wins over `personScan.confidence` in `config.js`, which only supplies the starting value. Lower = more sensitive: more doubtful clips are kept. It is the same number for every YOLO model the script reads (the person score the detector must reach), so changing the model needs no other setting here — but models score differently, so re-judge the value on your footage after a model change (the model file, input size and `stride` stay in `config.js`). Judge `confidence` on your own footage: night, small or partly hidden people are the clips a detector misses; start with `action: 'move'` and look in `no-person/` for a week before ever using `'delete'`. The check needs the dashboard control key like every other action that changes recordings.

## The Wi-Fi network and signal on the dashboard

Next to every camera's name the dashboard shows which Wi-Fi network the camera is connected to and how strong the signal is, and the detector row has a **WI-FI** line of its own: signal bars, the network name and the strength in dBm (for example `HomeNet · -61 dBm`; hover it for the verdict and how old the reading is). The bars follow the usual scale: -55 dBm or better is excellent (4 bars, green), -65 good (3, green), -75 fair (2, amber), -85 weak (1, red); below that the link is hardly usable (1 red bar). The network is the one the board is *connected to right now* — a board with several `WIFI` entries joins the strongest one in range, and this tells you which one that was.

Nothing to configure: it is always shown, for every camera and every detector. A line that is not there means the dashboard has no fresh reading (see below).

How it travels, if you ever need to follow it:

- A **recorder** writes a small control message on its push connection every second (and right after connecting), between two frames, so it costs no frame. Like the in-band alarm it is only sent to a relay that announced it understands it (the third byte of the relay's greeting), so a relay older than this firmware simply never gets it.
- A **detector** puts the network next to the signal (`rssi`, which it always sent) in its status. While it rests (live view off) it has no connection to the relay, so it sends both with its live-view poll (`GET /detector/<id>/view?ssid=…&rssi=…`, about every 30 seconds): a resting detector still shows its network, only less often.
- The relay checks everything a board sends (a name of at most 32 bytes without control characters, a signal from -127 to -1 dBm; half a reading is no reading), keeps the latest and forgets a reading after two minutes. The dashboard checks it once more before it reaches the browser and puts the name on the page as text only. A change of network is written to the relay's log (`the camera is on the Wi-Fi network 'Upstairs'`), a change of signal is not.

**Upgrading:** update the relay (`nodejs/camera-relay`, then restart it) and the dashboard first, then flash or publish the boards (`ota-deploy.sh`, see [DEPLOY.md](DEPLOY.md)). Any order is safe — a board whose firmware predates this shows no Wi-Fi line, and a firmware that is newer than its relay sends nothing — but the line only appears once all three are current.

## The detector live view switch (WATCH button)

A person detector no longer streams all the time. The sensor values and the small grey picture are sent only while somebody wants to see them; otherwise the detector drops the link, the Wi-Fi radio rests, and the board asks the relay about every 30 s.

- On the dashboard each detector row has a **▶ WATCH** button (shown only for detectors with the new firmware). It switches the live view on for **10 minutes** by default; **■ STOP** ends it (the time left is no longer shown on the button). While the dashboard is open and you are active, the view is renewed automatically (the dashboard re-asks the relay every 20 s while you keep using the page).
- The duration is the relay setting `detectorViewMinutes` (`config.js`, or the env `DETECTOR_VIEW_MINUTES`; 1-1440, default 10).
- Latency: ON takes up to ~30 s (the board's next ask), OFF about 3 s. A detector with older firmware, or a relay without the switch, simply streams all the time as before.
- The simple view's SLIDESHOW switches the live view on for all detectors by itself (and renews it every 20 s while it runs).
- Re-flash the person detector sketch and update the relay and the dashboard together.

## A detector does not show up — where to look

Every step reports what it finds, so you should not need a serial cable:

- **On the dashboard** the picture says *why* it is not showing instead of a bare "offline":

  | The picture says | It means | Do this |
  |---|---|---|
  | `the relay has not heard from a detector called 'X' since it started` (and, if some other detector *is* heard: `it does hear 'Y', which no camera here is paired with: is DETECTOR_ID on the board or the pairing mistyped?`) | No board has ever connected under that id | Compare `DETECTOR_ID` on the board (`SHOW` on the serial console) with the id paired in the camera's ⚙ SETTINGS. Otherwise the board is off, not on Wi-Fi or cannot reach the relay: read its lines in the relay log (below) |
  | `last heard 42 s ago; its connection ended (…)` | It was there and went away; the reason is the connection's | Power or Wi-Fi of the board; its own log lines (below) say more |
  | `the numbers arrive but there is no picture: the board reports N failed JPEG encodings` | The model runs but the board cannot encode its picture (out of memory) | Lower `STREAM_JPEG_Q`; check the board's free-heap line |
  | `NO DATA` … `The dashboard cannot reach the relay` | The dashboard's PHP cannot talk to the relay | The relay is down, or `relay_url` in `config.php` is wrong; the web server's error log has the reason |

  When the relay cannot give the connection at all, the web server's error log gets a `mux.php: …` line saying why (at most one per kind of problem every 5 minutes; see ["The one live connection"](#the-one-live-connection-muxphp)). The relay's own log says why a detector that is connected has no picture (`has sent no picture …`, at most once every 5 minutes per detector and state).
- **How fast the sensor bars move:** the numbers (brightness, motion, person score) are *pushed* from the relay to the dashboard the moment a detector sends them, on the one live connection described above, and the page draws each update at once, with no polling delay and no animation. It works the same over the LAN and over Tor. How often a detector sends is the board's `STREAM_MAX_FPS` (1–30, set on the CALIBRATE page) and how fast it finishes a detection round; raise it for a faster bar. While that connection is down the bars say `NO DATA` and come back by themselves when it is back; the page does not ask for the numbers in any other way.
- **In the relay's log** every step of every detector is recorded, under the `DETECTOR_ID` — both what the relay saw (`[relay]`) and what the board itself reports (the same remote logging the recorders use, with no settings: always on with the live view, `INFO` and above):

  ```
  grep detector-1 nodejs/camera-relay/logs/camera.log | tail -n 30
  ```

  | A line like | Means |
  |---|---|
  | `[relay]: detector connected` / `detector is sending pictures (the first: 1256 bytes of JPEG)` | The uplink is up and the board has a working camera and JPEG encoder |
  | `[relay]: refused a detector uplink request from 192.168.4.37 … HTTP 401 — wrong key` | `API_KEY` on the board is not the relay's `camKey` |
  | `[relay]: the dashboard asked for the picture of detector 'X' but there is none: …` | The dashboard asked and there was nothing; the line says why and lists the detectors the relay does know |
  | `[relay]: detector disconnected after 3m 5s, 1234 pictures received (…)` | How long it was up and why it ended: `the board closed the connection`, `the connection was reset: the board lost power or Wi-Fi, or restarted`, `no data for 60s` |
  | `[relay]: the detector has been connected for 10s and reports its numbers, but has sent no picture` | JPEG encoding fails on the board |
  | `booted after an abnormal restart: BROWNOUT / PANIC / watchdog` | Why the board restarted: a power dip, a crash, a hang |
  | `Wi-Fi still not connected: NO_SSID_AVAIL (none of the WIFI networks is in range)` | The board cannot join Wi-Fi: wrong `WIFI`, or out of range (`CONNECT_FAILED`: wrong password) |
  | `could not reach the relay at 192.168.4.9:8080: …` | Wi-Fi is fine but the relay is not reachable: wrong `SERVER_HOST` / `HTTP_PORT`, relay down, firewall (it retries after 2, 4, 8 … `ANN_RETRY` seconds) |
  | `the relay at … refused the uplink (HTTP 401): wrong key …` | As above, seen from the board |
  | `the relay at … answered HTTP 404 … probably a relay older than this firmware` / `hung up without answering the uplink request` | The relay on the Pi is older than the detector firmware: update `nodejs/camera-relay` and restart it |
  | `the relay at … did not answer like a web server (…)` / `did not answer the uplink request within 5 s` | `HTTP_PORT` is not the relay's HTTP port |
  | `lost the connection to the relay at … after 5m 07s (…); it had carried 1234 pictures — reconnecting` | A running link ended and how; it reconnects by itself |
  | `could not encode the 96x96 frame as JPEG` | Low on memory on the board |
  | `Camera init failed: 0x105 (ESP_ERR_NOT_FOUND) - camera not detected: …` / `TFLite initialization FAILED - the detector cannot work, restarting in 30 s` | The board could not start its camera or model: it says so, waits 30 s so the line can reach the relay, and restarts (it used to wait forever, looking fine on a serial cable while doing nothing) |
  | `alarm line GPIO 13 HIGH: person detected` / `LOW: clear` | When the alarm line moved |
  | `heartbeat: …` | Every `ANN_HEARTBEAT` seconds: Wi-Fi, signal, memory, the state of the link |

  If the board's own lines never appear but the relay's `[relay]` lines do, the uplink works and only the log delivery does not; if neither appears, read the serial console: everything above is printed there too.

## Calibrating the detector from the browser

A detector that is paired with a dashboard camera (`'detector' => 'detector-1'` in `config.php`, or set on its camera's SETTINGS page) shows a **⚙ CALIBRATE** button on its row. It opens a page with the detector's own settings, the same way a recorder's settings page works:

- **What can be changed:** `DARK_THRESH`, `MOTION_THRESH`, `MOTION_HOLD_S`, `MOTION_X0` / `Y0` / `X1` / `Y1` (the motion area, also drawn on the dashboard), `MOTION_EMA_LEN` / `MOTION_EMA_PCT` (the motion auto-calibration), `DETECT_THRESH`, `CLEAR_THRESH`, `LOOP_DELAY_MS` and the stream tuning (`STREAM_MAX_FPS`, `STREAM_JPEG_Q`, `STREAM_WR_TMO_S`, `ANN_*`). Everything that connects the detector to the relay (`WIFI`, `SERVER_HOST`, `HTTP_PORT`, `API_KEY`, `DETECTOR_ID`) and the alarm pin (`PERSON_GPIO`) can only be changed over the USB serial port.
- **How it works:** *APPLY TO DETECTOR* queues the change on the relay (`PUT /device-settings/detector/<DETECTOR_ID>/change`). The detector's network task asks for it about every 30 seconds, checks it again (it refuses anything unsafe, a `CLEAR_THRESH` above `DETECT_THRESH` and a motion area that is outside the picture or under 10 × 10 pixels — the dashboard checks that already before queueing), stores it, **restarts** (about 10 seconds without a picture, and the alarm pin is released) and reports back. The page shows *applied* or the reason it was refused.
- **Calibrating:** keep the dashboard open next to the page and watch the detector's BRIGHTNESS, MOTION and HUMAN readings. Put `DARK_THRESH` just below the brightness at which the picture is too dark to see a person, `MOTION_THRESH` above the motion value of a still scene and below that of a person walking, and `DETECT_THRESH` / `CLEAR_THRESH` where the HUMAN score separates a person from the empty scene. (The gate itself is described in [ASSEMBLY.md, *Darkness and motion gate*](ASSEMBLY.md#darkness-and-motion-gate-fewer-false-positives-less-work).)
- **Needs:** the detector flashed with a firmware that includes `settings_sync.h` (it reports its settings to the relay when it boots; until then the page says it has not reported yet), `relay_control_key` in `config.php` (as for the recorder's settings page) and the relay's `controlKey`. A detector that has never reached the relay cannot be calibrated this way: use the serial console once.
- After changing a `settings_schema.h`, run `tools/gen_device_schema.sh`; it now generates the dashboard's table for both sketches (see [DEVELOP.md](DEVELOP.md#the-device-settings-schema)).

## Resetting from the browser

The reset menus hard-reset parts of the system. Every camera card has one (**RESET**: *camera*, *detector* or *both*) and the page header has one (**REBOOT ALL**: *Node.js only*, *PHP only*, *both servers*, or *reboot and reset all*). Each asks you to confirm first. The browser sends `POST reboot.php?target=<name>[&cam=<camera id>]` (`detector`, `camera`, `both`, `nodejs`, `php`, `relay`, `all`); it needs the dashboard login, and the relay's control key is added on the server (`relay_control_key` in `config.php` and `controlKey` in the relay config, as for the recording switch).

- **Boards (camera, detector):** the dashboard asks the relay to queue a *reboot* command (`POST /device-settings/<recorder|detector>/<id>/reboot`). The board's network task finds it on its next poll (up to about 30 seconds), tells the relay *applied* **first** and only then restarts (a hard reset: `ESP.restart()`, which also releases the alarm pin). A reset whose answer cannot get through is not carried out, so a board never restarts in a loop over one command. A command a board has not fetched within 10 minutes is dropped (a board that was off does not reset itself hours later). The relay refuses (409) a board it has never heard from. The camera must have been flashed with this firmware (an older one answers *rejected* and does nothing; publish with `ota-deploy.sh`, and copy the new `nodejs/camera-relay/` to the Pi **before** the boards — see [DEPLOY.md](DEPLOY.md)).
- **Node.js (`nodejs`):** the relay restarts itself (`POST /restart`) and systemd or pm2 starts it again. A relay started by hand refuses (it would only stop), and the dashboard says so. Live pictures and recording pause for a few seconds.
- **PHP (`php`) and the Pi (`all`):** a web server cannot restart itself, nor the Pi, so `sudo ./deploy.sh` installs two small things: `/usr/local/sbin/camdash-power` (root-owned; takes exactly `restart-php` or `reboot`, nothing else, and does it a few seconds later from a systemd timer so the page still gets its answer) and `/etc/sudoers.d/camdash-power` (lets the web server's user `www-data` run exactly those two commands, with no password and no other command). Without them those targets answer *not set up* **before** anything is touched. If your Apache runs under another unit name than `apache2`, change it in `tools/camdash-power.sh`; if you install the helper elsewhere, set `'power_command' => ['sudo', '-n', '/path/to/camdash-power']` in `config.php`.
- **Both servers (`relay`):** Node.js first, then PHP; if the relay refuses to restart, PHP is left alone.
- **Everything (`all`):** every camera and every paired detector is told first, then the Pi reboots. The boards fetch the command when the relay is back (within the 10 minutes), so expect them to restart a minute or two after the Pi is up again. A board that has never reported is skipped and the answer says so; the Pi still reboots. Nothing is watched or recorded until it is all back, which takes a few minutes.
- **The page after a restart:** after *PHP* or *all* the page is unreachable for a few seconds up to a few minutes; reload it.

## The SETTINGS page (dashboard → ⚙ SETTINGS)

Every setting of the main system can be changed from the dashboard instead of editing `config.js` / `config.php` over ssh: not just the relay's ports, camera key, control key, pre-roll, alarm recording length and log rotation size, but everything that used to live in `config.js` or the environment too — the person check's automation and time limits, the Telegram notifications, the camera discovery port and the push connection timeouts, how long the detector live view runs, the wrong-key lock-out times, and more. Plus the dashboard's own login and relay address.

The page shows **one category at a time** — the **category rail** on the left lists them (Recording, Person check, Alarm sounds, Network, ... the dashboard's own last, and **CAMERAS** at the very end: the camera list of the old settings page lives there), with the number of settings each holds. **Every setting is on the page** — there is no LEVEL switch any more, the basic and the expert ones sit together (F-37). Edits you make in one category stay pending while you browse another; the **tray at the bottom** lists every pending change (old → new), and **APPLY** is the one button that writes anything — nothing is saved behind your back. Every row shows **what it would fall back to** (`default 60`, highlighted while the saved value differs from it) and a **↺ DEFAULT** button that puts that value back — through the same APPLY as a hand-made change. Rows marked *restarts relay* tell you a change needs the relay restarted; the dashboard does that for you when you apply.

**The search box at the top is always there** (F-38): type part of a setting's name (`jpeg`), its label (`debounce`) or its help text and the result list takes the page's place — every word typed must match, the pills narrow it to Cameras / Detectors / Relay. Emptying the box brings the settings page back (ESC clears, ESC again goes back). A hit opens the page the setting is edited on with the row highlighted and focused.

**Three kinds of row stay out of reach on purpose.** **File and folder paths** (`logFile`, `firmwareDir`, `deviceSettingsDir`, `soundsDir`, `switchFile`, and the person detector's model file) decide where the relay writes and serves files as its own user, and anyone who can save settings here (or who borrows the dashboard login) could otherwise point them at any folder on the Pi: they are not even shown — change them on the Pi itself, in the relay's `config.js` (or its environment variables `LOG_FILE`, `FIRMWARE_DIR`, `DEVICE_SETTINGS_DIR`, `SOUNDS_DIR`, `SWITCH_FILE`) and restart the relay; the dashboard refuses to send them even if asked. **The programs the relay runs** (the person detector's `python` and `script`, the sound player) are *locked*: the page shows them read-only — so you can see what runs — but they can only be changed in `config.js` on the machine itself. And a row the **environment** overrides (a setting with its `PORT`-style variable set) is read-only, because saving it could not change anything.

The form is generated from the relay's list of settings, so each one comes with its description and limits.

- **Saving applies the change for you.** Dashboard settings (login, relay address) apply at once. Relay settings that are read at startup are marked *restarts relay*; after saving, the dashboard asks the relay to restart itself and the page waits until it answers again. Settings that are read as they are used — the alarm length, the person check's switch and sensitivity, the free-storage limit, the most recordings at the same time, the restart cooldown — apply immediately with no restart. Nothing needs to be redeployed.
- **Where it is stored.** The relay keeps what you save in `system-settings.json` next to `server.js`, laid over `config.js` at startup (so `config.js` stays the starting point and is never rewritten). The dashboard rewrites `config.php` (keeping your cameras). It no longer leaves a `config.php.bak` in the web folder; for a backup set the environment variable `CAMDASH_BACKUP_DIR` to an absolute folder outside the web root (mode 0700, the file inside is 0600). Environment variables (`PORT`, `CAM_KEY`, …) still win over both; such a field is shown read-only.
- **Low recording storage warning.** The setting *Minimum free recording storage (MB)* (default 1024, `0` = off) is on this page, in the Recording section. When the free space on the disk that holds the recordings falls below it, **every dashboard page shows an alert on load**: "The recording storage is almost full (only XY MB is free). Please delete old files." Close it and carry on working; it comes back on the next page load until space is freed. **With a notification channel set up** (see [nodejs/camera-relay/lib/notify/README.md](nodejs/camera-relay/lib/notify/README.md)), you also get a message when the disk falls below the minimum and a reminder every `storageReminderHours` hours (default 24, `0` = none) while it stays there, so you hear about it without opening the dashboard. It applies at once (no relay restart). The relay measures the disk with `statfs` (Node 18.15+) or `df -Pk` (older Node), and an unreadable disk gives no warning. `config.js` (`minFreeStorageMB`) or the environment variable `MIN_FREE_STORAGE_MB` can set the starting value.
- **The relay must be started by systemd or pm2** so it comes back by itself — the unit in [SETUP.md](SETUP.md#1-set-up-the-relay-serverjs-on-the-pi) (`Restart=on-failure`) is enough, the relay exits with code 75 to be restarted. A relay started by hand refuses to restart (the page tells you) instead of just stopping; set `RELAY_SUPERVISED=1` if something else restarts it.
- **One-time requirements:** `relay_control_key` in `config.php` and `controlKey` in `config.js` (see [SETUP.md](SETUP.md)) — the page uses it to talk to the relay — and `config.php` must be writable by the web server (`deploy.sh` runs `chown www-data` on it).
- **Safety nets.** A new relay address is tested before it is saved (a wrong one would lock the dashboard out of the relay): it must answer like a relay (`/status` with JSON), and every failure reads the same, so the page cannot be used to scan your network. The relay's address is where the dashboard sends the control key, so the page only accepts an address on this machine or your local network (`127.x`, `10.x`, `172.16-31.x`, `192.168.x`, Tailscale `100.64-127.x`, `::1`, `fc00::/7`, or a name like `raspberrypi` / `pi.local`) — use the relay's IP address. A relay that really lives elsewhere (another network, a public name) can still be set by hand in `config.php`; the dashboard never follows redirects from the relay, so a relay cannot hand the key on to another server; changing the relay's HTTP port updates the dashboard's address with it; rotating the control key updates the dashboard's copy; the camera key and the camera push port are flashed into every board, so changing them asks for confirmation. If the saved settings file is ever damaged, the relay starts with `config.js` and logs a warning.

## Camera settings page (a camera's ⚙ SETTINGS button)

Every camera card on the dashboard has a **⚙ SETTINGS** button. Its page has two parts:

- **Choosing an icon:** a click on the icon field (here, and for a new camera on the main ⚙ SETTINGS page) opens a bubble with a search bar on top and the icons below, like the emoji pickers of chat apps: type a word (`door`, `garage`, `dog`) to narrow them, click one — or press Enter to take the first — and it is put in the field. Esc or a click outside closes it; the arrow keys move between the icons. Any other icon can still be typed into the field by hand.
- **On the dashboard:** the camera's name and icon, and a button to remove it from the dashboard. The camera *id* can't be edited (it is what ties the entry to the board's `CAMERA_ID`): remove and add again. **Adding** a camera is on the main ⚙ SETTINGS page (Cameras section). Adding or removing only changes what the dashboard shows: no board is touched and no recording is deleted.
- **Stored in the camera:** every setting in the board's flash (alarm input, push gap, remote log ...), as a form generated from the firmware's own settings table. Press **APPLY TO CAMERA** and the change is queued on the relay; within about 30 seconds the camera asks for it, checks it, stores it, **restarts by itself** and reports back, and the page shows *applied* (or the reason it refused). No cable, no ssh.

**How it works.** The dashboard checks your change first (so a typo is answered at once), then queues it on the relay (`PUT /device-settings/<type>/<id>/change`, control key). The board's background task (the same one that checks for firmware updates) asks `GET .../change` every 30 s, applies it with the same all-or-nothing checks as the serial console, and posts what it holds and how it went to `POST .../report` (camera key). The page's picture of the camera comes from that report, so it only fills in after the camera has booted once with this firmware.

**Safety rules**
- **`SETUP_MODE`** is on this page like any other setting (it shows *Off* for a board that has never had it). Switching it to **1** sends that board into its own setup WiFi at its next restart: see [SETUP.md, *Changing a working board's settings*](SETUP.md#changing-a-working-boards-settings-arming-it). `SETUP_PASSWORD` (the master password) is never shown or changed here.
- **The settings that connect the camera to the relay stay serial-only** — Wi-Fi, server, ports, API key, camera id — shown on the page as *serial only*. A wrong value there would leave a board nobody can reach without a USB cable. (If you want to change them remotely too, that needs a "try it, and go back if the relay can't be reached" feature; ask for it.)
- A change is **all or nothing** and may **never leave the board needing a setting it doesn't have**: switching a feature on (for example the alarm GPIO) requires its other settings in the same change.
- Secrets never leave the board: the report carries the Wi-Fi *name* and a masked password, and the key as `********`.
- The queue holds one change per camera; a newer one replaces it, and a queued one can be withdrawn on the page. The relay log shows setting **names only**.

**Rolling it out.** Publish the new firmware to the cameras once with `ota-deploy.sh` (they pick it up over the air) and copy the new `nodejs/camera-relay/` to the Pi (see [DEPLOY.md](DEPLOY.md)). After that no camera needs a cable for a settings change. When you change the firmware's settings table (`settings_schema.h`), regenerate the page's copy with `tools/gen_device_schema.sh` (`./run_tests.sh` fails if you forget — see [DEVELOP.md](DEVELOP.md)). The person detector is not a dashboard camera, but it has its own settings page for calibration: the **⚙ CALIBRATE** button on its row under the camera (see ["Calibrating the detector from the browser"](#calibrating-the-detector-from-the-browser)).

## Notifications

The relay can send you a message — a text and, where there is one, a thumbnail picture — when something happens: **a person in a new recording**, and **the recording storage almost full**. Every way of delivering it is a *channel*; you can configure one or several (Telegram is the recommended, documented one), and with none, nothing is sent and nothing changes. The full setup walk-through — creating the bot, the chat id, the `notifications` block of `config.js`, the environment variables, testing it — is in [nodejs/camera-relay/lib/notify/README.md](nodejs/camera-relay/lib/notify/README.md). Test your channels with:

```
curl -X POST -H "X-Control-Key: YOUR_CONTROL_KEY" http://localhost:8080/notifications/test
```

- A person found in a recording is announced with the frame the detector stopped at, at most one message per camera per `cooldownSeconds` (default 60). The link (when `notifications.footageBaseUrl` is set) opens the dashboard's ALL FILES page with the clip playing.
- The low-storage message uses the same "Minimum free recording storage (MB)" setting as the dashboard's alert: one message when the disk falls below it, then a reminder every `storageReminderHours` hours while it stays there.

## Alarm sounds (SETTINGS page → "Alarm sounds")

The system can make a sound when a **recording starts** (an alarm input, the person detector or the RECORD button — a recording that is only *extended* does not sound again) and when the person check **finds a person in a new recording** (so that one needs the person check to be ON with its detector installed; a clip you re-check by hand stays quiet). Each of the two has its own sound and its own two switches:

- **Sound** — one of the sound files below, or *(no sound)*, which is the starting state: nothing sounds until you choose one.
- **Play it on the relay machine** — the Pi (the machine the relay runs on) plays it through its own speaker.
- **Play it in the browser** — every browser that has the live dashboard, the camera list or a camera view open plays it. A browser only allows sound after you have clicked or tapped on its page once (a wall tablet needs one tap after it is opened); if it refuses, the page says so once.

Both switches start ON; they only matter while a sound is chosen. All of it is on the SETTINGS page, applies at once (no restart) and is kept over restarts.

**The sound files** are managed at the top of that group: **UPLOAD** a file, **▶ PLAY** it in this browser, **🔊 ON RELAY** to hear it on the Pi's speaker (if the Pi cannot play it, the page says why), **🗑 DELETE** it. WAV, MP3 or OGG, up to 1 MiB each (a little under the web server's 2 MiB request limit), at most 20, and short. A name uses letters, digits and `. _ -` only (anything else in your file's name becomes `_`), and uploading a name that exists replaces it. A sound an alarm still uses **cannot be deleted** — choose another there first, so an alarm never falls silent unnoticed. The files are kept in the relay's `sounds/` folder (`soundsDir` in `config.js`, or `SOUNDS_DIR`; like the other folders it is not on the dashboard's page and not in git). Only a file's first bytes are checked (a renamed web page or program is refused); a file that looks right but is not really audio is accepted and then simply fails to play. To make a test sound: `ffmpeg -f lavfi -i "sine=frequency=880:duration=1" beep.wav`.

**The Pi's speaker.** The relay runs an audio player over the file — by default `ffplay` (it comes with `ffmpeg`, which the relay needs anyway, and plays all three formats). It needs a sound output the relay's user can use (on a Pi the headphone jack or HDMI; check with `speaker-test`, and that the user is in the `audio` group). To use another player, say so in the relay's `config.js` — the file's path is added as the last argument, no shell is involved, and the dashboard cannot change it:

```js
alarmSounds: {
  player: ['aplay', '-q'],   // or ['mpg123', '-q'], ['paplay'] ... default: ffplay -nodisp -autoexit -loglevel error
  timeoutSeconds: 30,        // a sound still playing after this long is stopped (1-300, default 30)
},
```

One sound at a time: while one is playing, another request is dropped, so an alarm that starts the recording on every camera at once makes ONE sound (in the browser too). If the Pi's player cannot start (not installed, no sound card) the relay log gets one `the alarm sound could not be played on this machine: ...` line a minute, and the **🔊 ON RELAY** button tells you the reason at once.

**What travels.** The relay decides; the browsers are told over the one `/mux` connection (a new `alarms=1` part: the latest few alarm events, each with a number that only goes up) and fetch the sound from the dashboard (`sounds.php`). A page plays an event once, and only if it is not older than 15 seconds when it arrives; the first list a page gets is only remembered, so opening or reloading a page never replays an old alarm. Uploading, deleting and the speaker test need the dashboard login, its own anti-forgery header and the relay control key (`relay_control_key` / `controlKey`, as for the recording switch).

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

Notes: the **recorder** and the **person detector** (`ESP32_CAM_TFLite_Person`) both report to this log with the same code. The detector has **no `LOG_*` settings**: it always reports `INFO` and above, with a fixed retry (30 s, 3 times, then serial only until its connection to the relay is up again). What it reports is listed in ["A detector does not show up"](#a-detector-does-not-show-up--where-to-look). Remote logging needs the new relay and new firmware; against an older relay the camera simply gives up after its retries and keeps printing to serial.

## Troubleshooting: an alarm doesn't record, or a stream goes dark

Start with the log (`tail -n 200 nodejs/camera-relay/logs/camera.log`) — it usually answers the question directly.

1. **Is the relay actually running the new code?** `curl -s -H "X-Control-Key: YOUR_CONTROL_KEY" http://<relay>:8080/status` — every camera should have a `preRoll` entry, and the log starts each run with `relay started (pid …)`. If not, the relay process was never restarted after the files were copied.
2. **Did the alarm reach the relay?** Look for `alarm received (in-band)` followed by `recording started (…)` (or `recording extended`) for that camera. If a recording could not start you will instead see `error handling a alarm from the push connection …` with a stack trace and the reason (full disk, folder permissions, …) — the relay itself keeps running and the camera keeps streaming; fix the reason and the next alarm works.
3. **What did the camera do?** Its own entries show which route the alarm took: `alarm sent in-band on the push connection`, `relay hasn't announced in-band alarm support … using the HTTP request`, or `alarm: no push connection — using the HTTP request`. (On a camera with a serial monitor attached the same lines appear there.)
4. **Did a camera drop or restart?** Look for `camera disconnected after …s (reason)` from the relay and, from the camera, `booted after an abnormal restart: …`. If the relay itself restarted there is a `relay started` line, and just before it either `relay stopping (SIGTERM)` (on purpose) or `FATAL: uncaught exception` with its stack trace.
5. **A FILES button with no number** — see ["The ALL FILES page"](#the-all-files-page-navigation-bar---all-files).
6. **A camera with a weak WiFi signal** (`rssi` of about -80 dBm or worse; the log shows it on every line). A full-size frame can then take many seconds to send. The system copes in three ways, all automatic:
   - the camera sends **smaller frames** while the link is slow (`link is slow, sending smaller frames: JPEG quality 12 -> 18`) and brings the picture back when it recovers (`link recovered, improving the picture`). The coarsest quality it will use is `JPEG_QUALITY_WORST` in `ESP32_CAM_Recorder.ino` (63 — the OV2640 JPEG engine's ceiling: the camera driver clamps anything above that, so there is no point asking for coarser). The finest quality, the coarsest quality and whether the adapter runs at all are tunable per camera from its SETTINGS page (`JPEG_Q_MIN`, `JPEG_Q_MAX`, `JPEG_Q_DROP`): set `JPEG_Q_DROP` to `Off` to hold a fixed quality whatever the link, or narrow the range (e.g. `12`-`30`) to keep the picture finer at the cost of more stalls on a bad link. When even the coarsest quality cannot get a frame through and `SIZE_DROP` is `On` (the settings page again), the **resolution drops a rung too** (`link too slow even for the coarsest frames — dropping the resolution: frame size VGA 640x480 -> CIF 400x296`), one step at a time down to QQVGA 160x120 (`FRAME_SIZE_LADDER` in `ESP32_CAM_Recorder.ino`), and climbs back (`link recovered, adding pixels back`) once the link has carried the smaller size at full quality for a while. A recording whose camera changed size mid-clip is encoded at the size it started with, so the clip still plays as one smooth video;
   - it waits at most `PUSH_MAX_GAP_MS` (1 s) between frames, and rides out a bad few seconds (`PUSH_WRITE_TIMEOUT_MS`, 8 s) before it gives up on a connection;
   - when it does reconnect, the relay recognises the **same board returning**: `the camera reconnected — closed its previous connection …, which had been silent for …s`. That is normal on a bad link, not an error. The relay also drops a connection that has been completely silent for 60 s (`camera disconnected after …s (no data for 60s)`; set `PUSH_IDLE_TIMEOUT_MS` in the relay's environment to change it; a connection that has not sent its first line within 10 s is dropped too, `PUSH_AUTH_TIMEOUT_MS`).

   The warning `another connection with the SAME camera id is still sending frames (from <ip>, last data <n>s ago)` is different: it means two connections are delivering frames **at the same time**, i.e. two boards really are flashed with the same `CAMERA_ID`. Give each board its own.

   Software can only do so much at -87 dBm: expect a coarse picture and a frame every few seconds. A camera with an external antenna (many ESP32-CAM boards have a small resistor to switch from the printed antenna to the connector), or a repeater nearer to it, fixes it properly.
7. **The FILES list stays empty, or a clip "loads forever" (Brave, Chrome)** — the live pictures are connections that never end, and these browsers allow only about 6 at a time to one address. With 4 cameras and a detector view, almost all of them are taken, so the list request and the video wait in the browser's queue (the Network tab shows them as *Pending*; pressing the browser's stop button used to cure it). The dashboard now closes every live picture while you wait for footage (opening the list, a clip playing, a delete, a download starting) and reopens them afterwards; the cards say `LIVE VIEW PAUSED WHILE FOOTAGE LOADS` meanwhile. If a clip is playing, the pictures stay closed until you close the player or it ends. Cameras you pressed HIDE on stay hidden.
