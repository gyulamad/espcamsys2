'use strict';

// framework.js — a minimal, dependency-free unit test "framework" for the
// Node.js logic extracted from server.js. No Mocha/Jest/Tape — just a
// `test(name, fn)` runner and a couple of assertion helpers, run directly
// with plain `node`.
//
// Usage:
//   const { test, assertEqual, summarize } = require('./framework');
//   test('adds numbers', () => assertEqual(1 + 2, 3));
//   summarize(); // sets process.exitCode: 0 if all passed, 1 otherwise

let passCount = 0;
let failCount = 0;

function test(name, fn) {
  try {
    fn();
    passCount += 1;
    console.log(`[PASS] ${name}`);
  } catch (err) {
    failCount += 1;
    console.error(`[FAIL] ${name} -- ${err.message}`);
  }
}

// Deep-ish equality via JSON serialization — good enough for the plain
// objects/arrays/Dates these tests compare, and keeps this framework
// dependency-free (no need for Node's assert module or a real deep-equal).
function assertEqual(actual, expected, msg) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    throw new Error(`${msg ? msg + ': ' : ''}expected ${e} got ${a}`);
  }
}

function assertTrue(cond, msg) {
  if (!cond) throw new Error(msg || 'expected truthy value');
}

function assertThrows(fn, msg) {
  try {
    fn();
  } catch (err) {
    return;
  }
  throw new Error(msg || 'expected function to throw');
}

// The same for tests that wait for something (a file, a timer, a fetch): asyncTest() queues the test, runAsyncTests()
// runs the queue one test after the other, then summarizes. afterEach() runs after every test, passed or failed — to
// put back something the test replaced.
//   const { asyncTest, assertEqual, runAsyncTests } = require('./framework');
//   asyncTest('reads the file', async () => assertEqual(await read(), 'x'));
//   runAsyncTests();
const asyncQueue = [];

function asyncTest(name, fn) {
  asyncQueue.push([name, fn]);
}

async function runAsyncTests({ afterEach } = {}) {
  for (const [name, fn] of asyncQueue) {
    try {
      await fn();
      passCount += 1;
      console.log(`[PASS] ${name}`);
    } catch (err) {
      failCount += 1;
      console.error(`[FAIL] ${name} -- ${err.message}`);
    }
    if (afterEach) afterEach();
  }
  summarize();
}

function summarize() {
  console.log(`\n${passCount} passed, ${failCount} failed`);
  process.exitCode = failCount === 0 ? 0 : 1;
}

module.exports = { test, asyncTest, assertEqual, assertTrue, assertThrows, runAsyncTests, summarize };
