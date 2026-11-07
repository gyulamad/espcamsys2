'use strict';

// storagenotice.js — "the disk that holds the recordings is almost full": tells the user through the notification
// channels (lib/notify/), so they hear about it even when they have not opened the dashboard for days — the
// dashboard's own alert (GET /storage, lib/diskspace.js) only shows when a page is loaded.
//
// What "almost full" means is NOT decided here: it is the minimum the dashboard alert uses (the setting "Minimum
// free recording storage (MB)", minFreeStorageMB; 0 = off), already worked out into a view by
// diskspace.buildStorageView. This module only decides WHEN to speak, so a disk that stays low does not mean a
// message a minute:
//   - one message when the disk becomes low,
//   - a reminder every `reminderMs` while it stays low (0 = no reminders),
//   - it is quiet again only once the free space has climbed RECOVERY_FACTOR above the minimum, so a disk that
//     hovers around the limit (one recording written, one old one deleted) does not announce itself over and over,
//   - a message that no channel delivered is tried again after RETRY_MS, not at every check.
// A disk the system will not report on changes nothing (no message, no reset). A minimum of 0 switches the
// messages off and forgets the episode, so switching it on again while the disk is low is announced.
//
// The state lives in memory: a relay restart while the disk is still low sends the message again.
//
// The decision (nextStep) is pure. The disk, the clock, the notifier and the log are injected, so everything is
// unit tested without them (tests/node/test_storagenotice.js). check() never throws and never rejects.

const { formatTime } = require('./detectionnotice');
const { errorMessage } = require('./util');

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_REMINDER_HOURS = 24;
const MAX_REMINDER_HOURS = 24 * 365;
const RECOVERY_FACTOR = 1.1;
const RETRY_MS = 15 * 60 * 1000;

// What has been told in the current low-disk episode: when a message was last DELIVERED (null = none yet) and when
// an attempt last FAILED (null = the last attempt, if any, went through).
const IDLE = Object.freeze({ sentAt: null, failedAt: null });

// config.js's `notifications` block -> { reminderMs, warnings }.
//   storageReminderHours  how often the message is repeated while the disk stays low; 0 = never repeat
function resolveStorageNoticeConfig(raw) {
  const given = raw && typeof raw === 'object' ? raw : {};
  const hours = given.storageReminderHours;
  if (hours === undefined) return { reminderMs: DEFAULT_REMINDER_HOURS * HOUR_MS, warnings: [] };
  if (Number.isInteger(hours) && hours >= 0 && hours <= MAX_REMINDER_HOURS) return { reminderMs: hours * HOUR_MS, warnings: [] };
  return {
    reminderMs: DEFAULT_REMINDER_HOURS * HOUR_MS,
    warnings: [`notifications.storageReminderHours must be a whole number of hours from 0 to ${MAX_REMINDER_HOURS} — ${DEFAULT_REMINDER_HOURS} is used`],
  };
}

// Has `intervalMs` passed since `sinceMs`? A clock that was set back (a Pi without a battery clock, after its
// first network time sync) counts as passed, so a message is never held back by a wrong earlier time.
function hasElapsed(sinceMs, nowMs, intervalMs) {
  const elapsed = nowMs - sinceMs;
  return elapsed >= intervalMs || elapsed < 0;
}

function hasRecovered(view) {
  return view.minFreeMB === 0 || view.freeMB >= view.minFreeMB * RECOVERY_FACTOR;
}

// Is a message due in this episode? Never delivered one yet, or the reminder interval has passed.
function isDue(state, nowMs, reminderMs) {
  if (state.sentAt === null) return true;
  return reminderMs > 0 && hasElapsed(state.sentAt, nowMs, reminderMs);
}

// What to do now, given the state of the episode and the storage view (diskspace.buildStorageView's answer).
//   -> { send: null | 'first' | 'reminder', state }   the state to keep (the outcome of a send is recorded by
//      afterAttempt)
function nextStep(state, view, nowMs, reminderMs) {
  const stay = { send: null, state };
  if (!view.known) return stay;
  if (!view.low) return hasRecovered(view) ? { send: null, state: IDLE } : stay;
  if (!isDue(state, nowMs, reminderMs)) return stay;
  if (state.failedAt !== null && !hasElapsed(state.failedAt, nowMs, RETRY_MS)) return stay;
  return { send: state.sentAt === null ? 'first' : 'reminder', state };
}

function afterAttempt(state, delivered, nowMs) {
  return delivered ? { sentAt: nowMs, failedAt: null } : { sentAt: state.sentAt, failedAt: nowMs };
}

// The text of the message, in the wording of the dashboard's alert. Lines for what is not known (no dashboard
// address) are left out.
//   baseUrl: the dashboard as the phone reaches it (notifications.footageBaseUrl, already checked), or null
function buildStorageText(view, { kind, nowMs, baseUrl }) {
  return [
    kind === 'reminder' ? 'Reminder: the recording storage is still almost empty.' : 'The recording storage is almost empty.',
    `Free: ${view.freeMB} MB (the minimum is ${view.minFreeMB} MB). Please delete old files.`,
    `Time: ${formatTime(nowMs)}`,
    baseUrl ? `Recordings: ${baseUrl}/all-recordings.php` : null,
  ].filter(Boolean).join('\n');
}

// deps: notifier (MultiNotifier-like: isEmpty(), send()), readView() -> Promise of the storage view,
//   config (resolveStorageNoticeConfig's answer), baseUrl (see buildStorageText), now() -> ms,
//   log(level, message)
function createStorageNotifier({ notifier, readView, config, baseUrl, now, log }) {
  let state = IDLE;
  let running = false;

  async function announce(view, kind) {
    const nowMs = now();
    const text = buildStorageText(view, { kind, nowMs, baseUrl });
    const results = await notifier.send({ text }).catch((e) => [{ name: 'notifier', ok: false, error: errorMessage(e) }]);
    for (const r of results.filter((x) => !x.ok)) log('WARN', `the storage notification through ${r.name} failed: ${r.error}`);
    const delivered = results.some((r) => r.ok);
    state = afterAttempt(state, delivered, nowMs);
    if (delivered) log('INFO', `storage notification (${kind}) sent: ${view.freeMB} MB free, minimum ${view.minFreeMB} MB`);
  }

  async function run() {
    const view = await readView();
    const step = nextStep(state, view, now(), config.reminderMs);
    state = step.state;
    if (step.send) await announce(view, step.send);
  }

  // One look at the disk. Called on a timer; a call that arrives while the previous one is still busy (a slow
  // channel) is skipped rather than queued.
  async function check() {
    if (running) return;
    if (notifier.isEmpty()) return;
    running = true;
    try {
      await run();
    } catch (e) {
      log('WARN', `the storage check failed: ${errorMessage(e)}`);
    } finally {
      running = false;
    }
  }

  return { check };
}

module.exports = {
  resolveStorageNoticeConfig, nextStep, afterAttempt, buildStorageText, createStorageNotifier,
  IDLE, RECOVERY_FACTOR, RETRY_MS, DEFAULT_REMINDER_HOURS, MAX_REMINDER_HOURS,
};
