'use strict';

// scanqueue.js — the recordings waiting to be checked for a person, one at a time (a Pi has little CPU to
// spare, and the cameras still need serving). Remembers what each waiting / running job is, and the reason
// the last attempt of a clip failed, so the file list can show "processing…" or the error next to a clip.
//
// The work itself is injected (`work(job) -> Promise<outcome>`), which keeps this free of disk and processes:
// tests/node/test_scanqueue.js drives it with a fake.

const MAX_REMEMBERED_ERRORS = 200;

class ScanQueue {
  // work(job) -> outcome; onFinished(job, outcome) is told every outcome (the relay logs them)
  constructor({ work, onFinished = () => {} }) {
    this.work = work;
    this.onFinished = onFinished;
    this.waiting = [];
    this.current = null;
    this.failures = new Map();   // key -> reason, oldest first
    this.draining = false;
  }

  // Adds a job unless the same key is already waiting or running. -> 'queued' | 'duplicate'
  enqueue(key, payload) {
    if (this.has(key)) return 'duplicate';
    this.failures.delete(key);   // a new attempt wipes the old failure
    this.waiting.push({ key, payload });
    this.drain();
    return 'queued';
  }

  has(key) {
    return (this.current !== null && this.current.key === key) || this.waiting.some((j) => j.key === key);
  }

  // null | { state: 'queued' } | { state: 'processing' } | { state: 'error', reason }
  stateOf(key) {
    if (this.current !== null && this.current.key === key) return { state: 'processing' };
    if (this.waiting.some((j) => j.key === key)) return { state: 'queued' };
    if (this.failures.has(key)) return { state: 'error', reason: this.failures.get(key) };
    return null;
  }

  size() {
    return this.waiting.length + (this.current ? 1 : 0);
  }

  remember(key, outcome) {
    if (outcome.state !== 'error') return;
    this.failures.set(key, outcome.reason);
    if (this.failures.size > MAX_REMEMBERED_ERRORS) this.failures.delete(this.failures.keys().next().value);
  }

  async drain() {
    if (this.draining) return;
    this.draining = true;
    while (this.waiting.length > 0) {
      this.current = this.waiting.shift();
      const job = this.current;
      let outcome;
      try {
        outcome = await this.work(job);
      } catch (e) {
        outcome = { state: 'error', reason: `unexpected failure: ${e && e.message ? e.message : e}` };
      }
      this.remember(job.key, outcome);
      this.current = null;
      try {
        this.onFinished(job, outcome);
      } catch (e) {
        // reporting must never stop the queue
      }
    }
    this.draining = false;
  }
}

module.exports = { ScanQueue, MAX_REMEMBERED_ERRORS };
