'use strict';

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const { TelegramNotifier, resolveTelegramConfig, buildMultipart, MAX_CAPTION_LENGTH } = require('../../nodejs/camera-relay/lib/notify/telegram');
const { createNotifier } = require('../../nodejs/camera-relay/lib/notify/index');

const TOKEN = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
const ok = { status: 200, body: '{"ok":true,"result":{}}' };

function fakePost(...answers) {
  const calls = [];
  const post = async (req) => {
    calls.push(req);
    const a = answers.length > 1 ? answers.shift() : answers[0];
    if (a instanceof Error) throw a;
    return a;
  };
  post.calls = calls;
  return post;
}
const config = { botToken: TOKEN, chatId: '-100123', timeoutMs: 1000 };

test('config: nothing set means the channel is simply unused, without a warning', () => {
  assertEqual(resolveTelegramConfig(undefined, {}), { config: null, warnings: [] });
  assertEqual(resolveTelegramConfig({ enabled: false, botToken: TOKEN, chatId: '1' }, {}), { config: null, warnings: [] });
});

test('config: a good block resolves; the environment wins over the file', () => {
  assertEqual(resolveTelegramConfig({ botToken: TOKEN, chatId: 42 }, {}).config, { botToken: TOKEN, chatId: '42', timeoutMs: 15000 });
  const env = { TELEGRAM_BOT_TOKEN: '987654321:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0', TELEGRAM_CHAT_ID: '@my_channel' };
  const c = resolveTelegramConfig({ botToken: TOKEN, chatId: 42 }, env).config;
  assertEqual([c.botToken, c.chatId], [env.TELEGRAM_BOT_TOKEN, '@my_channel']);
  assertEqual(resolveTelegramConfig({}, { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '-1' }).config.chatId, '-1');
});

test('config: a bad token or chat id switches the channel off with a warning that never repeats the secret', () => {
  for (const raw of [{ botToken: 'nope', chatId: '1' }, { chatId: '1' }, { botToken: TOKEN + '/../x', chatId: '1' }]) {
    const r = resolveTelegramConfig(raw, {});
    assertEqual(r.config, null);
    assertTrue(r.warnings.length === 1 && !r.warnings[0].includes(TOKEN));
  }
  for (const chatId of ['', 'abc', '12 34', '@a', '1;DROP', '--1']) {
    const r = resolveTelegramConfig({ botToken: TOKEN, chatId }, {});
    assertEqual([r.config, r.warnings.length], [null, 1]);
  }
});

test('buildMultipart: fields, then the file, then the closing boundary', () => {
  const { body, contentType } = buildMultipart({ chat_id: '5', caption: 'hi' }, { field: 'photo', filename: 't.jpg', type: 'image/jpeg', data: jpeg }, 'BND');
  assertEqual(contentType, 'multipart/form-data; boundary=BND');
  const text = body.toString('latin1');
  assertTrue(text.startsWith('--BND\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n5\r\n'));
  assertTrue(text.includes('name="caption"\r\n\r\nhi\r\n'));
  assertTrue(text.includes('name="photo"; filename="t.jpg"\r\nContent-Type: image/jpeg\r\n\r\n\xff\xd8\xff'));
  assertTrue(text.endsWith('\r\n--BND--\r\n'));
  assertTrue(body.includes(jpeg));
});

(async () => {
  const post = fakePost(ok);
  await new TelegramNotifier({ config, post }).send({ text: 'Person on cam1' });
  test('a text goes out as sendMessage, as plain text, to the fixed Telegram host', () => {
    assertEqual(post.calls.length, 1);
    const c = post.calls[0];
    assertEqual([c.hostname, c.path, c.headers['Content-Type'], c.timeoutMs], ['api.telegram.org', `/bot${TOKEN}/sendMessage`, 'application/json', 1000]);
    assertEqual(JSON.parse(c.body), { chat_id: '-100123', text: 'Person on cam1', disable_web_page_preview: true });
    assertTrue(!('parse_mode' in JSON.parse(c.body)));
  });

  const photoPost = fakePost(ok);
  await new TelegramNotifier({ config, post: photoPost, boundary: () => 'B' }).send({ text: 'Person on cam1', image: jpeg });
  test('a text with a thumbnail is ONE sendPhoto with the text as caption', () => {
    assertEqual(photoPost.calls.length, 1);
    const c = photoPost.calls[0];
    assertEqual([c.path, c.headers['Content-Type']], [`/bot${TOKEN}/sendPhoto`, 'multipart/form-data; boundary=B']);
    assertTrue(c.body.toString('latin1').includes('name="caption"\r\n\r\nPerson on cam1\r\n'));
    assertTrue(c.body.includes(jpeg));
  });

  const longPost = fakePost(ok);
  const long = 'x'.repeat(MAX_CAPTION_LENGTH + 1);
  await new TelegramNotifier({ config, post: longPost }).send({ text: long, image: jpeg });
  test('a text too long for a caption: the photo first (no caption), then the whole text as a message', () => {
    assertEqual(longPost.calls.map((c) => c.path.split('/').pop()), ['sendPhoto', 'sendMessage']);
    assertTrue(!longPost.calls[0].body.toString('latin1').includes('name="caption"'));
    assertEqual(JSON.parse(longPost.calls[1].body).text, long);
  });

  async function failure(answer, message = { text: 'hi' }) {
    try { await new TelegramNotifier({ config, post: fakePost(answer) }).send(message); } catch (e) { return e.message; }
    return null;
  }
  const refused = await failure({ status: 401, body: JSON.stringify({ ok: false, description: `Unauthorized ${TOKEN}` }) });
  const noJson = await failure({ status: 502, body: '<html>bad gateway</html>' });
  const okFalse = await failure({ status: 200, body: '{"ok":false}' });
  const netDown = await failure(new Error(`could not reach api.telegram.org: connect failed for /bot${TOKEN}/sendMessage`));
  const photoFails = await failure({ status: 400, body: '{"ok":false,"description":"wrong file"}' }, { text: 'hi', image: jpeg });
  test('every failure is an error that says what happened and never contains the bot token', () => {
    assertEqual(refused, 'Telegram sendMessage was refused: Unauthorized <token>');
    assertEqual(noJson, 'Telegram sendMessage was refused: HTTP 502');
    assertEqual(okFalse, 'Telegram sendMessage was refused: HTTP 200');
    assertEqual(netDown, 'Telegram sendMessage: could not reach api.telegram.org: connect failed for /bot<token>/sendMessage');
    assertEqual(photoFails, 'Telegram sendPhoto was refused: wrong file');
  });

  const calls = [];
  const factoryPost = async (r) => { calls.push(r); return ok; };
  const none = createNotifier(undefined, {}, { post: factoryPost });
  const bad = createNotifier({ telegram: { botToken: 'x', chatId: '1' } }, {}, { post: factoryPost });
  const good = createNotifier({ telegram: { botToken: TOKEN, chatId: '7' } }, {}, { post: factoryPost });
  const results = await good.notifier.send({ text: 'hello' });
  test('createNotifier: no channel, a refused channel (with a warning) and a working channel', () => {
    assertEqual([none.notifier.isEmpty(), none.warnings], [true, []]);
    assertEqual([bad.notifier.isEmpty(), bad.warnings.length], [true, 1]);
    assertEqual([good.notifier.names(), good.warnings, results], [['telegram'], [], [{ name: 'telegram', ok: true }]]);
    assertEqual(calls.length, 1);
  });

  summarize();
})();
