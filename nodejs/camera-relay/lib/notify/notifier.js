'use strict';

// notifier.js — the Notification interface of the relay: ONE way to say "something happened" with a text and,
// optionally, a thumbnail, whatever carries it (Telegram, e-mail, ntfy ...). The server event code only knows
// this interface; every channel is a strategy that implements it (strategy pattern), and MultiNotifier fans one
// message out to all the enabled strategies (composite), so adding a channel never touches the event code.
//
//   message = { text: string, image?: Buffer }   image: a JPEG (the thumbnail), at most MAX_IMAGE_BYTES
//   send(message) -> Promise<void>               resolves when delivered, rejects with an Error that is safe to log
//
// Pure: nothing here touches the network, the disk or the clock (tests/node/test_notify_notifier.js).

const MAX_TEXT_LENGTH = 4096;               // what Telegram accepts for one message; the tightest of the channels
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;   // Telegram's limit for a photo
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0009\u000b-\u001f\u007f]/g;   // everything but "\n"

function isJpeg(buf) {
  return Buffer.isBuffer(buf) && buf.length > JPEG_MAGIC.length && buf.subarray(0, 3).equals(JPEG_MAGIC);
}

// Plain text that is safe for every channel: no control characters (a "\n" is kept) and not longer than
// MAX_TEXT_LENGTH. Channels send it as plain text, never as markup.
function cleanText(text) {
  const clean = String(text).replace(CONTROL_CHARS, ' ').trim();
  return clean.length > MAX_TEXT_LENGTH ? `${clean.slice(0, MAX_TEXT_LENGTH - 1)}…` : clean;
}

// Checks a message and returns the cleaned one. Throws a TypeError saying what is wrong, so a bug in the
// caller is found at once instead of being turned into a half-sent notification.
function normalizeMessage(message) {
  if (!message || typeof message !== 'object') throw new TypeError('a notification must be an object { text, image? }');
  if (typeof message.text !== 'string') throw new TypeError('a notification needs a text');
  const text = cleanText(message.text);
  if (text === '') throw new TypeError('a notification needs a text that is not empty');
  if (message.image === undefined || message.image === null) return { text };
  if (!isJpeg(message.image)) throw new TypeError('the notification image must be a JPEG (a Buffer)');
  if (message.image.length > MAX_IMAGE_BYTES) throw new TypeError(`the notification image is larger than ${MAX_IMAGE_BYTES} bytes`);
  return { text, image: message.image };
}

// The interface. A channel extends it, gives itself a `name` and implements deliver(message): the message
// it gets is already checked and cleaned, so a channel only has to carry it.
class Notifier {
  constructor(name) {
    if (new.target === Notifier) throw new TypeError('Notifier is an interface: use one of its implementations');
    this.name = name;
  }

  async send(message) {
    await this.deliver(normalizeMessage(message));
  }

  // eslint-disable-next-line no-unused-vars
  async deliver(message) {
    throw new Error(`${this.name} does not implement deliver()`);
  }
}

// Sends a message through every channel it holds. One failing channel never stops the others and send()
// never rejects for a delivery problem: it answers [{ name, ok, error? }], one entry per channel, so the
// caller can log what did not arrive. (An invalid message is the caller's bug and still throws.)
class MultiNotifier extends Notifier {
  constructor(notifiers = []) {
    super('multi');
    this.notifiers = notifiers.slice();
  }

  isEmpty() {
    return this.notifiers.length === 0;
  }

  names() {
    return this.notifiers.map((n) => n.name);
  }

  async send(message) {
    const clean = normalizeMessage(message);
    const results = await Promise.allSettled(this.notifiers.map((n) => n.send(clean)));
    return results.map((r, i) => (r.status === 'fulfilled'
      ? { name: this.notifiers[i].name, ok: true }
      : { name: this.notifiers[i].name, ok: false, error: r.reason && r.reason.message ? r.reason.message : String(r.reason) }));
  }
}

module.exports = { Notifier, MultiNotifier, normalizeMessage, cleanText, isJpeg, MAX_TEXT_LENGTH, MAX_IMAGE_BYTES };
