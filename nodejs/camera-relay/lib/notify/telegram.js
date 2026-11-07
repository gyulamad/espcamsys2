'use strict';

// telegram.js — the Telegram bot channel: implements the Notifier interface (notifier.js) over the Bot API.
//
//   - text only  -> sendMessage; text + thumbnail -> sendPhoto with the text as its caption (when it fits the
//     1024-character caption limit, otherwise the photo goes first and the full text follows as a message)
//   - plain text only (no parse_mode): nothing in a camera name or file name can become markup
//   - the host is fixed (api.telegram.org): no setting can aim the bot token at another server
//   - the token never appears in an error message or a log line (redact)
//
// The network is injected (`post`, see httpspost.js), so it is unit tested without one
// (tests/node/test_notify_telegram.js).

const crypto = require('crypto');
const { Notifier } = require('./notifier');

const HOST = 'api.telegram.org';
const MAX_CAPTION_LENGTH = 1024;
const TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{20,}$/;
const CHAT_ID_RE = /^(-?\d{1,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;
const DEFAULT_TIMEOUT_MS = 15000;

// The recipients as written in the config: one chat id, an array of them, or (the environment variable) a
// comma-separated list -> trimmed strings, empty entries dropped.
function chatIdEntries(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : String(value).split(',');
  return list.map((v) => String(v).trim()).filter((v) => v !== '');
}

// The `notifications.telegram` block of config.js (and the TELEGRAM_* environment variables, which win:
// a token kept in the environment never has to be written to a file) -> { config } | { config: null, warnings }.
//   chatId   one chat, or an array of them (TELEGRAM_CHAT_ID: comma-separated) — everybody gets every message
// No block and no variables = the channel is simply not used (no warning). A bad token switches the channel
// off and says why; a bad chat id is left out with a warning (the valid ones still get their messages — a typo
// must not silence everyone else), and the channel is off only when no valid chat id is left. Chats listed
// twice are messaged once. Nothing here ever stops the relay.
function resolveTelegramConfig(raw, env = {}) {
  const given = raw && typeof raw === 'object' ? raw : {};
  const botToken = String(env.TELEGRAM_BOT_TOKEN !== undefined ? env.TELEGRAM_BOT_TOKEN : (given.botToken || '')).trim();
  const entries = chatIdEntries(env.TELEGRAM_CHAT_ID !== undefined ? env.TELEGRAM_CHAT_ID : given.chatId);
  if (given.enabled === false || (botToken === '' && entries.length === 0)) return { config: null, warnings: [] };
  if (!TOKEN_RE.test(botToken)) return { config: null, warnings: ['notifications.telegram.botToken is missing or not a bot token (it looks like 123456789:AA... — see lib/notify/README.md) — Telegram notifications are off'] };
  const warnings = [];
  const chatIds = [];
  entries.forEach((entry, i) => {
    if (!CHAT_ID_RE.test(entry)) warnings.push(`notifications.telegram.chatId entry #${i + 1} must be a number (a group is negative) or @channelname — it is left out`);
    else if (!chatIds.includes(entry)) chatIds.push(entry);
  });
  if (chatIds.length === 0) return { config: null, warnings: [...warnings, 'notifications.telegram.chatId has no usable chat id (a number, a negative number for a group, or @channelname — or an array of them) — Telegram notifications are off'] };
  return { config: { botToken, chatIds, timeoutMs: DEFAULT_TIMEOUT_MS }, warnings };
}

// multipart/form-data body for sendPhoto. `boundary` is random per request (injected for tests): it must not
// occur in the data, and 24 random bytes will not.
function buildMultipart(fields, file, boundary) {
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`));
  parts.push(file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

class TelegramNotifier extends Notifier {
  // config: { botToken, chatIds, timeoutMs }; post: httpspost.postRequest
  constructor({ config, post, boundary = () => crypto.randomBytes(24).toString('hex') }) {
    super('telegram');
    this.config = config;
    this.post = post;
    this.boundary = boundary;
  }

  redact(text) {
    return String(text).split(this.config.botToken).join('<token>');
  }

  async call(method, body, contentType) {
    let answer;
    try {
      answer = await this.post({
        hostname: HOST,
        path: `/bot${this.config.botToken}/${method}`,
        headers: { 'Content-Type': contentType },
        body,
        timeoutMs: this.config.timeoutMs,
      });
    } catch (e) {
      throw new Error(`Telegram ${method}: ${this.redact(e.message)}`);
    }
    let parsed = null;
    try { parsed = JSON.parse(answer.body); } catch (e) { parsed = null; }
    if (answer.status === 200 && parsed && parsed.ok === true) return;
    const why = parsed && typeof parsed.description === 'string' ? parsed.description : `HTTP ${answer.status}`;
    throw new Error(`Telegram ${method} was refused: ${this.redact(why).slice(0, 200)}`);
  }

  sendText(chatId, text) {
    return this.call('sendMessage', JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }), 'application/json');
  }

  sendPhoto(chatId, image, caption) {
    const fields = { chat_id: chatId, ...(caption ? { caption } : {}) };
    const { body, contentType } = buildMultipart(fields, { field: 'photo', filename: 'thumbnail.jpg', type: 'image/jpeg', data: image }, this.boundary());
    return this.call('sendPhoto', body, contentType);
  }

  async deliverTo(chatId, { text, image }) {
    if (!image) return this.sendText(chatId, text);
    if (text.length <= MAX_CAPTION_LENGTH) return this.sendPhoto(chatId, image, text);
    await this.sendPhoto(chatId, image, '');
    return this.sendText(chatId, text);
  }

  // Every chat gets the message on its own: a chat that cannot be reached (a user who blocked the bot, a
  // wrong id) never keeps the others from getting it. If any failed, the error names each failed chat and says
  // how many did get it, so the log shows who is missing and why.
  async deliver(message) {
    const { chatIds } = this.config;
    const results = await Promise.allSettled(chatIds.map((chatId) => this.deliverTo(chatId, message)));
    const failed = results
      .map((r, i) => (r.status === 'rejected' ? `chat ${chatIds[i]}: ${this.redact(r.reason && r.reason.message ? r.reason.message : r.reason)}` : null))
      .filter(Boolean);
    if (failed.length === 0) return;
    const delivered = chatIds.length - failed.length;
    throw new Error(`${chatIds.length === 1 ? '' : `delivered to ${delivered} of ${chatIds.length} chats; `}${failed.join('; ')}`);
  }
}

module.exports = { TelegramNotifier, resolveTelegramConfig, buildMultipart, HOST, MAX_CAPTION_LENGTH };
