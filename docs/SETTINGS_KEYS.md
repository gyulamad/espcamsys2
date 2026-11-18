# Short stored keys (F-29 / T1)

A setting is kept in the board's flash (ESP32 NVS) under a **stored key**. NVS refuses names longer than 15
characters (`NVS_KEY_MAX_LENGTH` in `settings_logic.h`). The dashboard and the setup form show the readable
**label** beside the key, so the key only has to be short, stable and recognisable.

The table at the bottom is generated from `docs/settings_keys.tsv`
(`tools/gen_settings_keys_doc.sh`). `tests/cpp/test_settings_keys_recorder.cpp` and
`tests/cpp/test_settings_keys_person.cpp` enforce the rules below; `run_tests.sh` runs them.

## Rules

1. **Characters.** `A-Z`, `0-9`, `_`; starts with a letter; no `__`; does not end in `_`; **at most 15
   characters**. No two settings of one sketch share a stored key, and no two share an old name.
2. **Stored keys are frozen.** The 44 keys marked `stored` in the table are already in the flash of deployed
   boards (the 25 keys of the recorder before F-29 and the 25 of the detector, 6 of them in both). They are never
   renamed, so no board needs a migration. This scheme applies to every **new** key. (A key that left the schema
   fails the test.)
3. **Shape: `GROUP_WHAT[_UNIT]`**, upper case, same style as the keys that exist today.
4. **One stable prefix per group.** A new key uses its group's prefix; a new group gets a new prefix and a row
   here:

   | Prefix | Group | Examples |
   | --- | --- | --- |
   | `OTA_` | firmware update | `OTA_CHECK_S` |
   | `RF_` | relay discovery (relay find) | `RF_PORT` |
   | `SYNC_` | settings sync with the relay | `SYNC_CHECK_S` |
   | `SETUP_` | setup mode (setup Wi-Fi and form) | `SETUP_MAX_CONN` |
   | `BOOT_` | waits and limits while starting | `BOOT_WIFI_MS` |
   | `PIN_` | camera pin map | `PIN_XCLK` |
   | `STK_` | task stack sizes | `STK_LOG_B` |
   | `SER_` | serial port | `SER_BAUD` |
   | `CAM_` | camera sensor and driver | `CAM_VFLIP` |
   | `VIEW_` | live-view polling (detector) | `VIEW_LIVE_MS` |
   | `LOG_`, `PUSH_`, `ALARM_`, `STREAM_`, `ANN_`, `MOTION_`, `JPEG_Q_`, `SIZE_`, `WIFI_`, `HTTP_`, `RELAY_` | already in use | |

5. **Unit suffix** for a time, size or frequency: `_MS` (milliseconds), `_S` (seconds), `_B` (bytes), `_HZ`.
   Counts and on/off switches have none. (`_SEC` exists only in the frozen `LOG_*` keys; do not add new ones.)
6. **Shortening**, in this order, stopping as soon as the key is 15 characters or less:
   1. Say the group once: `SETTINGS_SYNC_CHECK_SECONDS` → `SYNC_CHECK_S`, `REMOTE_LOG_*` → `LOG_*`,
      `RELAY_FIND_*` → `RF_*`, `*_GPIO_NUM` → `PIN_*`.
   2. Drop words the unit already says (`INTERVAL`, `PERIOD`, `WINDOW`).
   3. Use the standard abbreviations: `TIMEOUT` `TMO`, `WRITE` `WR`, `FIRMWARE` `FW`, `VERSION` `VER`,
      `DOWNLOAD` `DL`, `REQUEST` `RQ`, `CHANNEL` `CHAN`, `STATIONS` `STA`, `CONNECTIONS` `CONN`,
      `QUALITY` `Q`, `THRESHOLD` `THRESH`, `HYSTERESIS` `HYST`, `MULTIPLIER` `MUL`, `MAXIMUM` `MAX`,
      `MINIMUM` `MIN`.
   4. Last resort: drop the vowels of the longest word, keeping its first letter. Never shorten the prefix or the
      unit suffix.
7. **One key, one meaning.** A key that appears in both sketches (`CAM_VFLIP`, `LOG_*`, `HTTP_TMO_MS`, ...) has
   the same label in both. Its default may differ per sketch (`RELAY_DOWN_MS` is 30000 on the recorder and
   90000 on the detector).
8. **Adding a key.** Add its row to `docs/settings_keys.tsv` (origin `new`, the old hard-coded name, the stored
   key, the label, the task), put the old value in the `KeyMeta` table as its default, run
   `tools/gen_settings_keys_doc.sh` and `tools/gen_device_schema.sh`, and run `./run_tests.sh`.

The scheme uses upper case with `_MS`, `_S`, `_B` suffixes (not camel case such as `Ms`), because every stored key
that exists today is written that way.

## Not keys: values that stay compile-time (proposal for T3 / T5c to confirm)

These size static arrays or are protocol or hardware limits, so they have no row. Each task confirms its own list
(decision 4 of the recap): `LOG_MSG_MAX`, `LOG_TRACE_MAX`, `LOG_QUEUE_CAPACITY`, `LOG_BATCH_MAX`,
`LOG_BREADCRUMBS`, `LOG_BREADCRUMB_TEXT`, `LOG_SITE_MAX`, `SETUP_HEAD_MAX`, `SETUP_BODY_MAX` (`MAX_BODY_BYTES`),
`SETUP_READ_CHUNK`, `MAX_FORM_FIELDS`, `MAX_FIELD_NAME`, `MAX_LINE_LENGTH`, `MAX_WIFI_NETWORKS`,
`NVS_KEY_MAX_LENGTH`, `WPA2_PASS_MIN/MAX`, `SSID_MAX`, `TENSOR_ARENA_SIZE`, `FRAME_SIZE`, `IMAGE_*`
(the model's input), `MAX_STATUS_BYTES`, `MAX_JPEG_BYTES` (must match the relay, see T8) and the frame-size ladder.

## The table

`origin`: `stored` = already in deployed flash (frozen), `new` = added by F-29. `sketch`: `rec` recorder,
`det` detector, `both`. `tasks`: where the key is (or was) implemented; `done` = already in the schema. The rows
of the tasks T2, T3 and T5 are the plan from the code as it is today: the developer of that task may rename or add
rows (the tests keep them valid) and must set the final default and tier in the `KeyMeta` table.

<!-- BEGIN GENERATED TABLE (tools/gen_settings_keys_doc.sh) -->

| Old name | Stored key | Label | Sketch | Origin | Tasks |
| --- | --- | --- | --- | --- | --- |
| `WIFI` | `WIFI` | Wi-Fi networks | both | stored |  |
| `SERVER_HOST` | `SERVER_HOST` | Relay address | both | stored |  |
| `PUSH_PORT` | `PUSH_PORT` | Relay push port | rec | stored |  |
| `HTTP_PORT` | `HTTP_PORT` | Relay HTTP port | both | stored |  |
| `CAMERA_ID` | `CAMERA_ID` | Camera ID | rec | stored |  |
| `API_KEY` | `API_KEY` | API key (camKey) | both | stored |  |
| `PUSH_INTERVAL_MUL` | `PUSH_GAP_MUL` | Pause after each frame (x last push) | rec | stored |  |
| `JPEG_Q_DROP` | `JPEG_Q_DROP` | Lower quality on a slow link | rec | stored |  |
| `JPEG_Q_MIN` | `JPEG_Q_MIN` | Best JPEG quality | rec | stored |  |
| `JPEG_Q_MAX` | `JPEG_Q_MAX` | Coarsest JPEG quality | rec | stored |  |
| `SIZE_DROP` | `SIZE_DROP` | Also shrink the frame size | rec | stored |  |
| `PUSH_WRITE_TIMEOUT_MS` | `PUSH_WR_TMO_MS` | Push write timeout (ms) | rec | new | done |
| `PUSH_SLOW_WARN_MS` | `PUSH_SLOW_MS` | Slow push (ms) | rec | new | done |
| `PUSH_FAST_MS` | `PUSH_FAST_MS` | Fast push (ms) | rec | new | done |
| `PUSH_MAX_GAP_MS` | `PUSH_MAX_GAP_MS` | Longest pause after a push (ms) | rec | new | done |
| `JPEG_QUALITY_DEGRADE_STEP` | `Q_DEGRADE_STEP` | Quality steps coarser per slow frame | rec | new | done |
| `JPEG_QUALITY_RECOVER_STEP` | `Q_RECOVER_STEP` | Quality steps finer per fast run | rec | new | done |
| `JPEG_QUALITY_FAST_STREAK` | `Q_FAST_STREAK` | Fast frames before the picture improves | rec | new | done |
| `JPEG_QUALITY_VERY_SLOW_FACTOR` | `Q_VSLOW_FACTOR` | Very slow = this many times slow | rec | new | done |
| `FRAME_SIZE_UP_FAST_STREAK` | `SIZE_UP_STREAK` | Fast pushes before the size goes up | rec | new | done |
| `WIFI_REPORT_INTERVAL_MS` | `WIFI_REPORT_MS` | Wi-Fi report interval (ms) | rec | new | done |
| `http.setTimeout(5000)` | `HTTP_TMO_MS` | HTTP call timeout (ms) | rec | new | done |
| `RELAY_DOWN_MS` | `RELAY_DOWN_MS` | Relay considered gone after (ms) | rec | new | done |
| `set_vflip(sensor, 0)` | `CAM_VFLIP` | Flip the picture upside down | rec | new | done |
| `set_hmirror(sensor, 0)` | `CAM_HMIRROR` | Mirror the picture | rec | new | done |
| `WiFi.setSleep(false)` | `WIFI_SLEEP` | Let the Wi-Fi modem sleep | rec | new | done |
| `ALARM_GPIO_PIN` | `ALARM_GPIO_PIN` | Alarm input pin | rec | stored |  |
| `ALARM_ACTIVE_STATE` | `ALARM_ACTIVE` | Pin level that means alarm | rec | stored |  |
| `ALARM_RECORD_ALL_CAMERAS` | `ALARM_ALL_CAMS` | Alarm records on every camera | rec | stored |  |
| `ALARM_DEBOUNCE_MS` | `ALARM_DEBOUNCE` | Alarm contact debounce (ms) | rec | new | done |
| `ALARM_HOLD_REFRESH_MS` | `ALARM_HOLD_MS` | Alarm repeat while active (ms) | rec | new | done |
| `REMOTE_LOG_ENABLED` | `LOG_ENABLED` | Send the log to the relay | rec | stored |  |
| `REMOTE_LOG_MIN_LEVEL` | `LOG_MIN_LEVEL` | Lowest level sent to the relay | rec | stored |  |
| `REMOTE_LOG_ECHO_TO_SERIAL` | `LOG_ECHO` | Show everything on serial | rec | stored |  |
| `REMOTE_LOG_RETRY_MAX` | `LOG_RETRY_MAX` | Retries after a failed delivery | rec | stored |  |
| `REMOTE_LOG_RETRY_PERIOD_SECONDS` | `LOG_RETRY_SEC` | Seconds between retries | rec | stored |  |
| `REMOTE_LOG_FLUSH_SECONDS` | `LOG_FLUSH_SEC` | Seconds routine entries wait | rec | stored |  |
| `REMOTE_LOG_REPEAT_WINDOW_SECONDS` | `LOG_REPEAT_SEC` | Window for counting repeats | rec | stored |  |
| `REMOTE_LOG_HEARTBEAT_SECONDS` | `LOG_HEARTBEAT` | Seconds between status lines | rec | stored |  |
| `REMOTE_LOG_LOW_HEAP_BYTES` | `LOG_LOW_HEAP` | Warn below this free heap (bytes) | rec | stored |  |
| `SETUP_MODE` | `SETUP_MODE` | Setup mode at next restart | both | stored |  |
| `SETUP_PASSWORD` | `SETUP_PASSWORD` | Setup Wi-Fi password | both | stored |  |
| `PERSON_GPIO` | `PERSON_GPIO` | Person output pin | det | stored |  |
| `DETECT_THRESH` | `DETECT_THRESH` | Person detected above (score) | det | stored |  |
| `CLEAR_THRESH` | `CLEAR_THRESH` | Person cleared below (score) | det | stored |  |
| `LOOP_DELAY_MS` | `LOOP_DELAY_MS` | Pause between detections (ms) | det | stored |  |
| `DARK_THRESH` | `DARK_THRESH` | Darkness threshold | det | stored |  |
| `MOTION_THRESH` | `MOTION_THRESH` | Motion threshold | det | stored |  |
| `MOTION_HOLD_S` | `MOTION_HOLD_S` | Detection hold after motion (s) | det | stored |  |
| `MOTION_X0` | `MOTION_X0` | Motion area left edge | det | stored |  |
| `MOTION_Y0` | `MOTION_Y0` | Motion area top edge | det | stored |  |
| `MOTION_X1` | `MOTION_X1` | Motion area right edge | det | stored |  |
| `MOTION_Y1` | `MOTION_Y1` | Motion area bottom edge | det | stored |  |
| `MOTION_EMA_LEN` | `MOTION_EMA_LEN` | Motion auto-calibration length (frames) | det | stored |  |
| `MOTION_EMA_PCT` | `MOTION_EMA_PCT` | Auto-calibration margin (%) | det | stored |  |
| `DETECTOR_ID` | `DETECTOR_ID` | Detector ID | det | stored |  |
| `STREAM_MAX_FPS` | `STREAM_MAX_FPS` | Live view frames per second (max) | det | stored |  |
| `STREAM_JPEG_Q` | `STREAM_JPEG_Q` | Live view JPEG quality | det | stored |  |
| `STREAM_WR_TMO_S` | `STREAM_WR_TMO_S` | Relay write timeout (s) | det | stored |  |
| `ANN_HEARTBEAT` | `ANN_HEARTBEAT` | Seconds between status lines | det | stored |  |
| `ANN_RETRY` | `ANN_RETRY` | Longest wait before reaching the relay again (s) | det | stored |  |
| `OTA_ENABLED` | `OTA_ENABLED` | Firmware updates from the relay | both | new | T2,T5b |
| `OTA_CHECK_SECONDS` | `OTA_CHECK_S` | Update check interval (s) | both | new | T2,T5b |
| `OTA_RETRY_SECONDS` | `OTA_RETRY_S` | Update retry interval (s) | both | new | T2,T5b |
| `OTA_VERSION_REPLY_MAX_BYTES` | `OTA_VER_MAX_B` | Version reply size limit (bytes) | both | new | T2,T5b |
| `OTA_FIRMWARE_MIN_BYTES` | `OTA_FW_MIN_B` | Smallest firmware accepted (bytes) | both | new | T2,T5b |
| `OTA_FIRMWARE_MAX_BYTES` | `OTA_FW_MAX_B` | Largest firmware accepted (bytes) | both | new | T2,T5b |
| `OTA_VERSION_REPLY_IDLE_MS` | `OTA_VER_IDLE_MS` | Version reply idle timeout (ms) | both | new | T2,T5b |
| `OTA_DOWNLOAD_IDLE_MS` | `OTA_DL_IDLE_MS` | Firmware download idle timeout (ms) | both | new | T2,T5b |
| `RELAY_FIND_ENABLED` | `RF_ENABLED` | Look for the relay on the network | both | new | T2,T5b |
| `RELAY_FIND_PORT` | `RF_PORT` | Relay discovery port | both | new | T2,T5b |
| `RELAY_FIND_FIRST_SECONDS` | `RF_FIRST_S` | First relay search after (s) | both | new | T2,T5b |
| `RELAY_FIND_OK_SECONDS` | `RF_OK_S` | Relay check interval while found (s) | both | new | T2,T5b |
| `RELAY_FIND_RETRY_MIN_SECONDS` | `RF_RETRY_MIN_S` | Shortest wait between searches (s) | both | new | T2,T5b |
| `RELAY_FIND_RETRY_MAX_SECONDS` | `RF_RETRY_MAX_S` | Longest wait between searches (s) | both | new | T2,T5b |
| `SETTINGS_SYNC_ENABLED` | `SYNC_ENABLED` | Fetch settings from the relay | both | new | T2,T5b |
| `SETTINGS_SYNC_FIRST_SECONDS` | `SYNC_FIRST_S` | First settings check after (s) | both | new | T2,T5b |
| `SETTINGS_SYNC_CHECK_SECONDS` | `SYNC_CHECK_S` | Settings check interval (s) | both | new | T2,T5b |
| `SETUP_RETRY_MS` | `SETUP_RETRY_MS` | Setup retry after a failure (ms) | both | new | T2,T5b |
| `SETUP_RESTART_GRACE_MS` | `SETUP_GRACE_MS` | Wait before restart after setup (ms) | both | new | T2,T5b |
| `SETUP_AP_CHANNEL` | `SETUP_AP_CHAN` | Setup Wi-Fi channel | both | new | T2,T5b |
| `SETUP_AP_MAX_STATIONS` | `SETUP_MAX_STA` | Setup Wi-Fi: most devices at once | both | new | T2,T5b |
| `SETUP_HTTP_PORT` | `SETUP_HTTP_PORT` | Setup page port | both | new | T2,T5b |
| `SETUP_DNS_PORT` | `SETUP_DNS_PORT` | Setup DNS port | both | new | T2,T5b |
| `SETUP_MAX_CONNECTIONS` | `SETUP_MAX_CONN` | Setup page: most connections at once | both | new | T2,T5b |
| `SETUP_REQUEST_TIMEOUT_MS` | `SETUP_RQ_TMO_MS` | Setup page request timeout (ms) | both | new | T2,T5b |
| `SETTINGS_WINDOW_MS` | `BOOT_SER_WIN_MS` | Boot wait for a serial "y" (ms) | both | new | T2,T5b |
| `REMOTE_CONNECT_MS` | `BOOT_WIFI_MS` | Boot: time to join Wi-Fi (ms) | both | new | T2,T5b |
| `REMOTE_WINDOW_MS` | `BOOT_RELAY_MS` | Boot: wait for settings from the relay (ms) | both | new | T2,T5b |
| `REMOTE_POLL_MS` | `BOOT_POLL_MS` | Boot: ask the relay every (ms) | both | new | T2,T5b |
| `PWDN_GPIO_NUM` | `PIN_PWDN` | Camera pin: PWDN | both | new | T3,T5c |
| `RESET_GPIO_NUM` | `PIN_RESET` | Camera pin: RESET | both | new | T3,T5c |
| `XCLK_GPIO_NUM` | `PIN_XCLK` | Camera pin: XCLK | both | new | T3,T5c |
| `SIOD_GPIO_NUM` | `PIN_SIOD` | Camera pin: SIOD | both | new | T3,T5c |
| `SIOC_GPIO_NUM` | `PIN_SIOC` | Camera pin: SIOC | both | new | T3,T5c |
| `Y9_GPIO_NUM` | `PIN_Y9` | Camera pin: Y9 | both | new | T3,T5c |
| `Y8_GPIO_NUM` | `PIN_Y8` | Camera pin: Y8 | both | new | T3,T5c |
| `Y7_GPIO_NUM` | `PIN_Y7` | Camera pin: Y7 | both | new | T3,T5c |
| `Y6_GPIO_NUM` | `PIN_Y6` | Camera pin: Y6 | both | new | T3,T5c |
| `Y5_GPIO_NUM` | `PIN_Y5` | Camera pin: Y5 | both | new | T3,T5c |
| `Y4_GPIO_NUM` | `PIN_Y4` | Camera pin: Y4 | both | new | T3,T5c |
| `Y3_GPIO_NUM` | `PIN_Y3` | Camera pin: Y3 | both | new | T3,T5c |
| `Y2_GPIO_NUM` | `PIN_Y2` | Camera pin: Y2 | both | new | T3,T5c |
| `VSYNC_GPIO_NUM` | `PIN_VSYNC` | Camera pin: VSYNC | both | new | T3,T5c |
| `HREF_GPIO_NUM` | `PIN_HREF` | Camera pin: HREF | both | new | T3,T5c |
| `PCLK_GPIO_NUM` | `PIN_PCLK` | Camera pin: PCLK | both | new | T3,T5c |
| `config.xclk_freq_hz` | `CAM_XCLK_HZ` | Camera clock (Hz) | both | new | T3,T5c |
| `remoteLog task stack (8192)` | `STK_LOG_B` | Log task stack (bytes) | both | new | T3,T5c |
| `otaTask stack (10240)` | `STK_OTA_B` | Update task stack (bytes) | rec | new | T3 |
| `networkTask stack (16384)` | `STK_NET_B` | Network task stack (bytes) | det | new | T5c |
| `Serial.begin(115200)` | `SER_BAUD` | Serial speed (baud) | both | new | T3,T5c |
| `Serial.setRxBufferSize(2048)` | `SER_RXBUF_B` | Serial receive buffer (bytes) | both | new | T3,T5c |
| `config.fb_count` | `CAM_FB_COUNT` | Camera frame buffers | det | new | T5c |
| `initCamera ATTEMPTS` | `CAM_INIT_TRIES` | Camera start attempts | det | new | T5c |
| `STARTUP_FAILURE_RESTART_MS` | `BOOT_FAIL_MS` | Restart after a failed start (ms) | det | new | T5c |
| `DARK_HYSTERESIS` | `DARK_HYST` | Darkness hysteresis | det | new | done |
| `SCORE_FRESH_MS` | `SCORE_FRESH_MS` | Detection score stays fresh for (ms) | det | new | done |
| `CLIP_FACTOR` | `MOTION_CLIP` | Motion spike clip factor | det | new | done |
| `UplinkConfig.connectTimeoutMs` | `STREAM_CONN_MS` | Relay connect timeout (ms) | det | new | done |
| `UplinkConfig.answerTimeoutMs` | `STREAM_ANS_MS` | Relay answer timeout (ms) | det | new | done |
| `UplinkConfig.heartbeatMs` | `STREAM_BEAT_MS` | Live view keep-alive (ms) | det | new | done |
| `UplinkConfig.retryFirstMs` | `ANN_FIRST_S` | First wait before reaching the relay again (s) | det | new | done |
| `ViewGate idlePollMs` | `VIEW_IDLE_MS` | Live view poll when idle (ms) | det | new | T5b |
| `ViewGate livePollMs` | `VIEW_LIVE_MS` | Live view poll while watched (ms) | det | new | T5b |
| `ViewGate retryMs` | `VIEW_RETRY_MS` | Live view poll retry (ms) | det | new | T5b |
| `WifiWatch stillDownEveryMs` | `WIFI_DOWN_MS` | Wi-Fi down: report every (ms) | det | new | T5b |
| `RELAY_DOWN_MS` | `RELAY_DOWN_MS` | Relay considered gone after (ms) | det | new | T5b |
| `http.setTimeout(5000)` | `HTTP_TMO_MS` | HTTP call timeout (ms) | det | new | T5b |
| `remoteLogConfigFor.remoteMinLevel` | `LOG_MIN_LEVEL` | Lowest level sent to the relay | det | new | T5b |
| `remoteLogConfigFor.echoAlways` | `LOG_ECHO` | Show everything on serial | det | new | T5b |
| `remoteLogConfigFor.maxRetries` | `LOG_RETRY_MAX` | Retries after a failed delivery | det | new | T5b |
| `remoteLogConfigFor.retryPeriodMs` | `LOG_RETRY_SEC` | Seconds between retries | det | new | T5b |
| `remoteLogConfigFor.flushIntervalMs` | `LOG_FLUSH_SEC` | Seconds routine entries wait | det | new | T5b |
| `remoteLogConfigFor.repeatWindowMs` | `LOG_REPEAT_SEC` | Window for counting repeats | det | new | T5b |
| `config.sccb/vflip (set_vflip 0)` | `CAM_VFLIP` | Flip the picture upside down | det | new | done |
| `set_hmirror 0` | `CAM_HMIRROR` | Mirror the picture | det | new | done |

<!-- END GENERATED TABLE -->
