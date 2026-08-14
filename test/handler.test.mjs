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

function harness({
  env = baseEnv,
  statuses = [200],
  lastRebootMs = 0,
  rebootError = null,
  publishError = null,
  readError = null,
  writeError = null
} = {}) {
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
      if (readError) throw readError;
      return lastRebootMs;
    },
    writeLastReboot: async (name, value) => {
      calls.writes.push({ name, value });
      if (writeError) throw writeError;
    },
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

test('a successful reboot reports the cooldown as recorded', async () => {
  const { handler } = harness({ statuses: [503] });
  const result = await handler();

  assert.equal(result.cooldownRecorded, true);
});

test('a failing cooldown write still reports the reboot and warns in the alert', async () => {
  const { handler, calls } = harness({
    statuses: [503],
    writeError: new Error('ThrottlingException')
  });

  const result = await handler();

  // The reboot succeeded, so the invocation must not fail.
  assert.equal(result.status, 'down');
  assert.equal(result.action, 'rebooted');
  assert.equal(result.cooldownRecorded, false);

  const logged = calls.logs.find((entry) => entry.event === 'cooldown_write_failed');
  assert.ok(logged, 'expected a cooldown_write_failed log entry');
  assert.match(logged.error, /ThrottlingException/);

  assert.equal(calls.alerts.length, 1);
  assert.match(calls.alerts[0].subject, /cooldown NOT recorded/);
  assert.match(calls.alerts[0].message, /WARNING/);
  assert.match(calls.alerts[0].message, /ThrottlingException/);
  assert.ok(!/No further reboot will be attempted/.test(calls.alerts[0].message));
});

test('a failing cooldown read fails open and still reboots', async () => {
  const { handler, calls } = harness({
    statuses: [503],
    readError: new Error('AccessDeniedException')
  });

  const result = await handler();

  assert.equal(result.action, 'rebooted');
  assert.deepEqual(calls.reboots, ['YourInstanceName']);

  const logged = calls.logs.find((entry) => entry.event === 'cooldown_read_failed');
  assert.ok(logged, 'expected a cooldown_read_failed log entry');
  assert.match(logged.error, /AccessDeniedException/);
});

test('a failing cooldown read does not stop a healthy check from being reported', async () => {
  const { handler, calls } = harness({ statuses: [200], readError: new Error('SSM down') });
  const result = await handler();

  // The read only happens on the down path, so a healthy run never touches it.
  assert.equal(result.status, 'up');
  assert.equal(calls.readParameter, undefined);
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
