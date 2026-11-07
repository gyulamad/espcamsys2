'use strict';

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const { TelegramNotifier, resolveTelegramConfig, buildMultipart, MAX_CAPTION_LENGTH } = require('../../nodejs/camera-relay/lib/notify/telegram');
const { createNotifier } = require('../../nodejs/camera-relay/lib/notify/index');
const { MultiNotifier } = require('../../nodejs/camera-relay/lib/notify/notifier');

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
const config = { botToken: TOKEN, chatIds: ['-100123'], timeoutMs: 1000 };
const TOKEN2 = '987654321:BBHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0';

test('config: nothing set means the channel is simply unused, without a warning', () => {
  assertEqual(resolveTelegramConfig(undefined, {}), { config: null, warnings: [] });
  assertEqual(resolveTelegramConfig({ enabled: false, botToken: TOKEN, chatId: '1' }, {}), { config: null, warnings: [] });
});

test('config: a good block resolves; the environment wins over the file', () => {
  assertEqual(resolveTelegramConfig({ botToken: TOKEN, chatId: 42 }, {}).config, { botToken: TOKEN, chatIds: ['42'], timeoutMs: 15000 });
  const env = { TELEGRAM_BOT_TOKEN: TOKEN2, TELEGRAM_CHAT_ID: '@my_channel' };
  const c = resolveTelegramConfig({ botToken: TOKEN, chatId: 42 }, env).config;
  assertEqual([c.botToken, c.chatIds], [TOKEN2, ['@my_channel']]);
  assertEqual(resolveTelegramConfig({}, { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '-1' }).config.chatIds, ['-1']);
});

test('config: a bad token switches the channel off with a warning that never repeats the secret', () => {
  for (const raw of [{ botToken: 'nope', chatId: '1' }, { chatId: '1' }, { botToken: TOKEN + '/../x', chatId: '1' }]) {
    const r = resolveTelegramConfig(raw, {});
    assertEqual(r.config, null);
    assertTrue(r.warnings.length === 1 && !r.warnings[0].includes(TOKEN));
  }
});

test('config: chatId may be an array — everybody in it is a recipient, in order, once', () => {
  assertEqual(resolveTelegramConfig({ botToken: TOKEN, chatId: ['111', 222, '-1001234567890', '@family_cams'] }, {}).config.chatIds, ['111', '222', '-1001234567890', '@family_cams']);
  assertEqual(resolveTelegramConfig({ botToken: TOKEN, chatId: ['111', 111, ' 111 ', '222'] }, {}).config.chatIds, ['111', '222']);
  assertEqual(resolveTelegramConfig({ botToken: TOKEN, chatId: [42] }, {}).warnings, []);
});

test('config: TELEGRAM_CHAT_ID may be a comma-separated list (spaces and empty entries are ignored) and wins over the file', () => {
  const env = { TELEGRAM_CHAT_ID: ' 111 , -222,, @family_cams ,' };
  assertEqual(resolveTelegramConfig({ botToken: TOKEN, chatId: ['999'] }, env).config.chatIds, ['111', '-222', '@family_cams']);
  assertEqual(resolveTelegramConfig({}, { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '1,2' }).config.chatIds, ['1', '2']);
});

test('config: a bad chat id is left out with a warning (by position, not by value); the valid ones still work', () => {
  const r = resolveTelegramConfig({ botToken: TOKEN, chatId: ['111', 'abc', '222', '1;DROP'] }, {});
  assertEqual(r.config.chatIds, ['111', '222']);
  assertEqual(r.warnings.length, 2);
  assertTrue(r.warnings[0].includes('#2') && r.warnings[1].includes('#4'));
  assertTrue(r.warnings.every((w) => !w.includes('1;DROP') && !w.includes(TOKEN)));
});

test('config: no usable chat id at all switches the channel off, with a warning', () => {
  for (const chatId of ['', [], ['abc'], 'abc', '12 34', '@a', '1;DROP', '--1', ['x', 'y'], null, undefined]) {
    const r = resolveTelegramConfig({ botToken: TOKEN, chatId }, {});
    assertEqual(r.config, null, JSON.stringify(chatId));
    assertTrue(r.warnings.length >= 1 && r.warnings.every((w) => !w.includes(TOKEN)), JSON.stringify(chatId));
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
    assertEqual(refused, 'chat -100123: Telegram sendMessage was refused: Unauthorized <token>');
    assertEqual(noJson, 'chat -100123: Telegram sendMessage was refused: HTTP 502');
    assertEqual(okFalse, 'chat -100123: Telegram sendMessage was refused: HTTP 200');
    assertEqual(netDown, 'chat -100123: Telegram sendMessage: could not reach api.telegram.org: connect failed for /bot<token>/sendMessage');
    assertEqual(photoFails, 'chat -100123: Telegram sendPhoto was refused: wrong file');
  });

  // ── several recipients ──
  const multi = { botToken: TOKEN, chatIds: ['111', '-222', '@family_cams'], timeoutMs: 1000 };
  const textPost = fakePost(ok);
  await new TelegramNotifier({ config: multi, post: textPost }).send({ text: 'Person on cam1' });
  const photoMulti = fakePost(ok);
  await new TelegramNotifier({ config: multi, post: photoMulti, boundary: () => 'B' }).send({ text: 'Person on cam1', image: jpeg });
  const longMulti = fakePost(ok);
  await new TelegramNotifier({ config: { ...multi, chatIds: ['111', '222'] }, post: longMulti }).send({ text: 'x'.repeat(MAX_CAPTION_LENGTH + 1), image: jpeg });
  test('a text goes to every chat, one request each, each addressed to its own chat', () => {
    assertEqual(textPost.calls.map((c) => JSON.parse(c.body).chat_id).sort(), ['-222', '111', '@family_cams']);
    assertTrue(textPost.calls.every((c) => JSON.parse(c.body).text === 'Person on cam1'));
  });
  test('a thumbnail goes to every chat as its own photo, with that chat id in the form', () => {
    const ids = photoMulti.calls.map((c) => /name="chat_id"\r\n\r\n([^\r]*)\r\n/.exec(c.body.toString('latin1'))[1]).sort();
    assertEqual(ids, ['-222', '111', '@family_cams']);
    assertTrue(photoMulti.calls.every((c) => c.path.endsWith('/sendPhoto') && c.body.includes(jpeg)));
  });
  test('a long text with a thumbnail: each chat gets its photo and then its text', () => {
    for (const id of ['111', '222']) {
      const mine = longMulti.calls.filter((c) => (c.path.endsWith('/sendMessage') ? JSON.parse(c.body).chat_id : /name="chat_id"\r\n\r\n([^\r]*)/.exec(c.body.toString('latin1'))[1]) === id);
      assertEqual(mine.map((c) => c.path.split('/').pop()), ['sendPhoto', 'sendMessage']);
    }
  });

  // chat 222 blocked the bot; 111 and 333 are fine
  const partial = async (chatIds, bodyFor) => {
    const calls = [];
    const post = async (req) => { calls.push(req); const id = JSON.parse(req.body).chat_id; return bodyFor(id); };
    let error = null;
    try { await new TelegramNotifier({ config: { ...config, chatIds }, post }).send({ text: 'hi' }); } catch (e) { error = e.message; }
    return { error, reached: calls.map((c) => JSON.parse(c.body).chat_id).sort() };
  };
  const blocked = (id) => (id === '222' ? { status: 403, body: '{"ok":false,"description":"Forbidden: bot was blocked by the user"}' } : ok);
  const some = await partial(['111', '222', '333'], blocked);
  const allBad = await partial(['222', '444'], () => ({ status: 400, body: '{"ok":false,"description":"Bad Request: chat not found"}' }));
  const allGood = await partial(['111', '333'], () => ok);
  test('one chat that cannot be reached does not keep the others from getting the message, and the error names it', () => {
    assertEqual(some.reached, ['111', '222', '333']);
    assertEqual(some.error, 'delivered to 2 of 3 chats; chat 222: Telegram sendMessage was refused: Forbidden: bot was blocked by the user');
  });
  test('when no chat can be reached, every failure is listed', () => {
    assertEqual(allBad.error, 'delivered to 0 of 2 chats; chat 222: Telegram sendMessage was refused: Bad Request: chat not found; chat 444: Telegram sendMessage was refused: Bad Request: chat not found');
    assertEqual([allGood.error, allGood.reached], [null, ['111', '333']]);
  });
  const viaMulti = await (async () => {
    const post = async (req) => (JSON.parse(req.body).chat_id === '222' ? { status: 403, body: '{"ok":false,"description":"Forbidden"}' } : ok);
    return new MultiNotifier([new TelegramNotifier({ config: { ...config, chatIds: ['111', '222'] }, post })]).send({ text: 'hi' });
  })();
  test('through the MultiNotifier a partial failure is one failed telegram entry with the reason (so it is logged)', () => {
    assertEqual(viaMulti, [{ name: 'telegram', ok: false, error: 'delivered to 1 of 2 chats; chat 222: Telegram sendMessage was refused: Forbidden' }]);
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
