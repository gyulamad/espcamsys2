# Relay settings reference

Generated from `lib/sysfields.js` by `node lib/sysconfigdoc.js > SETTINGS.md` — do not edit by hand. A test fails while this file is out of date.

Every value the relay uses is a row here. The **default** is what the relay used before the value became a setting, so an empty
store and an untouched `config.js` change nothing. Where a value comes from, strongest first:

1. its **environment variable**, if the row has one (the page shows such a row as read-only);
2. the **settings store** (`system-settings.json`, written by `POST /system-settings`);
3. **`config.js`** (the column "config.js" says where, when it is not the key's own name);
4. the **default**.

**restart** = read once at startup: a saved change counts after the relay restarts. **at once** = read each time it is used.
A **locked** row is shown but cannot be changed through the API: it decides which program the relay runs, so only the owner of the machine can change it, in `config.js`.

## Recording

| Key | Tier | Type | Default | Applies | Environment | config.js | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `alarmRecordSeconds` | basic | int | `60` | at once | — | — (settings.json) |  |
| `minFreeStorageMB` | basic | int | `1024` | at once | `MIN_FREE_STORAGE_MB` | `minFreeStorageMB` |  |
| `preRollSeconds` | basic | int | `5` | restart | `PREROLL_SECONDS` | `preRollSeconds` |  |
| `preRollMaxBytes` | advanced | int | `8388608` | restart | `PREROLL_MAX_BYTES` | `preRollMaxBytes` |  |

## Person check

| Key | Tier | Type | Default | Applies | Environment | config.js | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `personScanEnabled` | basic | bool | `false` | at once | — | `personScan.enabled` |  |
| `personScanConfidence` | basic | float | `0.4` | at once | — | `personScan.confidence` |  |
| `personScanAuto` | advanced | bool | `true` | restart | — | `personScan.auto` |  |
| `personScanAction` | advanced | choice | `move` | restart | — | `personScan.action` |  |
| `personScanModel` | expert | string | `models/person.onnx` | restart | — | `personScan.model` |  |
| `personScanStride` | advanced | int | `1` | restart | — | `personScan.stride` |  |
| `personScanTimeoutSeconds` | advanced | int | `900` | restart | — | `personScan.timeoutSeconds` |  |
| `personScanPython` | expert | string | `python3` | restart | — | `personScan.python` | locked: config.js only |
| `personScanScript` | expert | string | `tools/person_scan.py` | restart | — | `personScan.script` | locked: config.js only |

## Alarm sounds

| Key | Tier | Type | Default | Applies | Environment | config.js | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `alarmSoundRecordStart` | basic | sound | `""` (empty) | at once | — | `alarmSoundRecordStart` |  |
| `alarmSoundRecordStartRelay` | basic | bool | `true` | at once | — | `alarmSoundRecordStartRelay` |  |
| `alarmSoundRecordStartBrowser` | basic | bool | `true` | at once | — | `alarmSoundRecordStartBrowser` |  |
| `alarmSoundPersonDetected` | basic | sound | `""` (empty) | at once | — | `alarmSoundPersonDetected` |  |
| `alarmSoundPersonDetectedRelay` | basic | bool | `true` | at once | — | `alarmSoundPersonDetectedRelay` |  |
| `alarmSoundPersonDetectedBrowser` | basic | bool | `true` | at once | — | `alarmSoundPersonDetectedBrowser` |  |
| `alarmSoundPlayer` | expert | argv | `["ffplay","-nodisp","-autoexit","-loglevel","error"]` | restart | — | `alarmSounds.player` | locked: config.js only |
| `alarmSoundTimeoutSeconds` | advanced | int | `30` | restart | — | `alarmSounds.timeoutSeconds` |  |

## Network

| Key | Tier | Type | Default | Applies | Environment | config.js | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `port` | advanced | int | `8080` | restart | `PORT` | `port` |  |
| `pushPort` | advanced | int | `8081` | restart | `PUSH_PORT` | `pushPort` |  |
| `discoveryPort` | advanced | int | `8082` | restart | `DISCOVERY_PORT` | `discoveryPort` |  |
| `relayBind` | expert | host | `0.0.0.0` | restart | `RELAY_BIND` | `relayBind` |  |
| `pushAuthTimeoutMs` | expert | int | `10000` | restart | `PUSH_AUTH_TIMEOUT_MS` | `pushAuthTimeoutMs` |  |
| `pushIdleTimeoutMs` | expert | int | `60000` | restart | `PUSH_IDLE_TIMEOUT_MS` | `pushIdleTimeoutMs` |  |

## Keys

| Key | Tier | Type | Default | Applies | Environment | config.js | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `camKey` | advanced | secret | — (none) | restart | `CAM_KEY` | `camKey` |  |
| `controlKey` | advanced | secret | — (none) | restart | `CONTROL_KEY` | `controlKey` |  |

## Log

| Key | Tier | Type | Default | Applies | Environment | config.js | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `logFile` | advanced | string | `logs/camera.log` | restart | `LOG_FILE` | `logFile` |  |
| `logMaxBytes` | advanced | int | `5242880` | restart | `LOG_MAX_BYTES` | `logMaxBytes` |  |
| `logKeepFiles` | advanced | int | `2` | restart | `LOG_KEEP_FILES` | `logKeepFiles` |  |

## Folders

| Key | Tier | Type | Default | Applies | Environment | config.js | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `deviceSettingsDir` | expert | string | `device-settings` | restart | `DEVICE_SETTINGS_DIR` | `deviceSettingsDir` |  |
| `firmwareDir` | expert | string | `firmware` | restart | `FIRMWARE_DIR` | `firmwareDir` |  |
| `soundsDir` | expert | string | `sounds` | restart | `SOUNDS_DIR` | `soundsDir` |  |
| `switchFile` | expert | string | `recording-switch.json` | restart | `SWITCH_FILE` | `switchFile` |  |

## Detectors

| Key | Tier | Type | Default | Applies | Environment | config.js | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `detectorViewMinutes` | basic | int | `10` | restart | `DETECTOR_VIEW_MINUTES` | `detectorViewMinutes` |  |
| `detectorNoPictureWarnMs` | expert | int | `10000` | restart | `DETECTOR_NO_PICTURE_WARN_MS` | `detectorNoPictureWarnMs` |  |

## Notifications

| Key | Tier | Type | Default | Applies | Environment | config.js | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `telegramEnabled` | basic | bool | `true` | restart | — | `notifications.telegram.enabled` |  |
| `telegramBotToken` | basic | secret | — (none) | restart | `TELEGRAM_BOT_TOKEN` | `notifications.telegram.botToken` |  |
| `telegramChatId` | basic | chatids | `""` (empty) | restart | `TELEGRAM_CHAT_ID` | `notifications.telegram.chatId` |  |
| `footageBaseUrl` | basic | url | `""` (empty) | restart | — | `notifications.footageBaseUrl` |  |
| `notifyCooldownSeconds` | advanced | int | `60` | restart | — | `notifications.cooldownSeconds` |  |
| `storageReminderHours` | advanced | int | `24` | restart | — | `notifications.storageReminderHours` |  |

## Security

| Key | Tier | Type | Default | Applies | Environment | config.js | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `readKeyRequired` | expert | bool | `true` | restart | `READ_KEY_REQUIRED` | `readKeyRequired` | env: off only for "0" |
| `allowKeylessAlarm` | expert | bool | `false` | restart | `ALLOW_KEYLESS_ALARM` | `allowKeylessAlarm` | env: on only for "1" |
| `keylessAlarmGapMs` | expert | int | `60000` | restart | `KEYLESS_ALARM_GAP_MS` | `keylessAlarmGapMs` |  |
| `maxAlarmRecordings` | advanced | int | `16` | at once | `MAX_ALARM_RECORDINGS` | `maxAlarmRecordings` |  |
| `relayHsts` | expert | bool | `false` | restart | `RELAY_HSTS` | `relayHsts` | env: on only for "1" |
| `authMaxFailures` | expert | int | `10` | restart | `AUTH_MAX_FAILURES` | `authMaxFailures` |  |
| `authLockSeconds` | expert | int | `60` | restart | `AUTH_LOCK_SECONDS` | `authLockSeconds` |  |
| `authLockMaxSeconds` | expert | int | `900` | restart | `AUTH_LOCK_MAX_SECONDS` | `authLockMaxSeconds` |  |
| `restartCooldownMs` | expert | int | `30000` | at once | `RESTART_COOLDOWN_MS` | `restartCooldownMs` |  |

## Diagnostics

| Key | Tier | Type | Default | Applies | Environment | config.js | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `loopWatch` | expert | bool | `true` | restart | `LOOPWATCH` | `loopWatch` | env: off only for "0" |

## Environment variables that are not settings

| Variable | Why it cannot be a setting |
| --- | --- |
| `SYSTEM_SETTINGS_FILE` | Where the settings store itself is kept. It cannot be a setting stored inside itself. |
| `SETTINGS_FILE` | Where the live alarm length (settings.json) is kept — the same reason; the end-to-end tests point it at a throwaway file. |
| `RELAY_SUPERVISED` | Says that something (not systemd or pm2) starts the relay again after it exits. A fact about how it was started. |
| `INVOCATION_ID` | Set by systemd for a service it runs. Read only, to know a restart would bring the relay back. |
| `pm_id` | Set by pm2 for a process it runs. Read only, for the same reason. |
