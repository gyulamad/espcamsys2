'use strict';

const { test, assertEqual, assertTrue, assertThrows, summarize } = require('./framework');
const { Notifier, MultiNotifier, normalizeMessage, cleanText, isJpeg, MAX_TEXT_LENGTH, MAX_IMAGE_BYTES } = require('../../nodejs/camera-relay/lib/notify/notifier');

const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);

class Recording extends Notifier {
  constructor(name, fail) { super(name); this.got = []; this.fail = fail; }
  async deliver(m) { if (this.fail) throw new Error(this.fail); this.got.push(m); }
}

test('isJpeg: only a Buffer that starts with the JPEG signature and has a body', () => {
  assertTrue(isJpeg(jpeg));
  assertEqual([isJpeg(Buffer.from([0xff, 0xd8, 0xff])), isJpeg(Buffer.from('GIF89a')), isJpeg('text'), isJpeg(null)], [false, false, false, false]);
});

test('cleanText: control characters become spaces, newlines stay, the text is trimmed and capped', () => {
  assertEqual(cleanText('  a\u0000b\u001b[31m\nc\td  '), 'a b [31m\nc d');
  const long = cleanText('x'.repeat(MAX_TEXT_LENGTH + 50));
  assertEqual([long.length, long.endsWith('…')], [MAX_TEXT_LENGTH, true]);
});

test('normalizeMessage: a text alone, or a text with a JPEG', () => {
  assertEqual(normalizeMessage({ text: ' hi ' }), { text: 'hi' });
  assertEqual(normalizeMessage({ text: 'hi', image: null }), { text: 'hi' });
  assertTrue(normalizeMessage({ text: 'hi', image: jpeg }).image === jpeg);
});

test('normalizeMessage: refuses what is not a usable message', () => {
  for (const bad of [null, undefined, 'text', 5, {}, { text: 5 }, { text: '   ' }, { text: '\u0000' },
    { text: 'x', image: 'not a buffer' }, { text: 'x', image: Buffer.from('GIF89a....') }]) {
    assertThrows(() => normalizeMessage(bad), JSON.stringify(bad));
  }
  assertThrows(() => normalizeMessage({ text: 'x', image: Buffer.concat([jpeg, Buffer.alloc(MAX_IMAGE_BYTES)]) }));
});

(async () => {
  assertThrows(() => new Notifier('x'));
  class Lazy extends Notifier { constructor() { super('lazy'); } }
  let lazyMessage = '';
  try { await new Lazy().send({ text: 'hi' }); } catch (e) { lazyMessage = e.message; }
  test('Notifier is an interface: it cannot be created, and a channel without deliver() fails clearly', () => {
    assertThrows(() => new Notifier('x'));
    assertEqual(lazyMessage, 'lazy does not implement deliver()');
  });

  const n = new Recording('rec');
  await n.send({ text: ' a\u0000b ' });
  let thrown = null;
  try { await n.send({ text: '' }); } catch (e) { thrown = e; }
  test('Notifier.send hands the channel the cleaned message, and refuses a bad one before the channel sees it', () => {
    assertEqual(n.got, [{ text: 'a b' }]);
    assertTrue(thrown instanceof TypeError);
  });

  const a = new Recording('a'); const b = new Recording('b', 'boom'); const c = new Recording('c');
  const multi = new MultiNotifier([a, b, c]);
  const results = await multi.send({ text: 'hello', image: jpeg });
  test('MultiNotifier: every channel gets the message, one failure does not stop the rest, nothing rejects', () => {
    assertEqual(multi.names(), ['a', 'b', 'c']);
    assertEqual(results, [{ name: 'a', ok: true }, { name: 'b', ok: false, error: 'boom' }, { name: 'c', ok: true }]);
    assertEqual([a.got.length, c.got.length], [1, 1]);
    assertTrue(a.got[0].image === jpeg);
  });

  const odd = { name: 'odd', send: () => Promise.reject('plain string') };
  const oddResults = await new MultiNotifier([odd]).send({ text: 'x' });
  test('MultiNotifier: a channel that rejects with a non-Error is reported as text', () => {
    assertEqual(oddResults, [{ name: 'odd', ok: false, error: 'plain string' }]);
  });

  const empty = new MultiNotifier();
  const emptyResults = await empty.send({ text: 'x' });
  let emptyThrown = null;
  try { await empty.send({}); } catch (e) { emptyThrown = e; }
  test('MultiNotifier: empty is allowed (no channel configured), and an invalid message still throws', () => {
    assertEqual([empty.isEmpty(), emptyResults], [true, []]);
    assertTrue(emptyThrown instanceof TypeError);
  });

  test('MultiNotifier keeps its own copy of the channel list', () => {
    const list = [new Recording('a')];
    const copy = new MultiNotifier(list);
    list.push(new Recording('b'));
    assertEqual(copy.names(), ['a']);
  });

  summarize();
})();
