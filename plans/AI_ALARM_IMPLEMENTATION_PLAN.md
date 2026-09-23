# AI Human Detection Alarm — Implementation Plan

**Project:** [gyulamad/espcamsys2](https://github.com/gyulamad/espcamsys2)
**Status:** §7 steps 1-2 implemented (see notes below). Steps 3-8 not yet implemented.
**Audience:** Written for an implementer (human or AI) with zero prior context on this conversation. Everything needed to start coding is below.

> **Implementation note (step 1, added when step 1 was implemented):** by the time step 1 was implemented, the repo's actual transport for camera → relay traffic had moved from the per-frame `POST /upload` this whole document was written against to a **persistent raw TCP push connection** (`pushPort`/`PUSH_PORT`, see `server.js`'s `pushServer` and the sketch's `pushClient`) — `/upload` survives only as a legacy, unused-by-firmware endpoint (see `example.config.js`'s `(and legacy /upload)` comment). That socket already carried a device←relay control byte (pause/resume), i.e. an inbound channel to the camera already existed, contradicting §1's "no inbound channel" / decision #1's "piggyback on `/upload`" premise. Step 1 was implemented on the **existing push socket instead**, adding a new tagged JSON command frame alongside the pre-existing control byte (see §5.6 below, updated in place, and the code comments on `encodeCommandFrame()` in `nodejs/camera-relay/lib/protocol.js` / the AI-alarm section of `Arduino/sketch_sep12a_camera2_behind_NAT/logic.h`). The *intent* of decision #1 (no new inbound port, piggyback on an already-open device-initiated connection) is preserved; only the specific transport named changed. Everything else in this document (state machine, config keys, rolling buffer, etc.) is unaffected — implementers of steps 2+ should read §5.6 as corrected, not as originally written.

> **Implementation note (step 2, added when step 2 was implemented):** step 2 is the relay + dashboard toggle only — see §7 step 2 below for exactly what was built and where. No contradictions with the plan as written; the one judgment call worth flagging is that `AI_ALARM_ENABLED_DEFAULT` (§5.1) turned out to make more sense as a **relay-side** config key (`aiAlarmEnabledDefault` in the relay's `config.js`) than a device-side one for now: the relay is what actually owns `cam.aiCommand` (the mutable, dashboard-toggled state — see the step 1 note on §5.6), and the device has no independent AI logic of its own yet to have a boot-time default *for* (that starts at step 3). §5.1's `AI_ALARM_ENABLED_DEFAULT` in `example.config.h` — the device-side boot default — is still open for whichever of steps 3+ first gives the device its own AI state machine to boot into a default for.

---

## 0. Why this document exists

This plan is the output of a design discussion about adding an "AI Alarm" (human-presence detection + auto-recording) feature to the existing espcamsys2 ESP32-CAM security system. The original owner will hand this document to a future implementation session, so it intentionally over-explains context that was established earlier and would otherwise be lost.

---

## 1. Existing system architecture (as of this writing)

Confirmed from `INSTALL.md` in the repo. **Read this before touching any code.**

```
[ESP32-CAM] --push JPEG (HTTP POST /upload)--> [server.js relay :8080] <--fetch-- [PHP dashboard] <--Tor--> [user, anywhere]
```

- **ESP32-CAM devices** (AI-Thinker board, classic ESP32 — *not* S3) run `Arduino/sketch_sep12a_camera2_behind_NAT/sketch_sep12a_camera2_behind_NAT.ino`. They are **push-only clients** — they do **not** run their own web/streaming server. ~~They periodically capture a JPEG and `POST` it to the relay's `/upload` endpoint~~ **[Corrected — see the implementation note at the top of this document]** they hold one persistent raw-TCP connection to the relay's push port and continuously write length-prefixed JPEG frames down it (`/upload` is a legacy, firmware-unused HTTP endpoint), authenticated with a per-camera `API_KEY` (must match `camKey` in the relay's `config.js`). Each device has a unique `CAMERA_ID` set in its own `config.h`.
  - ~~**This means there is currently no inbound channel to the camera.**~~ **[Corrected]** the persistent push connection is bidirectional: the relay already writes a control byte back down it (dashboard pause/resume), so an inbound channel already existed before this feature — see §5.6, updated in place, and the implementation note at the top of this document.
- **`server.js` relay** (Node/Express, runs on a Raspberry Pi) receives pushed frames and re-serves them as live MJPEG. Known endpoints: `/upload` (key-protected, camera → relay), `/stream`, `/snapshot`, `/status`. Per the INSTALL guide, `/stream`/`/snapshot`/`/status` currently have **no auth** and are only safe because the Pi firewall restricts port 8080 to localhost/LAN — the PHP layer is the only public-facing auth boundary. **Any new relay endpoint must follow this same trust model** (LAN/localhost-only, or explicitly authenticated if it needs to be reachable more broadly).
- **PHP dashboard** (`index.php`, `stream.php`, `cameras.php`, `auth.php`, `config.php`) runs on the Pi, exposed only via a **Tor hidden service** (onion address), protected by **HTTP Basic Auth** (`auth_user`/`auth_pass` in `config.php`). It proxies each camera's stream from the relay and lists cameras from a config array (`id`, `name`, `icon` per camera).
- **Recording/footage storage is already implemented** in the existing codebase — clip storage, replay, and download already work. **Do not rebuild this.** The AI alarm feature only needs to *trigger* a recording using whatever mechanism already exists for manual/button-triggered recording; it should reuse that pipeline, not create a parallel one.
- Config files (`config.h`, `config.js`, `config.php`) are gitignored; only `example.*` templates are tracked. Any new config keys added by this feature should follow the same pattern (add to `example.config.h`/`.js`/`.php` with placeholder/default values, document in `INSTALL.md`).

---

## 2. Hardware constraints (established earlier in the design conversation)

- Target device: **classic ESP32-CAM (AI-Thinker), OV2640 sensor, no ESP32-S3.** Do not assume S3-specific acceleration (ESP-NN vector instructions) is available.
- The classic ESP32 **is dual-core** (Xtensa LX6, Core 0 and Core 1):
  - Core 0 hosts the WiFi/BT protocol stack's internal system tasks by default.
  - Core 1 runs the Arduino `setup()`/`loop()` by default.
  - Additional tasks can be pinned to either core explicitly via `xTaskCreatePinnedToCore()`. **Plan:** run TFLite inference as its own task pinned to the core opposite the main streaming/upload loop, so inference bursts don't stall the upload/stream path. This was confirmed as standard, well-supported ESP32 practice — not experimental.
- **Camera driver limitation:** the ESP32 camera driver (`esp_camera_fb_get()`) returns one frame in whatever pixel format/resolution the sensor is *currently* configured for. You cannot pull two different resolutions/formats from one call. Switching resolution (`sensor->set_framesize()`) has real latency (~100ms+ per switch) because it reconfigures the sensor. **Implication for this feature:** do not toggle resolution on every frame/inference cycle. Treat resolution as a property of the *state* (monitoring vs recording), switch it only on state transitions, and prefer software-downscaling a captured frame over reconfiguring the sensor where possible (e.g., for the rolling pre-buffer, see §5.3).
- No additional physical sensors (radar/mmWave, PIR, etc.) will be used for this feature. **This was explicitly decided** — AI-only detection. (Earlier in the design process, mmWave radar sensors — CDM324, HLK-LD2410C, HLK-LD2450 — were researched as an alternative/complementary approach to human-vs-pet discrimination, and radar+camera fusion was proposed as an option, but the owner decided the extra hardware cost isn't justified now that the pure AI-vision approach covers the need. **Do not add sensor fusion unless explicitly requested again later** — it was a considered and rejected option, not an oversight.)

---

## 3. The AI model (TensorFlow Lite Micro person detection)

This is the core enabling piece. Key facts gathered during design:

- **Model:** Google's reference "person detection" model from the TensorFlow Lite for Microcontrollers examples repo. MobileNet-based, trained on the Visual Wake Words dataset.
- **Input:** 96×96 pixel, greyscale, INT8 quantized.
- **Output:** two scores — person / no-person.
- **Model size:** ~250–300KB (INT8 quantized) — fits comfortably in PSRAM on the AI-Thinker board (typically 4MB PSRAM).
- **Inference time on classic ESP32:** ~200–400ms per frame at 240MHz CPU clock. This supports roughly **2.5–5 inferences/second** as a ceiling; the design targets **2–3/sec** for normal monitoring, which fits comfortably within that budget.
- **Accuracy:** roughly ~89% on the model's own test set in typical real-world reports — **not perfect**. This is *why* the confidence-debounce/confirmation-burst logic in §5.5 exists — a single positive inference is not trusted on its own.
- **Libraries considered:** TensorFlow Lite Micro via Espressif's `tflite-micro-esp-examples` / `esp-nn`, or Arduino-friendly wrappers. **Not yet finalized — pick and pin a specific library/version during implementation and record the choice back into this doc or the repo README.**
- CPU frequency should be set to 240MHz (max) for best inference speed — confirm this is set in the sketch's board config.

---

## 4. Decisions made (Q&A recap — treat these as settled, not open questions)

| # | Topic | Decision |
|---|---|---|
| 1 | Command channel | **Piggyback** commands on an already-open device-initiated connection — no new inbound port, no polling endpoint. *(Originally specified as the response body of `/upload`; implemented in step 1 on the persistent push socket instead, since that turned out to be the connection actually in use — see the implementation note at the top of this document and §5.6.)* |
| 2 | Cooldown / re-trigger | If a new detection triggers **within 3 seconds** (configurable) of the previous recording ending, **continue the same recording** rather than starting a new clip. UI shows a **"debounce"** label (not "recording") during this grace window, since it's ambiguous whether recording will resume or truly stop. |
| 3 | Recording start latency | Maintain a **rolling pre-buffer** of the last **3 seconds** (configurable) of monitoring-mode frames in RAM; prepend these to the recording when a trigger fires, so the clip doesn't miss the moment right before the resolution switch completes. |
| 4 | Extra sensors (radar/PIR) | **Not used.** AI-only detection, by deliberate choice to avoid extra hardware cost. Do not add radar wake-triggering unless asked again. |
| 5 | False-positive filtering | On an initial high-probability detection, immediately capture and run inference on **2–3 extra frames** (configurable) in quick succession as a confirmation burst, before committing to a full recording. |
| 6 | Recording storage | **Already solved** in the existing codebase (replay/download already work). This feature only needs to *trigger* recording via the existing mechanism — do not build new storage/playback. |
| 7 | Authentication | New endpoints/toggles **must** be authenticated, reusing the existing mechanisms (per-camera `API_KEY` on the device side, `auth.php`/Basic Auth on the dashboard side). No new unauthenticated routes. |
| 8 | Live view while AI is on | Instead of a hard AI-on/AI-off tradeoff for viewing, add a **"Live Peek"** override: a **numeric seconds input** (matching the UI pattern already used elsewhere in the dashboard) that temporarily shows the high-res live stream for N seconds, then automatically reverts to AI monitoring mode. Avoids the risk of a user forgetting to re-enable protection. |

---

## 5. Feature design

### 5.1 New config keys (add to `example.config.h`, mirror in device `config.h`)

```cpp
// --- AI Alarm feature ---
#define AI_ALARM_ENABLED_DEFAULT   true    // initial state at boot; can be overridden at runtime via piggyback command
#define AI_INFERENCE_INTERVAL_MS   350     // ~2-3 inferences/sec during normal monitoring
#define AI_CONFIDENCE_THRESHOLD    0.6     // tune during field testing
#define AI_CONFIRM_EXTRA_FRAMES    2       // number of extra confirmation frames after initial hit (2-3 range)
#define AI_CONFIRM_INTERVAL_MS     150     // spacing between confirmation-burst frames (faster than normal interval)

// --- Recording behavior ---
#define RECORD_RESOLUTION          FRAMESIZE_SVGA   // or whatever the existing recording path already uses — check existing code
#define RECORD_MERGE_WINDOW_MS     3000    // gap under which a new trigger continues the previous recording instead of starting a new one

// --- Rolling pre-buffer ---
#define ROLLING_BUFFER_SECONDS     3       // seconds of monitoring-mode frames retained in RAM for pre-roll
```

Also mirror the relevant *runtime-overridable* ones (alarm enabled/disabled, live-peek duration) in the relay's per-camera command state — see §5.6. `config.h` values are just the boot-time defaults.

### 5.2 State machine

```
MONITORING  --(AI hit, confidence >= threshold)-->  CONFIRMING
CONFIRMING  --(N/N extra frames also positive)-->   RECORDING
CONFIRMING  --(confirmation fails)-->               MONITORING
RECORDING   --(target no longer detected)-->        DEBOUNCE
DEBOUNCE    --(new trigger within MERGE_WINDOW)-->   RECORDING (same clip, continued)
DEBOUNCE    --(MERGE_WINDOW elapses with no trigger)--> MONITORING
(any state) --(user requests Live Peek)-->          LIVE_PEEK
LIVE_PEEK   --(timer expires)-->                    MONITORING (or whatever state it was in before, simplest to just return to MONITORING)
```

Notes:
- `DEBOUNCE` is a distinct UI-visible state, not just internal bookkeeping — the dashboard should display it as its own label per decision #2, not silently as "recording" or "idle."
- `LIVE_PEEK` should be treated as pausing AI logic, not disabling it entirely — a trigger that would fire during a peek should probably queue/resume normal behavior once the peek ends, though this is a minor edge case to decide during implementation (recommend: don't detect during peek at all, simplest and lowest-risk).

### 5.3 Rolling pre-buffer

- Keep a small circular buffer of the last `ROLLING_BUFFER_SECONDS` worth of **monitoring-resolution (96×96 grayscale)** frames in RAM — these are cheap (single-digit KB each), so buffering several seconds' worth is trivial even without touching PSRAM aggressively.
- Rough sizing check: at ~3 fps monitoring rate, 3 seconds ≈ 9 frames × (96×96×1 byte) ≈ ~83KB total — negligible.
- On trigger → `RECORDING`, prepend these buffered low-res frames to the start of the clip (tagged/handled however the existing recording pipeline expects — check its format before assuming raw frame concatenation works as-is).
- Do **not** try to buffer high-res frames pre-trigger — that defeats the purpose of the cheap monitoring mode. The pre-roll is intentionally low-res; that's an accepted tradeoff, not a bug.

### 5.4 Confirmation burst (false-positive filtering)

- On the *first* inference that crosses `AI_CONFIDENCE_THRESHOLD`, do not immediately escalate.
- Immediately capture and run `AI_CONFIRM_EXTRA_FRAMES` additional inferences at the faster `AI_CONFIRM_INTERVAL_MS` cadence (not waiting for the normal monitoring interval).
- Require some agreement threshold across the burst (simplest: all extra frames must also be positive; alternative: majority) before transitioning to `RECORDING`. Pick the simpler "all positive" rule first; loosen only if field testing shows too many missed real detections.

### 5.5 Recording continuation / merge logic

- Track `lastRecordingEndTimestamp`.
- When a new trigger condition occurs, check `now - lastRecordingEndTimestamp < RECORD_MERGE_WINDOW_MS`:
  - If true → resume/continue the *same* clip (however "continue a clip" is expressed in the existing recording pipeline — check its API/format).
  - If false → start a genuinely new clip.
- While in this grace window (after apparent detection loss, before the window expires or a new trigger arrives), the device/dashboard state should be `DEBOUNCE`, and the UI must show a **"debounce"** label distinctly from "recording" — this was an explicit UX decision, not just an implementation detail.

### 5.6 Command channel (piggyback design) — **[DONE] plumbing implemented in step 1, updated below to match**

> This section originally described piggybacking on `POST /upload`'s HTTP response. That transport turned out not to match reality (see the implementation note at the top of this document) — `/upload` is a legacy endpoint the firmware doesn't actually call. The design below is what step 1 actually implements, on the persistent raw-TCP push connection instead. The JSON payload shape and semantics are otherwise unchanged from the original design.

- **Device → relay (existing):** the sketch holds one persistent TCP connection to the relay's push port (`PUSH_PORT`/`pushPort`), authenticates once with `"<CAMERA_ID>\t<API_KEY>\n"`, then continuously writes `[4-byte length][JPEG]` frames down it. No response is read for these — fire-and-forget, so frame pushing never waits on a round trip.
- **Relay → device (new in step 1):** that same socket already carried a single raw control byte from relay to device (0x00 = pause / 0x01 = resume, for the dashboard's existing per-camera power toggle). Step 1 adds a second, tagged message type on the same socket/direction so it can't be confused with that control byte:
  ```
  [0x02][2-byte big-endian JSON length][JSON bytes]
  ```
  with the JSON payload shape unchanged from the original design:
  ```json
  { "ai_enabled": true, "live_peek_until_epoch": 0 }
  ```
  - `ai_enabled`: whether AI monitoring should be active on this camera right now.
  - `live_peek_until_epoch`: 0 if no active peek, otherwise a unix timestamp the device compares against its own clock to know when to auto-revert. **Still an open item** — see §8, which already flagged this as the field most likely to change (to a relative "seconds remaining" value) once NTP/clock-sync is confirmed one way or the other; step 1 hardcodes `0` and does not resolve this.
  - See `encodeCommandFrame()` / `COMMAND_FRAME_TAG` / `MAX_COMMAND_FRAME_LEN` in `nodejs/camera-relay/lib/protocol.js`, and the matching `AiAlarmCommand` / `parseAiAlarmCommand()` / `drainDownstream()` in `Arduino/.../logic.h`, for the implementation.
- **Device behavior (step 1, unchanged by step 2):** the command frame is decoded via a small purpose-built extractor (`extractJsonBoolField`/`extractJsonIntField` in `logic.h`), not a general JSON parser — kept dependency-free like the rest of the sketch's hand-rolled wire protocols (no ArduinoJson or similar added). It's sent once right after the device authenticates (mirroring how the existing control byte is (re)sent on connect), and now also every time `cam.aiCommand` actually changes (see below) — but the device itself still does nothing beyond `Serial.printf`-logging what it received; **no device-side behavior changes yet**, that starts at step 3.
- **Relay-side (step 2):** `cam.aiCommand` on the per-camera object (`getCamera()` in `server.js`) is now genuinely mutable — `POST /ai-alarm/:id?enabled=1|0` (see §5.7/§5.8 below) sets its `ai_enabled` field and immediately calls `sendAiAlarmCommand()` again, the same "on connect + on every state change" pattern `sendControlByte()`/`/control/:id` already used for the power toggle. A fresh camera (or a relay that just restarted) starts from `AI_ALARM_ENABLED_DEFAULT`'s relay-side counterpart, `aiAlarmEnabledDefault` in `config.js` (defaults to `true` if omitted — see `example.config.js`). The **per-camera command state store / restart persistence** flagged in the step 1 note is still not built — a relay restart still silently resets every camera back to `aiAlarmEnabledDefault`, same open item as before, just now actually reachable by restarting mid-use instead of only in theory.

### 5.7 New backend endpoints (PHP dashboard side, must go through existing `auth.php`/Basic Auth mechanism) — **[DONE] the ON/OFF half implemented in step 2**

- ~~`POST /api/camera/{id}/ai-alarm` — body `{ "enabled": true|false }`.~~ **Implemented in step 2 as `php/cameras/ai-alarm.php`**, following the existing `control.php` pattern (query params, not a JSON body, to match every other endpoint in this codebase — see the note below) rather than the `/api/camera/{id}/ai-alarm` path/body shape originally sketched here: `GET ai-alarm.php?cam=ID` / `POST ai-alarm.php?cam=ID&enabled=1|0`, proxying the relay's `GET`/`POST /ai-alarm/:id`. Behind the same `auth.php` Basic Auth gate as every other dashboard endpoint (`require_once` at the top, same as `control.php`).
- `POST /api/camera/{id}/live-peek` — body `{ "seconds": <int> }`. Sets `live_peek_until_epoch = now + seconds` in the command state. **Reuse the existing numeric-input UI component** already used elsewhere in the dashboard for this, per decision #8 — don't invent a new input pattern. **Not yet implemented** — this is step 7 (Live Peek); step 2 only touches `ai_enabled`, `live_peek_until_epoch` is passed through unchanged (always `0` so far, since nothing sets it yet).
- Extend the existing `/status`-equivalent so the dashboard can show current per-camera state (`MONITORING` / `CONFIRMING` / `RECORDING` / `DEBOUNCE` / `LIVE_PEEK`) — check if `/status` already returns enough to extend, or if a new field needs adding to the relay's status response. **Partially done in step 2:** `/status` (relay's `statusView.js`) now includes `aiEnabled`/`livePeekUntilEpoch` per camera, mirroring `cam.aiCommand` — enough for the ON/OFF toggle's own state, but the full `MONITORING`/`CONFIRMING`/etc. state machine from §5.2 doesn't exist yet (that's step 3+), so there's no combined state label to expose yet beyond the raw booleans.

> Note on endpoint shape: this codebase's existing endpoints (`control.php`/`record.php`/`recordings.php`) all use `GET`/`POST` with query-string params and a `?cam=ID` camera selector, not the `/api/camera/{id}/...` REST path + JSON body shape this section originally sketched. Step 2 followed the codebase's actual convention instead, for consistency with every other endpoint — same reasoning as the step 1 note about following what the codebase actually does over what an earlier design assumed.

### 5.8 Relay (`server.js`) additions — **[DONE] the ON/OFF half implemented in step 2**

- ~~Per-camera command state (in-memory + optionally file-persisted, see §5.6).~~ **In-memory part done** since step 1 (`cam.aiCommand`); step 2 is what first makes it mutable. File-persistence across relay restarts is still **not done** — same open item as noted in §5.6's step 2 note.
- ~~Modify the `/upload` handler to embed the current command JSON in its HTTP response to the device.~~ **Superseded by the step 1 transport correction** — there's no `/upload` round trip to embed anything in; the command rides the persistent push socket instead (§5.6).
- New endpoint(s) for the PHP layer to read/write that state — **[DONE]** `GET`/`POST /ai-alarm/:id` in `server.js`, immediately next to the existing `/control/:id` handlers and following the exact same shape/trust model (no key; relies on the relay only being reachable from localhost/LAN per INSTALL.md — same trust boundary as `/control`, `/status`, etc., as required here).

### 5.9 UI additions (PHP dashboard)

- ~~Per-camera **AI Alarm ON/OFF** toggle.~~ **[DONE] in step 2** — a `🤖 AI ON`/`🤖 AI OFF` `cam-btn` next to the existing `⏻ ON`/`⏻ OFF` power toggle in `index.php`, wired to `ai-alarm.php` (`toggleAiAlarm()`/`setAiAlarm()` in the page's inline `<script>`) and kept in sync by the existing `pollAllStatuses()` polling loop, the same mechanism that already keeps the power/recording buttons in sync across tabs/users. Unlike the power toggle, there's no auto-off timer/countdown pill for this button — AI-alarm has no duration concept in this plan; a numeric-seconds input is Live Peek's job (step 7), not this toggle's.
- Per-camera **Live Peek** numeric seconds input + submit, styled consistently with existing numeric inputs elsewhere in the dashboard. **Not yet implemented** — step 7.
- Status label per camera reflecting the full state list from §5.2, with `DEBOUNCE` shown distinctly as agreed. **Not yet implemented** — depends on the state machine from step 3+ existing first; nothing to label yet beyond the raw ON/OFF toggle from step 2.

---

## 6. Firmware implementation sketch (ESP32 side)

### 6.1 Task/core layout

- **Core 1** (default Arduino loop): existing upload/streaming logic, largely unchanged — still periodically captures a frame and POSTs it, now also parsing the piggybacked command JSON from the response.
- **Core 0** (new dedicated task via `xTaskCreatePinnedToCore`): runs the state machine tick — grabs the latest frame (or a downscaled copy), runs TFLite inference when in `MONITORING`/`CONFIRMING`, manages the rolling buffer, and signals the main loop when a state transition (e.g., start/stop recording, resolution switch) needs to happen.
- Use a mutex or a small queue to hand frame data safely between the capture/upload logic and the inference task — avoid two tasks touching the camera driver concurrently without synchronization.

### 6.2 Pseudocode outline

```cpp
// Shared state (protected by mutex)
enum Mode { MONITORING, CONFIRMING, RECORDING, DEBOUNCE, LIVE_PEEK };
volatile Mode currentMode = MONITORING;
volatile bool aiEnabled = AI_ALARM_ENABLED_DEFAULT;
RingBuffer rollingBuffer(ROLLING_BUFFER_SECONDS * expectedFps);

// Core 0 task: AI inference + state machine
void aiTask(void *param) {
  for (;;) {
    if (!aiEnabled || currentMode == LIVE_PEEK || currentMode == RECORDING) {
      vTaskDelay(pdMS_TO_TICKS(AI_INFERENCE_INTERVAL_MS));
      continue;
    }
    // capture + downscale to 96x96 grayscale (see §2 — avoid sensor reconfig if possible)
    uint8_t* frame = captureMonitoringFrame();
    rollingBuffer.push(frame);

    float score = runInference(frame);
    if (currentMode == MONITORING && score >= AI_CONFIDENCE_THRESHOLD) {
      currentMode = CONFIRMING;
      bool confirmed = runConfirmationBurst(AI_CONFIRM_EXTRA_FRAMES, AI_CONFIRM_INTERVAL_MS);
      if (confirmed) {
        startRecording(rollingBuffer.snapshot()); // prepend pre-roll
        currentMode = RECORDING;
      } else {
        currentMode = MONITORING;
      }
    }
    vTaskDelay(pdMS_TO_TICKS(AI_INFERENCE_INTERVAL_MS));
  }
}

// Called from wherever "recording ended" is currently detected
void onRecordingTargetLost() {
  lastRecordingEndTimestamp = millis();
  currentMode = DEBOUNCE;
}

// Called on each new potential trigger while in DEBOUNCE
void onPossibleRetrigger() {
  if (millis() - lastRecordingEndTimestamp < RECORD_MERGE_WINDOW_MS) {
    continueExistingRecording();
    currentMode = RECORDING;
  } else {
    currentMode = MONITORING;
  }
}
```

This is illustrative, not final — adapt to whatever recording-trigger hooks already exist in the current sketch (manual button / existing sensor-trigger path, if any, mentioned by the user as already present).

---

## 7. Suggested implementation order (phased rollout)

1. **[DONE] Plumbing only:** implement the piggyback command channel with a hardcoded no-op command, verify round-trip works before any AI code exists. *(Implemented on the persistent push socket rather than `/upload` — see the implementation note at the top of this document and the updated §5.6. Relay: `nodejs/camera-relay/lib/protocol.js` (`encodeCommandFrame`), `nodejs/camera-relay/server.js` (`sendAiAlarmCommand`, `AI_ALARM_COMMAND_NOOP`, `cam.aiCommand`). Firmware: `Arduino/sketch_sep12a_camera2_behind_NAT/logic.h` (`AiAlarmCommand`, `parseAiAlarmCommand`, `drainDownstream`), `.ino`'s `loop()`. Tests: `tests/node/test_protocol.js`, `tests/cpp/test_alarm_logic.cpp`, `tests/e2e/test_ai_alarm_e2e.js` (wired into `run_tests.sh`). No new config keys were needed — the payload is still hardcoded, not wired to any config value; §5.1's config keys are for steps 2+.)*
2. **[DONE] Dashboard toggle (no AI yet):** add the `ai-alarm` endpoint + UI toggle, wire it to the command state, confirm the device receives and logs the change. *(Relay: `nodejs/camera-relay/server.js` (`GET`/`POST /ai-alarm/:id`, `AI_ALARM_ENABLED_DEFAULT`), `nodejs/camera-relay/lib/statusView.js` (`aiEnabled`/`livePeekUntilEpoch` added to `buildCameraStatusView()`). Dashboard: `php/cameras/ai-alarm.php` (new, mirrors `control.php`), `php/cameras/index.php` (🤖 AI ON/OFF button + `toggleAiAlarm()`/`setAiAlarm()`, wired into the existing `pollAllStatuses()`). Config: `nodejs/camera-relay/example.config.js` gained `aiAlarmEnabledDefault` (optional, defaults to `true`) — see the step 2 implementation note at the top of this document for why this ended up relay-side rather than the device-side `AI_ALARM_ENABLED_DEFAULT` §5.1 sketches. No firmware changes were needed — the device already parses and logs any command frame since step 1; toggling just makes the relay actually send a *changed* one. Tests: `tests/node/test_statusView.js` (extended), `tests/e2e/test_ai_alarm_e2e.js` (extended to toggle via HTTP and confirm the device-facing socket sees the update). No existing test's *behavior* changed, only `buildCameraStatusView()`'s test fixtures gained an `aiCommand` field to match its now-required shape — see that file's own note on the fallback that keeps this non-breaking for any other caller.)*
3. **Monitoring-only AI:** implement 96×96 grayscale capture + TFLite inference at `AI_INFERENCE_INTERVAL_MS`, log detections to Serial only — no recording trigger yet. Validate inference timing/accuracy in isolation.
4. **Confirmation burst:** add the extra-frame debounce logic (§5.4), still logging only.
5. **Recording trigger + rolling buffer:** wire confirmed detections into the existing recording pipeline, prepend the rolling pre-buffer (§5.3).
6. **Merge/continuation + debounce UI label:** implement §5.5, verify the dashboard shows `DEBOUNCE` correctly and clips merge as expected.
7. **Live Peek:** implement §5.7/§5.9 numeric-input override.
8. **Field tuning pass:** adjust `AI_CONFIDENCE_THRESHOLD`, `AI_INFERENCE_INTERVAL_MS`, `RECORD_MERGE_WINDOW_MS`, `AI_CONFIRM_EXTRA_FRAMES` based on real-world false-positive/false-negative observations.

---

## 8. Open items to resolve during implementation (not yet decided)

- Exact TFLite Micro library/version to depend on (Arduino Library Manager availability, or vendoring Espressif's `tflite-micro-esp-examples`) — needs to be picked and the choice recorded.
- Exact format/API the existing recording pipeline expects for (a) starting a clip, (b) continuing/extending an existing clip, (c) accepting prepended pre-roll frames of a different resolution than the rest of the clip. **Read the existing recording code before implementing §5.3/§5.5 — do not assume.**
- Whether the device already has any time-sync (NTP) mechanism — needed for the `live_peek_until_epoch` comparison in §5.6; if not present, either add it or switch that field to a relative "seconds remaining" value refreshed each upload cycle instead of an absolute epoch (simpler, avoids clock-sync dependency — **probably the better choice**, reconsider before implementing).
- Whether `/status` (or equivalent) already has a place to add per-camera AI state, or needs a new field/endpoint.
- Confirm actual PSRAM size on the specific AI-Thinker boards in use (assumed 4MB — verify).

---

## 9. Background references (from the research phase of this design)

For context on *why* AI-vision was chosen over dedicated presence-sensor hardware (not needed to implement this feature, but explains the reasoning if questioned later):

- CDM324 — cheap 24GHz Doppler module, analog output only, no human/animal/object discrimination at all (triggers on any sufficiently large motion, including wind-blown foliage).
- HLK-LD2410C — 24GHz FMCW UART presence sensor, better filtering via a human-motion-signature algorithm, but still reports real-world false positives from pets at close range. Arduino library: `ncmreynolds/ld2410`.
- HLK-LD2450 — multi-target tracking radar with position/angle output; can exclude low-height targets (pets) via tilt-angle configuration, better than LD2410C for this but still heuristic, not true classification.
- TFLite Micro person-detection (this plan's approach) — genuinely does visual classification rather than motion heuristics, which is why it was preferred once discovered, despite needing more implementation work than a plug-and-play radar library.
- Radar+camera sensor fusion (radar as wake trigger, camera as confirmation) was proposed as a lower-power, lower-false-positive hybrid design but **explicitly rejected for now** to avoid extra hardware cost (decision #4 in §4). Worth revisiting only if pure-AI false-positive rates prove unacceptable in the field.
