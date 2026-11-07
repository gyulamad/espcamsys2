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

// The `notifications.telegram` block of config.js (and the TELEGRAM_* environment variables, which win:
// a token kept in the environment never has to be written to a file) -> { config } | { config: null, warnings }.
// No block and no variables = the channel is simply not used (no warning). A bad value switches the channel
// off and says why; it never stops the relay.
function resolveTelegramConfig(raw, env = {}) {
  const given = raw && typeof raw === 'object' ? raw : {};
  const botToken = String(env.TELEGRAM_BOT_TOKEN !== undefined ? env.TELEGRAM_BOT_TOKEN : (given.botToken || '')).trim();
  const chatId = String(env.TELEGRAM_CHAT_ID !== undefined ? env.TELEGRAM_CHAT_ID : (given.chatId === undefined ? '' : given.chatId)).trim();
  if (given.enabled === false || (botToken === '' && chatId === '')) return { config: null, warnings: [] };
  if (!TOKEN_RE.test(botToken)) return { config: null, warnings: ['notifications.telegram.botToken is missing or not a bot token (it looks like 123456789:AA... — see lib/notify/README.md) — Telegram notifications are off'] };
  if (!CHAT_ID_RE.test(chatId)) return { config: null, warnings: ['notifications.telegram.chatId must be a number (a group is negative) or @channelname — Telegram notifications are off'] };
  return { config: { botToken, chatId, timeoutMs: DEFAULT_TIMEOUT_MS }, warnings: [] };
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
  // config: { botToken, chatId, timeoutMs }; post: httpspost.postRequest
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

  sendText(text) {
    return this.call('sendMessage', JSON.stringify({ chat_id: this.config.chatId, text, disable_web_page_preview: true }), 'application/json');
  }

  sendPhoto(image, caption) {
    const fields = { chat_id: this.config.chatId, ...(caption ? { caption } : {}) };
    const { body, contentType } = buildMultipart(fields, { field: 'photo', filename: 'thumbnail.jpg', type: 'image/jpeg', data: image }, this.boundary());
    return this.call('sendPhoto', body, contentType);
  }

  async deliver({ text, image }) {
    if (!image) return this.sendText(text);
    if (text.length <= MAX_CAPTION_LENGTH) return this.sendPhoto(image, text);
    await this.sendPhoto(image, '');
    return this.sendText(text);
  }
}

module.exports = { TelegramNotifier, resolveTelegramConfig, buildMultipart, HOST, MAX_CAPTION_LENGTH };
