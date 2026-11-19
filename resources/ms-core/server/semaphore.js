"use strict";

// R-02: bounded FIFO semaphore for native handshakes. Pure (no runtime globals) so it can be unit tested.
//  - never runs more than `limit` jobs at once;
//  - waiting jobs start in arrival order; a waiting job whose `isAbandoned()` is true is dropped without ever running;
//  - the queue is bounded: when full, `run` rejects with QUEUE_FULL instead of waiting;
//  - a running job that exceeds `taskTimeoutMs` frees its slot and `run` rejects with TASK_TIMEOUT
//    (the job itself can not be cancelled; its late result is ignored).
class SemaphoreError extends Error {
  constructor(code) { super(code); this.name = "SemaphoreError"; this.code = code; }
}

function createSemaphore({ limit, maxQueue, taskTimeoutMs, setTimer = setTimeout, clearTimer = clearTimeout }) {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("limit");
  if (!Number.isInteger(maxQueue) || maxQueue < 0) throw new RangeError("maxQueue");
  if (!Number.isFinite(taskTimeoutMs) || taskTimeoutMs <= 0) throw new RangeError("taskTimeoutMs");
  const queue = []; let running = 0;

  function pump() {
    while (running < limit && queue.length) {
      const entry = queue.shift();
      if (entry.isAbandoned()) { entry.reject(new SemaphoreError("ABANDONED")); continue; }
      start(entry);
    }
  }
  function start({ job, resolve, reject }) {
    running++;
    let released = false, timer = null;
    const release = () => { if (released) return false; released = true; running--; if (timer) clearTimer(timer); pump(); return true; };
    timer = setTimer(() => { if (release()) reject(new SemaphoreError("TASK_TIMEOUT")); }, taskTimeoutMs);
    Promise.resolve().then(job).then(
      value => { if (release()) resolve(value); },
      error => { if (release()) reject(error); });
  }
  function run(job, { isAbandoned = () => false } = {}) {
    return new Promise((resolve, reject) => {
      const entry = { job, resolve, reject, isAbandoned };
      if (running < limit && !queue.length) {
        if (isAbandoned()) { reject(new SemaphoreError("ABANDONED")); return; }
        start(entry); return;
      }
      if (queue.length >= maxQueue) { reject(new SemaphoreError("QUEUE_FULL")); return; }
      queue.push(entry);
    });
  }
  return { run, stats: () => ({ running, queued: queue.length }) };
}

module.exports = { createSemaphore, SemaphoreError };
