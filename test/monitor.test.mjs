import test from 'node:test';
import assert from 'node:assert/strict';

import {
  checkOnce,
  checkWithRetries,
  describeFailure,
  isCoolingDown,
  isHealthyStatus
} from '../src/monitor.mjs';

function responder(statuses) {
  const queue = [...statuses];
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    const next = queue.length > 1 ? queue.shift() : queue[0];
    if (next instanceof Error) throw next;
    return { status: next, body: null };
  };
  return { fetchImpl, calls };
}

function recordingSleep() {
  const sleeps = [];
  return { sleep: async (ms) => sleeps.push(ms), sleeps };
}

test('isHealthyStatus accepts only 2xx', () => {
  for (const status of [200, 201, 204, 299]) assert.equal(isHealthyStatus(status), true);
  for (const status of [199, 300, 301, 404, 500, 503]) assert.equal(isHealthyStatus(status), false);
});

test('checkOnce reports a healthy 200 with a GET', async () => {
  const { fetchImpl, calls } = responder([200]);
  const result = await checkOnce('https://example.com', { timeoutMs: 1000, fetchImpl });

  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.redirect, 'follow');
});

test('checkOnce treats a network error as down', async () => {
  const { fetchImpl } = responder([new Error('ECONNREFUSED')]);
  const result = await checkOnce('https://example.com', { timeoutMs: 1000, fetchImpl });

  assert.equal(result.ok, false);
  assert.equal(result.status, null);
  assert.match(result.error, /ECONNREFUSED/);
});

test('checkOnce reports a timeout when the request is aborted', async () => {
  const fetchImpl = (url, { signal }) =>
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        const err = new Error('aborted');
        err.name = 'AbortError';
        reject(err);
      });
    });

  const result = await checkOnce('https://example.com', { timeoutMs: 20, fetchImpl });
  assert.equal(result.ok, false);
  assert.match(result.error, /timed out after 20ms/);
});

test('a healthy first check performs no retries and no sleeping', async () => {
  const { fetchImpl, calls } = responder([200]);
  const { sleep, sleeps } = recordingSleep();

  const result = await checkWithRetries({
    url: 'https://example.com',
    retries: 3,
    sleepMs: 15000,
    timeoutMs: 1000,
    fetchImpl,
    sleep
  });

  assert.equal(result.ok, true);
  assert.equal(result.attempts.length, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test('retries: 3 means 4 requests with 3 sleeps in between', async () => {
  const { fetchImpl, calls } = responder([503]);
  const { sleep, sleeps } = recordingSleep();

  const result = await checkWithRetries({
    url: 'https://example.com',
    retries: 3,
    sleepMs: 15000,
    timeoutMs: 1000,
    fetchImpl,
    sleep
  });

  assert.equal(result.ok, false);
  assert.equal(calls.length, 4);
  assert.equal(result.attempts.length, 4);
  assert.deepEqual(sleeps, [15000, 15000, 15000]);
});

test('recovery on a later attempt stops the loop early', async () => {
  const { fetchImpl, calls } = responder([500, 502, 200]);
  const { sleep, sleeps } = recordingSleep();

  const result = await checkWithRetries({
    url: 'https://example.com',
    retries: 3,
    sleepMs: 15000,
    timeoutMs: 1000,
    fetchImpl,
    sleep
  });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 3);
  assert.deepEqual(sleeps, [15000, 15000]);
});

test('retries: 0 performs a single request', async () => {
  const { fetchImpl, calls } = responder([500]);
  const { sleep, sleeps } = recordingSleep();

  const result = await checkWithRetries({
    url: 'https://example.com',
    retries: 0,
    sleepMs: 15000,
    timeoutMs: 1000,
    fetchImpl,
    sleep
  });

  assert.equal(result.ok, false);
  assert.equal(calls.length, 1);
  assert.deepEqual(sleeps, []);
});

test('a 301 that resolves to 200 is healthy, a bare 301 is not', async () => {
  const { fetchImpl: followed } = responder([200]);
  assert.equal((await checkOnce('https://example.com', { timeoutMs: 100, fetchImpl: followed })).ok, true);

  const { fetchImpl: unfollowed } = responder([301]);
  assert.equal((await checkOnce('https://example.com', { timeoutMs: 100, fetchImpl: unfollowed })).ok, false);
});

test('isCoolingDown respects the window boundaries', () => {
  const cooldownMs = 15 * 60 * 1000;
  const lastRebootMs = 1_000_000;

  assert.equal(isCoolingDown({ lastRebootMs, nowMs: lastRebootMs + 1, cooldownMs }), true);
  assert.equal(isCoolingDown({ lastRebootMs, nowMs: lastRebootMs + cooldownMs - 1, cooldownMs }), true);
  assert.equal(isCoolingDown({ lastRebootMs, nowMs: lastRebootMs + cooldownMs, cooldownMs }), false);
  assert.equal(isCoolingDown({ lastRebootMs, nowMs: lastRebootMs + cooldownMs + 1, cooldownMs }), false);
});

test('isCoolingDown is false when there is no recorded reboot or no cooldown', () => {
  assert.equal(isCoolingDown({ lastRebootMs: 0, nowMs: 5_000, cooldownMs: 60_000 }), false);
  assert.equal(isCoolingDown({ lastRebootMs: NaN, nowMs: 5_000, cooldownMs: 60_000 }), false);
  assert.equal(isCoolingDown({ lastRebootMs: 1_000, nowMs: 5_000, cooldownMs: 0 }), false);
});

test('isCoolingDown treats a future timestamp as still cooling down', () => {
  assert.equal(isCoolingDown({ lastRebootMs: 10_000, nowMs: 5_000, cooldownMs: 60_000 }), true);
});

test('describeFailure summarises statuses and errors', () => {
  const summary = describeFailure([
    { attempt: 1, status: 503, error: null },
    { attempt: 2, status: null, error: 'timed out after 10000ms' }
  ]);
  assert.equal(summary, '#1: HTTP 503, #2: error (timed out after 10000ms)');
});
