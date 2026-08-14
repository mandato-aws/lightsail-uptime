import test from 'node:test';
import assert from 'node:assert/strict';

import { createHandler } from '../src/app.mjs';

const baseEnv = {
  WEBSITE_URL: 'https://example.com',
  INSTANCE_NAME: 'YourInstanceName',
  RETRY_COUNT: '3',
  RETRY_SLEEP_SECONDS: '15',
  REQUEST_TIMEOUT_SECONDS: '10',
  COOLDOWN_MINUTES: '15',
  COOLDOWN_PARAMETER_NAME: '/lightsail-uptime/test/last-reboot',
  ALERT_TOPIC_ARN: 'arn:aws:sns:us-east-1:111122223333:alerts'
};

function harness({ env = baseEnv, statuses = [200], lastRebootMs = 0, rebootError = null, publishError = null } = {}) {
  const calls = { reboots: [], alerts: [], writes: [], fetches: [], sleeps: [], logs: [] };
  const queue = [...statuses];
  let clock = 1_000_000_000_000;

  const deps = {
    env,
    now: () => clock,
    fetchImpl: async (url) => {
      calls.fetches.push(url);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return { status: next, body: null };
    },
    sleep: async (ms) => {
      calls.sleeps.push(ms);
      clock += ms;
    },
    readLastReboot: async (name) => {
      calls.readParameter = name;
      return lastRebootMs;
    },
    writeLastReboot: async (name, value) => calls.writes.push({ name, value }),
    rebootInstance: async (instanceName) => {
      calls.reboots.push(instanceName);
      if (rebootError) throw rebootError;
    },
    publishAlert: async (payload) => {
      calls.alerts.push(payload);
      if (publishError) throw publishError;
    },
    logger: (entry) => calls.logs.push(entry)
  };

  return { handler: createHandler(deps), calls, currentTime: () => clock };
}

test('a healthy site does not reboot, alert or write state', async () => {
  const { handler, calls } = harness({ statuses: [200] });
  const result = await handler();

  assert.deepEqual(result, { status: 'up', url: 'https://example.com', attempts: 1, httpStatus: 200 });
  assert.deepEqual(calls.reboots, []);
  assert.deepEqual(calls.alerts, []);
  assert.deepEqual(calls.writes, []);
});

test('a site that recovers before the retries run out does not reboot', async () => {
  const { handler, calls } = harness({ statuses: [500, 200] });
  const result = await handler();

  assert.equal(result.status, 'up');
  assert.equal(calls.fetches.length, 2);
  assert.deepEqual(calls.reboots, []);
});

test('exhausting all retries reboots the instance, records the time and alerts', async () => {
  const { handler, calls, currentTime } = harness({ statuses: [503] });
  const result = await handler();

  assert.equal(result.status, 'down');
  assert.equal(result.action, 'rebooted');
  assert.equal(result.attempts, 4);
  assert.deepEqual(calls.fetches.length, 4);
  assert.deepEqual(calls.reboots, ['YourInstanceName']);
  assert.deepEqual(calls.writes, [
    { name: '/lightsail-uptime/test/last-reboot', value: currentTime() }
  ]);
  assert.equal(calls.alerts.length, 1);
  assert.match(calls.alerts[0].subject, /Rebooted YourInstanceName/);
  assert.match(calls.alerts[0].message, /HTTP 503/);
});

test('the cooldown window blocks a second reboot', async () => {
  const { handler, calls } = harness({ statuses: [503], lastRebootMs: 1_000_000_000_000 - 60_000 });
  const result = await handler();

  assert.equal(result.action, 'cooldown-skip');
  assert.ok(result.remainingSeconds > 0);
  assert.deepEqual(calls.reboots, []);
  assert.deepEqual(calls.writes, []);
  assert.deepEqual(calls.alerts, []);
});

test('a reboot older than the cooldown window allows a new reboot', async () => {
  const { handler, calls } = harness({
    statuses: [503],
    lastRebootMs: 1_000_000_000_000 - 16 * 60_000
  });
  await handler();

  assert.deepEqual(calls.reboots, ['YourInstanceName']);
});

test('a failing reboot alerts and rethrows without recording a cooldown', async () => {
  const rebootError = new Error('AccessDeniedException');
  const { handler, calls } = harness({ statuses: [503], rebootError });

  await assert.rejects(handler(), /AccessDeniedException/);
  assert.deepEqual(calls.writes, []);
  assert.equal(calls.alerts.length, 1);
  assert.match(calls.alerts[0].subject, /Reboot FAILED/);
  assert.match(calls.alerts[0].message, /AccessDeniedException/);
});

test('no alerts are attempted when no topic is configured', async () => {
  const env = { ...baseEnv, ALERT_TOPIC_ARN: '' };
  const { handler, calls } = harness({ env, statuses: [503] });
  const result = await handler();

  assert.equal(result.action, 'rebooted');
  assert.deepEqual(calls.alerts, []);
});

test('a failing alert does not mask a successful reboot', async () => {
  const { handler, calls } = harness({
    statuses: [503],
    publishError: new Error('Topic does not exist')
  });
  const result = await handler();

  assert.equal(result.action, 'rebooted');
  assert.ok(calls.logs.some((entry) => entry.event === 'alert_failed'));
});
