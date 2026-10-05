'use strict';

const { test, assertEqual, assertTrue, summarize } = require('./framework');
const { safeEqual, extractKey } = require('../../nodejs/camera-relay/lib/auth');

test('safeEqual: the right secret matches', () => {
  assertTrue(safeEqual('s3cret-key', 's3cret-key'));
});

test('safeEqual: wrong secrets do not match, whatever their length', () => {
  assertTrue(!safeEqual('s3cret-kez', 's3cret-key'));
  assertTrue(!safeEqual('s3cret', 's3cret-key'));
  assertTrue(!safeEqual('s3cret-key-and-more', 's3cret-key'));
  assertTrue(!safeEqual('', 's3cret-key'));
});

test('safeEqual: an EMPTY expected secret never matches (an unset camKey must not mean "no password")', () => {
  assertTrue(!safeEqual('', ''));
  assertTrue(!safeEqual('anything', ''));
});

test('safeEqual: non-strings never match', () => {
  assertTrue(!safeEqual(undefined, 'k'));
  assertTrue(!safeEqual(null, 'k'));
  assertTrue(!safeEqual(123, 'k'));
  assertTrue(!safeEqual(['k'], 'k'));
  assertTrue(!safeEqual('k', undefined));
});

test('extractKey: reads the X-Api-Key header, else ?key=, else empty', () => {
  assertEqual(extractKey({ headers: { 'x-api-key': 'hdr' }, query: { key: 'qry' } }), 'hdr', 'header wins');
  assertEqual(extractKey({ headers: {}, query: { key: 'qry' } }), 'qry');
  assertEqual(extractKey({ headers: {}, query: {} }), '');
  assertEqual(extractKey({ headers: {} }), '');
  assertEqual(extractKey({}), '');
});

test('extractKey: an array-valued ?key=a&key=b is not accepted as a key', () => {
  assertEqual(extractKey({ headers: {}, query: { key: ['a', 'b'] } }), '');
});

summarize();
