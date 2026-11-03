'use strict';

// runprocess.js — runs one command to the end and says what happened, never throwing: a missing
// program, a timeout and a crash are all just a result. Output is capped so a runaway child cannot fill
// the relay's memory. The only place the relay's scan feature touches child_process, so the logic around
// it (personscan.js, sorter.js) is tested without starting anything.

const { spawn } = require('child_process');

const DEFAULT_MAX_OUTPUT = 64 * 1024;

// -> Promise<{ code, signal, stdout, stderr, timedOut, spawnError }>
function runProcess(command, args, { env, timeoutMs, maxOutputBytes = DEFAULT_MAX_OUTPUT, spawnFn = spawn } = {}) {
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timedOut = false;
    let stdout = '';
    let stderr = '';
    let timer = null;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout, stderr, timedOut, spawnError: null, ...result });
    };
    const keep = (current, chunk) => (current.length >= maxOutputBytes ? current : (current + chunk).slice(0, maxOutputBytes));

    try {
      child = spawnFn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'], shell: false });
    } catch (err) {
      finish({ spawnError: err.message });
      return;
    }
    child.stdout.on('data', (d) => { stdout = keep(stdout, d.toString()); });
    child.stderr.on('data', (d) => { stderr = keep(stderr, d.toString()); });
    child.on('error', (err) => finish({ spawnError: err.message }));
    child.on('close', (code, signal) => finish({ code, signal }));
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, timeoutMs);
    }
  });
}

module.exports = { runProcess, DEFAULT_MAX_OUTPUT };
