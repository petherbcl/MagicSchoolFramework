"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createSemaphore, SemaphoreError } = require("../server/semaphore");

const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
const make = (overrides = {}) => createSemaphore({ limit: 2, maxQueue: 4, taskTimeoutMs: 1000, ...overrides });
const tick = () => new Promise(resolve => setImmediate(resolve));

test("jobs start in FIFO order and never exceed the concurrency limit", async () => {
  const sem = make({ limit: 2, maxQueue: 10 }), started = [], gates = [], done = [];
  let running = 0, peak = 0;
  for (let i = 0; i < 6; i++) {
    const gate = deferred(); gates.push(gate);
    done.push(sem.run(async () => { started.push(i); running++; peak = Math.max(peak, running); await gate.promise; running--; return i; }));
  }
  await tick(); assert.deepEqual(started, [0, 1]); assert.deepEqual(sem.stats(), { running: 2, queued: 4 });
  for (let i = 0; i < 6; i++) { gates[i].resolve(); await tick(); }
  assert.deepEqual(await Promise.all(done), [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(started, [0, 1, 2, 3, 4, 5]); assert.equal(peak, 2); assert.deepEqual(sem.stats(), { running: 0, queued: 0 });
});

test("waiting jobs that were abandoned are dropped without running", async () => {
  const sem = make({ limit: 1 }), gate = deferred(), ran = [];
  const first = sem.run(() => gate.promise);
  let gone = false;
  const abandoned = sem.run(async () => { ran.push("abandoned"); }, { isAbandoned: () => gone });
  const alive = sem.run(async () => { ran.push("alive"); return "ok"; });
  gone = true; gate.resolve(); await first;
  await assert.rejects(abandoned, { code: "ABANDONED" });
  assert.equal(await alive, "ok"); assert.deepEqual(ran, ["alive"]); assert.deepEqual(sem.stats(), { running: 0, queued: 0 });
});

test("an abandoned job is not even started when a slot is free", async () => {
  const sem = make(); let ran = false;
  await assert.rejects(sem.run(async () => { ran = true; }, { isAbandoned: () => true }), { code: "ABANDONED" });
  assert.equal(ran, false); assert.equal(sem.stats().running, 0);
});

test("a full queue refuses explicitly and recovers afterwards", async () => {
  const sem = make({ limit: 1, maxQueue: 2 }), gate = deferred();
  const jobs = [sem.run(() => gate.promise), sem.run(async () => "b"), sem.run(async () => "c")];
  await assert.rejects(sem.run(async () => "d"), err => err instanceof SemaphoreError && err.code === "QUEUE_FULL");
  assert.deepEqual(sem.stats(), { running: 1, queued: 2 });
  gate.resolve("a"); assert.deepEqual(await Promise.all(jobs), ["a", "b", "c"]);
  assert.equal(await sem.run(async () => "e"), "e");
});

test("a job that exceeds the timeout frees its slot and is refused", async () => {
  const sem = make({ limit: 1, taskTimeoutMs: 20 }), never = deferred();
  const stuck = sem.run(() => never.promise), next = sem.run(async () => "next");
  await assert.rejects(stuck, { code: "TASK_TIMEOUT" });
  assert.equal(await next, "next"); assert.deepEqual(sem.stats(), { running: 0, queued: 0 });
  never.resolve("late"); await tick(); assert.deepEqual(sem.stats(), { running: 0, queued: 0 }); // a late result never double-releases
});

test("the slot is always released: failures, synchronous throws and success", async () => {
  const sem = make({ limit: 1 });
  await assert.rejects(sem.run(async () => { throw new Error("async"); }), { message: "async" });
  await assert.rejects(sem.run(() => { throw new Error("sync"); }), { message: "sync" });
  assert.equal(await sem.run(async () => "ok"), "ok"); assert.deepEqual(sem.stats(), { running: 0, queued: 0 });
});

test("invalid options are rejected", () => {
  assert.throws(() => createSemaphore({ limit: 0, maxQueue: 1, taskTimeoutMs: 1 }), RangeError);
  assert.throws(() => createSemaphore({ limit: 1, maxQueue: -1, taskTimeoutMs: 1 }), RangeError);
  assert.throws(() => createSemaphore({ limit: 1, maxQueue: 1, taskTimeoutMs: 0 }), RangeError);
});
