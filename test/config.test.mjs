import test from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig } from '../src/config.mjs';

const required = {
  WEBSITE_URL: 'https://example.com',
  INSTANCE_NAME: 'YourInstanceName'
};

test('optional settings fall back to the documented defaults', () => {
  const config = loadConfig({ ...required });

  assert.equal(config.url, 'https://example.com');
  assert.equal(config.instanceName, 'YourInstanceName');
  assert.equal(config.retries, 3);
  assert.equal(config.sleepMs, 15_000);
  assert.equal(config.timeoutMs, 10_000);
  assert.equal(config.cooldownMs, 15 * 60_000);
  assert.equal(config.alertTopicArn, '');
  assert.equal(config.cooldownParameterName, '');
});

test('values are read from the environment and converted to milliseconds', () => {
  const config = loadConfig({
    ...required,
    RETRY_COUNT: '5',
    RETRY_SLEEP_SECONDS: '30',
    REQUEST_TIMEOUT_SECONDS: '20',
    COOLDOWN_MINUTES: '10',
    COOLDOWN_PARAMETER_NAME: '/lightsail-uptime/demo/last-reboot',
    ALERT_TOPIC_ARN: 'arn:aws:sns:us-east-1:111122223333:demo'
  });

  assert.equal(config.retries, 5);
  assert.equal(config.sleepMs, 30_000);
  assert.equal(config.timeoutMs, 20_000);
  assert.equal(config.cooldownMs, 600_000);
  assert.equal(config.cooldownParameterName, '/lightsail-uptime/demo/last-reboot');
  assert.equal(config.alertTopicArn, 'arn:aws:sns:us-east-1:111122223333:demo');
});

test('missing required variables throw', () => {
  assert.throws(() => loadConfig({ INSTANCE_NAME: 'x' }), /WEBSITE_URL/);
  assert.throws(() => loadConfig({ WEBSITE_URL: 'https://example.com' }), /INSTANCE_NAME/);
  assert.throws(() => loadConfig({ ...required, INSTANCE_NAME: '   ' }), /INSTANCE_NAME/);
});

test('out-of-range and non-numeric values throw', () => {
  assert.throws(() => loadConfig({ ...required, RETRY_COUNT: 'many' }), /RETRY_COUNT/);
  assert.throws(() => loadConfig({ ...required, RETRY_COUNT: '-1' }), /RETRY_COUNT/);
  assert.throws(() => loadConfig({ ...required, REQUEST_TIMEOUT_SECONDS: '0' }), /REQUEST_TIMEOUT_SECONDS/);
  assert.throws(() => loadConfig({ ...required, COOLDOWN_MINUTES: '2000' }), /COOLDOWN_MINUTES/);
});

test('a cooldown of zero is allowed and disables the guard', () => {
  assert.equal(loadConfig({ ...required, COOLDOWN_MINUTES: '0' }).cooldownMs, 0);
});
