# ESP32-CAM Home Security System — Develop

*For developers working in this repository: the test suite, coverage, compiling the sketches, the generated schema, the security checks and the little tools. For building a board from scratch see [ASSEMBLY.md](ASSEMBLY.md); for deploying a new version see [DEPLOY.md](DEPLOY.md).*

## Where things live

```
Arduino/ESP32_CAM_Recorder/       the recorder sketch (logic in headers, glue in the .ino)
Arduino/ESP32_CAM_TFLite_Person/  the person detector sketch
Arduino/templates/                serial-console settings templates (example.*.txt) and setup_credentials.example.h
nodejs/camera-relay/              the relay: server.js + lib/ (one module per concern), tools/person_scan.py
php/cameras/                      the dashboard: page scripts (*.php), lib/ (Logic.php, Layout.php, MuxStream.php,
                                  DetectorView.php, Reboot.php, device_schema.php, recordings-list.js), js/ (page scripts
                                  the browser loads), fonts/
tests/                            cpp, node, e2e, php, dom (jsdom + Playwright), python, shell, fixtures
tools/                            compile_sketches.sh, gen_device_schema.sh, dump_device_schema.cpp, camdash-power.sh,
                                  sketch_build_lib.sh, test_output.sh
```

Runtime state (all next to `server.js`, gitignored, all redirectable in `config.js` or the environment — see the settings pages in [MANUAL.md](MANUAL.md)): `logs/camera.log` (`logFile`/`LOG_FILE`), `recordings/`, `firmware/` (`firmwareDir`), `device-settings/` (`deviceSettingsDir`), `sounds/` (`soundsDir`, the uploaded alarm sounds), `recording-switch.json` (`switchFile`), `system-settings.json` (the dashboard's SETTINGS page). The dashboard keeps what is saved on its pages in `data/settings.json` under the web folder (see [SETUP.md, *Where settings live*](SETUP.md#where-settings-live)).

The firmware version is `fw_version.h`, written by `ota-deploy.sh` (gitignored, removed afterwards); a sketch built by hand reports `dev`.

## Running the tests (and checking coverage)

`run_tests.sh` in the repo root runs every test suite: the Arduino C++ logic of **both** sketches, a real compile of both sketches, the relay's Node.js logic, the end-to-end tests, the PHP dashboard logic, the DOM tests (the dashboard pages in a simulated browser, plus Playwright browser tests), the Python tests of the person-scan script and the shell tests. It also checks that the eight security patches are still in the sources (`tests/shell/test_security_patches.sh`, which you can run alone for a one-second check). That check only reads the code; what needs the real hardware — the cameras connecting and streaming, the dashboard over Tor, an over-the-air update with real boards — is checked by hand on the Pi. Nothing needs flashing — it all runs on your laptop or the Pi.

Two tests need a package that is installed separately: `tests/dom/test_index_dom.js` runs the real dashboard page in a simulated browser (jsdom) to prove that nothing from the relay or `config.php` can become markup or script, and `tests/dom/test_resume_dom.js` uses it to check that the pictures start over when the page comes back after a phone was locked. `./run_tests.sh` installs it by itself (`npm ci` in `tests/dom`, the first time and whenever a patch changes its lockfile; it needs a network connection then). If that is not possible (no npm, no network) that test prints `SKIP` and everything else still runs — but a skipped test protects nothing, so make sure it ran on the machine where you test before you commit. You can also install it by hand: `cd tests/dom && npm ci`.

```bash
./run_tests.sh
```

You need `g++`, `node` and `php` on `PATH` (and `gdb`, which gives a backtrace if a C++ test crashes; without it the tests still run), plus `python3` with OpenCV and NumPy for the person-scan tests. The end-to-end tests also need `npm install` to have been run in `nodejs/camera-relay/` (run_tests.sh installs the relay's dependencies itself from the lockfile). A missing tool is reported as a failure rather than silently skipped. The exit code is `0` only if everything passed.

### How much of the output you see: `--verbose`

By default the run prints one dot for every test case that passed, and the failed ones in full (`[FAIL] ...`), so a thousand passing tests do not bury the one that failed. Anything else that is not a pass — a crash, a `SKIP`, a compile error, a warning — is shown too.

| | |
|---|---|
| `./run_tests.sh` or `--verbose 0` | a dot per passed test case; the failures in full (the default) |
| `./run_tests.sh --verbose 1` | the same, and the text of the groups: the suite titles, the test file names, each suite's summary |
| `./run_tests.sh --verbose 2` | everything, one line per test case |

`--verbose` on its own means `--verbose 2`, and `--verbose=1` works too. The exit code is the same at every level. The levels are applied by `tools/test_output.sh`, which can wrap any command whose test output uses the `[PASS]` / `[FAIL]` lines.

### Compiling the sketches: does the sketch itself still build?

The C++ tests build only *parts* of the sketches (the logic headers, and blocks cut out of the `.ino` files) against desktop fakes, so a patch can pass all of them and still leave a sketch that does not compile — a name used above its declaration, a missing `#include`, a call the real core does not have. `run_tests.sh` therefore also compiles both sketch folders as a whole with the real toolchain, through `tools/compile_sketches.sh`. It writes nothing into the repository and flashes nothing. Run it before you start a patch (to know you start from a sketch that builds) and again before you finish it.

One-time setup on the machine that runs the tests (the same toolchain `ota-deploy.sh` uses):

1. Install [`arduino-cli`](https://arduino.github.io/arduino-cli/latest/installation/) and put it on `PATH`.
2. Install the **esp32** core, version 3.x: add `https://espressif.github.io/arduino-esp32/package_esp32_index.json` to `board_manager.additional_urls` (`arduino-cli config add board_manager.additional_urls <url>`), then `arduino-cli core update-index` and `arduino-cli core install esp32:esp32`.
3. Have the `esp-tflite-micro` library where `arduino-cli` looks for libraries (step 1 of [ASSEMBLY.md](ASSEMBLY.md#2-optional-flash-a-person-detector-instead-tflite-micro) clones it into `~/Arduino/libraries`, which is its default); the person detector needs it.

```bash
tools/compile_sketches.sh              # both sketches (default: all)
tools/compile_sketches.sh detector     # or: recorder
```

It compiles every sketch even if an earlier one failed and prints the compiler's output only for the ones that did not compile. The exit code is `0` if both compiled, `1` if one did not, and `2` if the toolchain or the board is missing (then nothing was compiled, so nothing is known about the sketches). The board and the extra compile arguments are the ones from your `ota.conf` (`FQBN`, `EXTRA_COMPILE_ARGS`), or the defaults of `ota-deploy.sh` when you have none, so what is checked is what gets deployed. The first compile of the person detector takes a few minutes (the TFLite library is big); by default each run builds in a throwaway temp directory, so set `SKETCH_BUILD_DIR=$HOME/.cache/espcamsys-build` if you want the build files kept between runs and later runs only recompile what changed.

Without `arduino-cli`, `./run_tests.sh` **fails** at this step, like it does for any other missing tool. On a machine that is not meant to compile firmware, say so with `./run_tests.sh --no-sketch-compile`: the step is then reported as skipped, loudly, and the rest runs as usual.

### Failing the run when coverage is too low: `--coverage N`

```bash
./run_tests.sh --coverage 90
```

With `--coverage N` (N is a minimum percentage, 0–100) the C++ tests are rebuilt with gcov instrumentation, the PHP tests are run with a coverage driver, the Node.js tests (unit and end-to-end) are run with Node's built-in coverage, and the run **fails** if line coverage is below N. Without the flag nothing is instrumented and the run is exactly as before. `--coverage=90` works too, and `./run_tests.sh --help` prints the usage.

- **Each area is judged on its own.** N applies separately to the Recorder sketch, the person detector sketch, the dashboard's PHP logic, the relay's Node.js logic and the relay's `server.js`, so a well-tested one can't make up for a weak one. Each area prints its own `ok:` or `FAIL:` line.
- **Only code that can run on a desktop is measured.** For `ESP32_CAM_Recorder` that is `logic.h`, `remote_log.h`, `settings_logic.h`, `settings_schema.h` and the remote-logging and settings blocks cut out of the `.ino`. For `ESP32_CAM_TFLite_Person` it is `report_logic.h`, `scene_logic.h`, `motion_baseline.h`, `settings_schema.h` and the extracted detection, settings, logging and uplink blocks of the `.ino` (the detection block holds `setPersonDetected()`, `detectPerson()` and `loop()`, including the hysteresis). `setup()` and the camera/WiFi/model initialisation need the real hardware and are not in the percentage, so 100% does not mean the whole sketch is covered.
- **PHP: every file of `php/cameras/lib/*.php` is measured** (`Logic.php`, `Layout.php`, `DetectorView.php`, `MuxStream.php`, `Reboot.php`, `device_schema.php`), which is the code the PHP unit tests in `tests/php/` run. The page scripts (`index.php`, `settings.php`, …) are web entry points that are only exercised by the end-to-end tests through a real web server, so they are not in the percentage. A new file in `lib/` that no test loads is reported as `NO DATA` and fails the check instead of being silently ignored.
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

## The device settings schema

The dashboard's per-device settings pages (a camera's ⚙ SETTINGS, the detector's ⚙ CALIBRATE) are generated from the sketches' own settings tables (`settings_schema.h` in both sketch folders): `tools/gen_device_schema.sh` reads them (with `tools/dump_device_schema.cpp`) and writes `php/cameras/lib/device_schema.php`. Run it after every change to a `settings_schema.h`; `run_tests.sh` checks the committed file against a fresh regeneration (`--check`) and fails the run if you forgot.

## The security-patch check

`tests/shell/test_security_patches.sh` (about a second, no setup) reads the sources and fails if any of the eight security patches has been undone:

| Patch | What it is |
|---|---|
| 0001 | `POST /alarm/:id` and `/alarm/all` require the camera key |
| 0002 | relay binds to 127.0.0.1 (superseded by 0007, kept for history) |
| 0003 | PHP caps how much of `php://input` it reads |
| 0004 | the relay honours `X-Actor` only from loopback |
| 0005 | the SSID is masked in remote log lines |
| 0006 | the login throttle state file lives outside /tmp |
| 0007 | `requireReadKey` fails closed (reads need the control key) |
| 0008 | test fixes (no production code) |

The setup mode's own security review — how the board's settings Wi-Fi was audited and fuzzed, and what was found — is `F-21-S10-security-review.md` at the repo root (referenced from the fuzz test registration in `run_tests.sh`).

## Environment snapshots

`capture-env.sh` records what a machine has (OS, node/php/apache versions, toolchain, git state) as a Markdown file — the format of `dev-2026-10-23.md` (a developer laptop) and `relay-2026-10-23.md` (the Pi) at the repo root. Run it before asking for help or starting a platform-sensitive change, and commit the snapshot with a date in the name.

## Sketch developer switches

Four compile-time switches sit at the top of `ESP32_CAM_TFLite_Person.ino` (not per-board settings): `PRINT_DETECTION_SCORES`, `PRINT_STARTUP_INFO`, `PRINT_SCENE_READINGS` (off by default — switch it on only while choosing `DARK_THRESH`/`MOTION_THRESH`, see [ASSEMBLY.md](ASSEMBLY.md#darkness-and-motion-gate-fewer-false-positives-less-work)) and `TENSOR_ARENA_SIZE`.
