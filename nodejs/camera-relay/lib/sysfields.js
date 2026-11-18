'use strict';

// sysfields.js — the table of the relay's SYSTEM settings: one row per value that used to live only in config.js,
// only in the environment, or (the first 23) in the settings store already. Data only: how a row is checked,
// merged and shown is lib/sysconfig.js; the generated reference of this table is SETTINGS.md.
//
// Where a value comes from, strongest first:  environment variable (if the row has one) > the settings store
// (system-settings.json) > config.js > the row's `default`. The default IS the value the relay used before the
// value became a setting, so an empty store and no config.js entry change nothing.
//
// A row:
//   key      the name in the store, the API and the settings page
//   type     int | float | bool | string | secret | sound | choice | url | chatids | host | argv
//   tier     basic | advanced | expert — who the page shows it to by default
//   group    the section of the settings page
//   restart  does a change need a relay restart to take effect (true for everything read once at startup)
//   default  what the relay uses when nothing else says anything. Taken from the module that owns the value
//            wherever there is one, so a default is written once.
//   min, max, step, minExclusive   the range of a number (a text's length for string / secret)
//   config   where config.js keeps it when that is not a top-level key of the same name (a path into it)
//   env      the environment variable that overrides it (or null). Documented in SETTINGS.md.
//   envFlag  a true/false switch whose variable keeps its old meaning: { trueWhen: '1' } (on only for exactly "1") or
//            { falseWhen: '0' } (off only for exactly "0"), so a deployment that sets RELAY_HSTS=1 keeps working
//   options  the allowed words of a `choice`
//   path     'file' | 'dir' (+ ext): a place the relay WRITES or READS; a change made here must stay inside the relay's folder
//   locked   shown but never changed from the page or the API: it decides which program the relay RUNS, so it can
//            only be changed in config.js, by whoever owns the machine
//
// `restart: false` rows are read again whenever they are used; their change counts at once.

const personscan = require('./personscan');
const soundplayer = require('./soundplayer');
const detectionnotice = require('./detectionnotice');
const storagenotice = require('./storagenotice');
const discovery = require('./discovery');
const detectorview = require('./detectorview');
const lockout = require('./lockout');

const MIB = 1024 * 1024;
const TIERS = ['basic', 'advanced', 'expert'];
// The longest a timer can wait (setTimeout fires at once beyond this). These environment variables used to accept any positive number,
// so the upper bounds of the rows they feed are as wide as the code can honour: nothing that worked before is refused now.
const MAX_TIMER_MS = 2 ** 31 - 1;

const FIELDS = [
  { key: 'alarmRecordSeconds', tier: 'basic', type: 'int', min: 1, max: 3600, default: 60, env: null, group: 'Recording', restart: false,
    label: 'Alarm recording length (seconds)', help: 'How long a recording started by a camera\'s alarm input runs. Applies to the next alarm — no restart.' },
  { key: 'minFreeStorageMB', tier: 'basic', type: 'int', min: 0, max: 1024 * 1024, default: 1024, env: 'MIN_FREE_STORAGE_MB', group: 'Recording', restart: false,
    label: 'Minimum free recording storage (MB)', help: 'When the free space on the disk holding the recordings falls below this, every dashboard page warns you to delete old recordings, and a notification channel, if one is set up, sends you a message too. 0 switches the warning and the message off. Applies at once — no restart.' },
  { key: 'preRollSeconds', tier: 'basic', type: 'int', min: 0, max: 60, default: 5, env: 'PREROLL_SECONDS', group: 'Recording', restart: true,
    label: 'Pre-roll (seconds)', help: 'Footage from BEFORE the trigger that every recording starts with. 0 switches it off.' },
  { key: 'preRollMaxBytes', tier: 'advanced', type: 'int', min: 64 * 1024, max: 1024 * MIB, default: 8 * MIB, env: 'PREROLL_MAX_BYTES', group: 'Recording', restart: true,
    label: 'Pre-roll RAM cap per camera (bytes)', help: 'The buffer drops its oldest frames first when it reaches this size. Default 8 MiB = 8388608.' },

  { key: 'personScanEnabled', tier: 'basic', type: 'bool', default: personscan.DEFAULTS.enabled, config: ['personScan', 'enabled'], env: null, group: 'Person check', restart: false,
    label: 'Person check (sort out recordings without a person)', help: 'ON: every new recording is checked by the person detector, and a clip with nobody in it is moved to the archive (or deleted — personScan.action in config.js); the check can also be started by hand on a recording. OFF: nothing is checked or moved, and clips already waiting for their check are left alone. Needs the detector model installed first (MANUAL.md, "Sorting out footage without a person"); without it every check just reports an error and no clip is touched. Applies at once — no restart.' },
  { key: 'personScanConfidence', tier: 'basic', type: 'float', min: personscan.CONFIDENCE.min, max: personscan.CONFIDENCE.max, minExclusive: true, step: 0.05, default: personscan.CONFIDENCE.default, config: ['personScan', 'confidence'], env: null, group: 'Person check', restart: false,
    label: 'Person detection sensitivity (confidence threshold)', help: 'How sure the person detector must be before a recording counts as having a person in it; the rest are sorted out to the archive. LOWER = MORE SENSITIVE: more doubtful clips are kept (a missed person costs more than a false alarm), 0.4 is the default. A different detector model may call for a different value. Only has an effect while the person check above is ON. Applies to the next clip checked — no restart.' },

  { key: 'alarmSoundRecordStart', tier: 'basic', type: 'sound', default: '', env: null, group: 'Alarm sounds', restart: false,
    label: 'Sound when a recording starts', help: 'Played when a camera starts a recording — its alarm input, the person detector, or the RECORD button. None = no sound. Pick one from the sound files below (upload them there). Applies at once — no restart.' },
  { key: 'alarmSoundRecordStartRelay', tier: 'basic', type: 'bool', default: true, env: null, group: 'Alarm sounds', restart: false,
    label: 'Recording starts: play it on the relay machine', help: 'ON: the machine the relay runs on (the Pi) plays the sound through its own speaker. Needs a speaker and an audio player on it (ffplay by default — MANUAL.md, \"Alarm sounds\"). Only has an effect while a sound is chosen above.' },
  { key: 'alarmSoundRecordStartBrowser', tier: 'basic', type: 'bool', default: true, env: null, group: 'Alarm sounds', restart: false,
    label: 'Recording starts: play it in the browser', help: 'ON: every browser that has the live dashboard, the camera list or a camera view open plays the sound. A browser only allows sound once you have clicked or tapped on its page. Only has an effect while a sound is chosen above.' },
  { key: 'alarmSoundPersonDetected', tier: 'basic', type: 'sound', default: '', env: null, group: 'Alarm sounds', restart: false,
    label: 'Sound when a person is found in a recording', help: 'Played when the person check finds somebody in a NEW recording (so it needs the person check above to be ON and its detector installed). None = no sound. Applies at once — no restart.' },
  { key: 'alarmSoundPersonDetectedRelay', tier: 'basic', type: 'bool', default: true, env: null, group: 'Alarm sounds', restart: false,
    label: 'Person found: play it on the relay machine', help: 'ON: the machine the relay runs on (the Pi) plays the sound through its own speaker. Only has an effect while a sound is chosen above.' },
  { key: 'alarmSoundPersonDetectedBrowser', tier: 'basic', type: 'bool', default: true, env: null, group: 'Alarm sounds', restart: false,
    label: 'Person found: play it in the browser', help: 'ON: every browser that has the live dashboard, the camera list or a camera view open plays the sound. Only has an effect while a sound is chosen above.' },

  { key: 'port', tier: 'advanced', type: 'int', min: 1, max: 65535, default: 8080, env: 'PORT', group: 'Network', restart: true,
    label: 'HTTP port', help: 'The relay\'s HTTP port (/mux, /snapshot, /status ...). The dashboard\'s relay address is updated to match when you change it here.' },
  { key: 'pushPort', tier: 'advanced', type: 'int', min: 1, max: 65535, default: 8081, env: 'PUSH_PORT', group: 'Network', restart: true,
    label: 'Camera push port', help: 'The raw TCP port the cameras push their frames to. It is flashed into every camera (their relay port setting) — change it and the cameras can no longer connect until they are updated.' },

  { key: 'camKey', tier: 'advanced', type: 'secret', min: 8, max: 200, env: 'CAM_KEY', group: 'Keys', restart: true,
    label: 'Camera key', help: 'Must match the API key of every camera. It is flashed into the boards: changing it disconnects every camera until each one is updated. Leave empty to keep the current one.' },
  { key: 'controlKey', tier: 'advanced', type: 'secret', min: 8, max: 200, env: 'CONTROL_KEY', group: 'Keys', restart: true,
    label: 'Control key', help: 'Protects recording ON/OFF, these settings and firmware publishing. Use a different value from the camera key. The dashboard\'s copy is updated for you. Leave empty to keep the current one.' },

  { key: 'logFile', tier: 'advanced', type: 'string', path: 'file', ext: '.log', min: 1, max: 300, default: 'logs/camera.log', env: 'LOG_FILE', group: 'Log', restart: true,
    label: 'Log file', help: 'A path inside the relay\'s own folder, ending in .log (for example logs/camera.log). To keep it somewhere else, set logFile in config.js.' },
  { key: 'logMaxBytes', tier: 'advanced', type: 'int', min: 64 * 1024, max: 1024 * MIB, default: 5 * MIB, env: 'LOG_MAX_BYTES', group: 'Log', restart: true,
    label: 'Log rotation size (bytes)', help: 'The file rotates when it would pass this size. Default 5 MiB = 5242880.' },
  { key: 'logKeepFiles', tier: 'advanced', type: 'int', min: 1, max: 20, default: 2, env: 'LOG_KEEP_FILES', group: 'Log', restart: true,
    label: 'Rotated log files kept', help: 'Disk use is at most (this + 1) x the rotation size.' },

  { key: 'deviceSettingsDir', tier: 'expert', type: 'string', path: 'dir', min: 1, max: 300, default: 'device-settings', env: 'DEVICE_SETTINGS_DIR', group: 'Folders', restart: true,
    label: 'Staged device settings folder', help: 'Where settings staged for boards missing some are kept. A folder inside the relay\'s own folder; for one elsewhere, set deviceSettingsDir in config.js.' },
  { key: 'firmwareDir', tier: 'expert', type: 'string', path: 'dir', min: 1, max: 300, default: 'firmware', env: 'FIRMWARE_DIR', group: 'Folders', restart: true,
    label: 'Firmware folder', help: 'Where the over-the-air firmware is published. A folder inside the relay\'s own folder; for one elsewhere, set firmwareDir in config.js.' },
  { key: 'soundsDir', tier: 'expert', type: 'string', path: 'dir', min: 1, max: 300, default: 'sounds', env: 'SOUNDS_DIR', group: 'Folders', restart: true,
    label: 'Alarm sounds folder', help: 'Where the alarm sound files are kept. A folder inside the relay\'s own folder; for one elsewhere, set soundsDir in config.js.' },
  { key: 'switchFile', tier: 'expert', type: 'string', path: 'file', ext: '.json', min: 1, max: 300, default: 'recording-switch.json', env: 'SWITCH_FILE', group: 'Folders', restart: true,
    label: 'Recording on/off state file', help: 'Where the recording ON/OFF state is kept so it survives a restart. A .json file inside the relay\'s own folder; for one elsewhere, set switchFile in config.js.' },

  // ── Moved here from config.js only, or the environment only (F-29 T6a) ──
  // Network
  { key: 'discoveryPort', tier: 'advanced', type: 'int', min: 0, max: 65535, default: discovery.DEFAULT_PORT, env: 'DISCOVERY_PORT', group: 'Network', restart: true,
    label: 'Camera discovery port (UDP, 0 = off)', help: 'Where the relay answers a camera that lost its address ("where is the relay?"). Must equal the cameras\' RELAY_FIND_PORT setting. 0 switches discovery off. The Pi\'s firewall must let UDP in on it.' },
  { key: 'relayBind', tier: 'expert', type: 'host', default: '0.0.0.0', env: 'RELAY_BIND', group: 'Network', restart: true,
    label: 'HTTP bind address', help: 'The address the HTTP port listens on. 0.0.0.0 = every network (needed by cameras and detectors on the LAN); 127.0.0.1 = this machine only. A wrong value can lock you out of the relay.' },
  { key: 'pushAuthTimeoutMs', tier: 'expert', type: 'int', min: 1, max: MAX_TIMER_MS, default: 10 * 1000, env: 'PUSH_AUTH_TIMEOUT_MS', group: 'Network', restart: true,
    label: 'Push connection: time to say who it is (ms)', help: 'A camera that opened the push port must send its id and key within this time, or the connection is dropped.' },
  { key: 'pushIdleTimeoutMs', tier: 'expert', type: 'int', min: 1, max: MAX_TIMER_MS, default: 60 * 1000, env: 'PUSH_IDLE_TIMEOUT_MS', group: 'Network', restart: true,
    label: 'Push connection: silence before it is dropped (ms)', help: 'A connection that sends nothing for this long is judged dead (a half-open connection never tells by itself).' },

  // Detectors
  { key: 'detectorViewMinutes', tier: 'basic', type: 'int', min: 1, max: detectorview.MAX_VIEW_MINUTES, default: detectorview.DEFAULT_VIEW_MINUTES, env: 'DETECTOR_VIEW_MINUTES', group: 'Detectors', restart: true,
    label: 'Detector live view length (minutes)', help: 'How long a person detector keeps streaming its sensor values and small picture after somebody pressed WATCH (and again after every ask while they keep watching).' },
  { key: 'detectorNoPictureWarnMs', tier: 'expert', type: 'int', min: 1, max: MAX_TIMER_MS, default: 10 * 1000, env: 'DETECTOR_NO_PICTURE_WARN_MS', group: 'Detectors', restart: true,
    label: 'Detector without a picture: warn after (ms)', help: 'A detector that is connected and reports numbers but sends no picture for this long is mentioned once in the log.' },

  // Person check (the rest of config.js's personScan block)
  { key: 'personScanAuto', tier: 'advanced', type: 'bool', default: personscan.DEFAULTS.auto, config: ['personScan', 'auto'], env: null, group: 'Person check', restart: true,
    label: 'Check every new recording automatically', help: 'ON: every recording is checked right after it is saved. OFF: only when you start a check by hand. Only has an effect while the person check is ON.' },
  { key: 'personScanAction', tier: 'advanced', type: 'choice', options: personscan.ACTIONS, default: personscan.DEFAULTS.action, config: ['personScan', 'action'], env: null, group: 'Person check', restart: true,
    label: 'What to do with a clip without a person', help: 'move = file it under <camera>/no-person/ (safe, the clip stays on disk). delete = remove it for good. A clip is never touched unless the whole clip was read and nobody was found.' },
  { key: 'personScanModel', tier: 'expert', type: 'string', path: 'file', ext: '.onnx', min: 1, max: 300, default: personscan.DEFAULT_MODEL, config: ['personScan', 'model'], env: null, group: 'Person check', restart: true,
    label: 'Person detector model file', help: 'The YOLO ONNX model, a path inside the relay\'s own folder.' },
  { key: 'personScanStride', tier: 'advanced', type: 'int', min: 1, max: 60, default: personscan.DEFAULTS.stride, config: ['personScan', 'stride'], env: null, group: 'Person check', restart: true,
    label: 'Analyse every Nth frame', help: 'Raise it to check faster on a slow Pi; a person who is only in view for a moment may be missed.' },
  { key: 'personScanTimeoutSeconds', tier: 'advanced', type: 'int', min: 10, max: 86400, default: personscan.DEFAULTS.timeoutSeconds, config: ['personScan', 'timeoutSeconds'], env: null, group: 'Person check', restart: true,
    label: 'Time allowed for checking one clip (seconds)', help: 'A check that takes longer is stopped and the clip is kept.' },
  { key: 'personScanPython', tier: 'expert', type: 'string', locked: true, min: 1, max: 300, default: personscan.DEFAULTS.python, config: ['personScan', 'python'], env: null, group: 'Person check', restart: true,
    label: 'Python program that runs the detector', help: 'LOCKED: it decides what program the relay runs, so it can only be changed in config.js on the machine itself (personScan.python).' },
  { key: 'personScanScript', tier: 'expert', type: 'string', locked: true, min: 1, max: 300, default: personscan.DEFAULT_SCRIPT, config: ['personScan', 'script'], env: null, group: 'Person check', restart: true,
    label: 'Detector script', help: 'LOCKED: it is the program the relay runs on every clip, so it can only be changed in config.js on the machine itself (personScan.script).' },

  // Alarm sounds (the rest of config.js's alarmSounds block)
  { key: 'alarmSoundPlayer', tier: 'expert', type: 'argv', locked: true, default: soundplayer.DEFAULT_COMMAND, config: ['alarmSounds', 'player'], env: null, group: 'Alarm sounds', restart: true,
    label: 'Sound player command', help: 'LOCKED: the program (and its arguments) that plays a sound on the relay machine. It can only be changed in config.js on the machine itself (alarmSounds.player).' },
  { key: 'alarmSoundTimeoutSeconds', tier: 'advanced', type: 'int', min: 1, max: soundplayer.MAX_TIMEOUT_SECONDS, default: soundplayer.DEFAULT_TIMEOUT_SECONDS, config: ['alarmSounds', 'timeoutSeconds'], env: null, group: 'Alarm sounds', restart: true,
    label: 'Longest time a sound may play (seconds)', help: 'A sound still playing after this long is stopped.' },

  // Notifications (config.js's notifications block)
  { key: 'telegramEnabled', tier: 'basic', type: 'bool', default: true, config: ['notifications', 'telegram', 'enabled'], env: null, group: 'Notifications', restart: true,
    label: 'Telegram messages', help: 'OFF keeps the bot token and chat below but sends nothing. Needs a bot token and a chat id to send anything at all.' },
  { key: 'telegramBotToken', tier: 'basic', type: 'secret', min: 8, max: 200, config: ['notifications', 'telegram', 'botToken'], env: 'TELEGRAM_BOT_TOKEN', group: 'Notifications', restart: true,
    label: 'Telegram bot token', help: 'From @BotFather, like 123456789:AA... Leave empty to keep the current one.' },
  { key: 'telegramChatId', tier: 'basic', type: 'chatids', default: '', config: ['notifications', 'telegram', 'chatId'], env: 'TELEGRAM_CHAT_ID', group: 'Notifications', restart: true,
    label: 'Telegram chat id(s)', help: 'Your chat\'s number (a group\'s is negative) or @channelname; several, separated by commas — everybody gets every message.' },
  { key: 'footageBaseUrl', tier: 'basic', type: 'url', default: '', config: ['notifications', 'footageBaseUrl'], env: null, group: 'Notifications', restart: true,
    label: 'Dashboard address for message links', help: 'The dashboard as your phone reaches it, like http://raspberrypi.local/camdash. Messages about a person link to the clip there. Empty = no link.' },
  { key: 'notifyCooldownSeconds', tier: 'advanced', type: 'int', min: 0, max: detectionnotice.MAX_COOLDOWN_SECONDS, default: detectionnotice.DEFAULT_COOLDOWN_SECONDS, config: ['notifications', 'cooldownSeconds'], env: null, group: 'Notifications', restart: true,
    label: 'At most one person message per camera in (seconds)', help: 'What is held back is counted in the next message. 0 = announce every detection.' },
  { key: 'storageReminderHours', tier: 'advanced', type: 'int', min: 0, max: storagenotice.MAX_REMINDER_HOURS, default: storagenotice.DEFAULT_REMINDER_HOURS, config: ['notifications', 'storageReminderHours'], env: null, group: 'Notifications', restart: true,
    label: 'Low-storage reminder every (hours)', help: 'While the free space stays below the limit you get a reminder this often. 0 = no reminders.' },

  // Security
  { key: 'readKeyRequired', tier: 'expert', type: 'bool', default: true, env: 'READ_KEY_REQUIRED', envFlag: { falseWhen: '0' }, group: 'Security', restart: true,
    label: 'Refuse reads while no control key is set', help: 'ON (safe): live video, snapshots and recordings are refused until a control key is set. OFF only for a trusted LAN with no outside exposure. Environment: READ_KEY_REQUIRED=0 switches it off.' },
  { key: 'allowKeylessAlarm', tier: 'expert', type: 'bool', default: false, env: 'ALLOW_KEYLESS_ALARM', envFlag: { trueWhen: '1' }, group: 'Security', restart: true,
    label: 'Accept alarms without a camera key (old firmware)', help: 'Only for old firmware that cannot send its key. Anybody on the network can then start recordings (limited to one per address per gap below). Environment: ALLOW_KEYLESS_ALARM=1 switches it on.' },
  { key: 'keylessAlarmGapMs', tier: 'expert', type: 'int', min: 1, max: MAX_TIMER_MS, default: 60 * 1000, env: 'KEYLESS_ALARM_GAP_MS', group: 'Security', restart: true,
    label: 'Keyless alarms: gap per address (ms)', help: 'With keyless alarms on, one alarm per source address is accepted in this time.' },
  { key: 'maxAlarmRecordings', tier: 'advanced', type: 'int', min: 1, max: 1e6, default: 16, env: 'MAX_ALARM_RECORDINGS', group: 'Security', restart: false,
    label: 'Most recordings at the same time', help: 'Alarm-started recordings are refused (503) while this many cameras are already recording, so a flood of alarms cannot fill the disk. Applies at once — no restart.' },
  { key: 'relayHsts', tier: 'expert', type: 'bool', default: false, env: 'RELAY_HSTS', envFlag: { trueWhen: '1' }, group: 'Security', restart: true,
    label: 'Send the HSTS header', help: 'ON only when the relay is reached over HTTPS: browsers then refuse plain HTTP for a year. Environment: RELAY_HSTS=1 switches it on.' },
  { key: 'authMaxFailures', tier: 'expert', type: 'int', min: 1, max: 1e9, default: lockout.DEFAULTS.maxFailures, env: 'AUTH_MAX_FAILURES', group: 'Security', restart: true,
    label: 'Wrong keys before an address is locked out', help: 'Wrong keys from one address within a minute. The camera key and the control key count separately.' },
  { key: 'authLockSeconds', tier: 'expert', type: 'int', min: 1, max: 1e9, default: lockout.DEFAULTS.baseLockMs / 1000, env: 'AUTH_LOCK_SECONDS', group: 'Security', restart: true,
    label: 'First lock-out time (seconds)', help: 'Each repeat doubles it, up to the longest lock-out below. While locked out even the right key is refused.' },
  { key: 'authLockMaxSeconds', tier: 'expert', type: 'int', min: 1, max: 1e9, default: lockout.DEFAULTS.maxLockMs / 1000, env: 'AUTH_LOCK_MAX_SECONDS', group: 'Security', restart: true,
    label: 'Longest lock-out time (seconds)', help: 'Must not be shorter than the first lock-out time.' },
  { key: 'restartCooldownMs', tier: 'expert', type: 'int', min: 1, max: MAX_TIMER_MS, default: 30 * 1000, env: 'RESTART_COOLDOWN_MS', group: 'Security', restart: false,
    label: 'Least time between two restart requests (ms)', help: 'A restart requested sooner after another is refused (429), so a captured control key cannot make the relay flap. Applies at once — no restart.' },

  // Diagnostics
  { key: 'loopWatch', tier: 'expert', type: 'bool', default: true, env: 'LOOPWATCH', envFlag: { falseWhen: '0' }, group: 'Diagnostics', restart: true,
    label: 'Event-loop watchdog', help: 'Logs when the relay\'s main loop stalls. Environment: LOOPWATCH=0 switches it off.' },
];

const FIELD_TYPES = ['int', 'float', 'bool', 'string', 'secret', 'sound', 'choice', 'url', 'chatids', 'host', 'argv'];

// The environment variables that are NOT settings, and why they cannot be: the relay reads them before (or instead of) the
// settings store, or they only report how the process was started. Every other variable the relay reads is a row's `env`
// above — tests/node/test_sysconfig_inventory.js scans the code for one that is neither.
const BOOTSTRAP_ENV = Object.freeze({
  SYSTEM_SETTINGS_FILE: 'Where the settings store itself is kept. It cannot be a setting stored inside itself.',
  SETTINGS_FILE: 'Where the live alarm length (settings.json) is kept — the same reason; the end-to-end tests point it at a throwaway file.',
  RELAY_SUPERVISED: 'Says that something (not systemd or pm2) starts the relay again after it exits. A fact about how it was started.',
  INVOCATION_ID: 'Set by systemd for a service it runs. Read only, to know a restart would bring the relay back.',
  pm_id: 'Set by pm2 for a process it runs. Read only, for the same reason.',
});

module.exports = { FIELDS, FIELD_TYPES, TIERS, BOOTSTRAP_ENV };
