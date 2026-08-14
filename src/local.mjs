#!/usr/bin/env node
/**
 * Local runner for the uptime monitor.
 *
 * Reads the same environment variables the deployed Lambda uses, so a local
 * run exercises the real handler and not a copy of it. Settings come from a
 * .env file (see .env.example) loaded by Node itself:
 *
 *   node --env-file=.env src/local.mjs
 *   npm run local            (from the repo root)
 *   npm start                (from src/)
 *
 * The HTTP check is always real. Reboot, SNS and SSM calls are stubbed unless
 * --reboot is passed, so the default run cannot touch your instance.
 */
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

import { createHandler } from './app.mjs';
import * as aws from './aws.mjs';

const USAGE = `
Usage: node --env-file=.env src/local.mjs [options]

Options:
  --url <url>            Website to check            (env WEBSITE_URL)
  --instance <name>      Lightsail instance name     (env INSTANCE_NAME)
  --retries <n>          Retries after the first try (env RETRY_COUNT)
  --sleep <seconds>      Sleep between attempts      (env RETRY_SLEEP_SECONDS)
  --timeout <seconds>    Per-request timeout         (env REQUEST_TIMEOUT_SECONDS)
  --cooldown <minutes>   Minimum gap between reboots (env COOLDOWN_MINUTES)
  --reboot               Perform REAL AWS calls (reboot / SNS / SSM).
                         Without it every AWS call is printed, not made.
  --watch                Keep running on the schedule interval
  --every <minutes>      Interval for --watch         (env CHECK_EVERY_MINUTES, default 5)
  --json                 Print raw JSON log lines, as CloudWatch sees them
  --help                 Show this message

Exit codes: 0 site up, 1 site down, 2 configuration or AWS error.
`.trimStart();

const { values } = parseArgs({
  options: {
    url: { type: 'string' },
    instance: { type: 'string' },
    retries: { type: 'string' },
    sleep: { type: 'string' },
    timeout: { type: 'string' },
    cooldown: { type: 'string' },
    reboot: { type: 'boolean', default: false },
    watch: { type: 'boolean', default: false },
    every: { type: 'string' },
    json: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false }
  },
  allowPositionals: false
});

if (values.help) {
  console.log(USAGE);
  process.exit(0);
}

function truthy(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value ?? '').toLowerCase());
}

// CLI flags win over the .env file, which wins over the shell environment.
const env = { ...process.env };
const overrides = {
  WEBSITE_URL: values.url,
  INSTANCE_NAME: values.instance,
  RETRY_COUNT: values.retries,
  RETRY_SLEEP_SECONDS: values.sleep,
  REQUEST_TIMEOUT_SECONDS: values.timeout,
  COOLDOWN_MINUTES: values.cooldown
};
for (const [key, value] of Object.entries(overrides)) {
  if (value !== undefined) env[key] = value;
}

const live = values.reboot || truthy(env.LOCAL_ALLOW_REBOOT);

const COLOURS = {
  reset: '\u001b[0m',
  dim: '\u001b[2m',
  red: '\u001b[31m',
  green: '\u001b[32m',
  yellow: '\u001b[33m'
};
const paint = (colour, text) => (process.stdout.isTTY ? `${COLOURS[colour]}${text}${COLOURS.reset}` : text);

function prettyLog(entry) {
  const time = new Date().toISOString().slice(11, 19);
  const stamp = paint('dim', time);

  switch (entry.event) {
    case 'check_attempt': {
      const outcome = entry.ok
        ? paint('green', `HTTP ${entry.status}`)
        : paint('red', entry.status === null ? `error (${entry.error})` : `HTTP ${entry.status}`);
      return console.log(`${stamp} attempt ${entry.attempt}/${entry.totalAttempts} ${outcome} ${paint('dim', `${entry.durationMs}ms`)}`);
    }
    case 'site_up':
      return console.log(`${stamp} ${paint('green', 'UP')} ${entry.url} after ${entry.attempts} attempt(s)`);
    case 'site_down':
      return console.log(`${stamp} ${paint('red', 'DOWN')} ${entry.url} after ${entry.attempts} attempt(s) - ${entry.detail}`);
    case 'reboot_skipped_cooldown':
      return console.log(`${stamp} ${paint('yellow', 'COOLDOWN')} last reboot ${entry.lastRebootAt}, ${entry.remainingSeconds}s remaining`);
    case 'reboot_triggered':
      return console.log(`${stamp} ${paint('yellow', 'REBOOT')} ${entry.instanceName}`);
    case 'reboot_failed':
      return console.log(`${stamp} ${paint('red', 'REBOOT FAILED')} ${entry.instanceName} - ${entry.error}`);
    case 'alert_published':
      return console.log(`${stamp} alert sent: ${entry.subject}`);
    case 'alert_failed':
      return console.log(`${stamp} ${paint('red', 'alert failed')} - ${entry.error}`);
    default:
      return console.log(`${stamp} ${JSON.stringify(entry)}`);
  }
}

const logger = values.json ? (entry) => console.log(JSON.stringify(entry)) : prettyLog;

function announce(text) {
  if (values.json) {
    console.log(JSON.stringify({ event: 'dry_run', action: text }));
    return;
  }
  console.log(paint('dim', `         [dry-run] would ${text}`));
}

const awsDeps = live
  ? {
      rebootInstance: aws.rebootInstance,
      publishAlert: aws.publishAlert,
      readLastReboot: aws.readLastReboot,
      writeLastReboot: aws.writeLastReboot
    }
  : {
      rebootInstance: async (instanceName) => announce(`reboot Lightsail instance "${instanceName}"`),
      publishAlert: async ({ subject }) => announce(`publish SNS alert "${subject}"`),
      // A dry run needs no credentials, so the cooldown reads as "never rebooted".
      readLastReboot: async () => 0,
      // Mirrors the real wrapper: nothing to write when no parameter is configured.
      writeLastReboot: async (name, epochMs) => {
        if (name) announce(`write ${epochMs} to SSM parameter ${name}`);
      }
    };

const handler = createHandler({ env, logger, ...awsDeps });

async function runOnce() {
  try {
    const result = await handler();
    if (!values.json) {
      console.log(paint('dim', `         result: ${JSON.stringify(result)}`));
    }
    return result.status === 'up' ? 0 : 1;
  } catch (err) {
    console.error(paint('red', `error: ${err?.message ?? err}`));
    if (/Missing required environment variable/.test(String(err?.message))) {
      console.error(paint('dim', 'hint: cp .env.example .env, fill it in, then run with --env-file=.env'));
    }
    return 2;
  }
}

const banner = live
  ? paint('yellow', 'LIVE mode: reboot, SNS and SSM calls will really be made')
  : paint('dim', 'dry-run: AWS calls are printed, not made (pass --reboot to go live)');
console.log(`${banner}\n`);

if (!values.watch) {
  process.exitCode = await runOnce();
} else {
  const minutes = Number(values.every ?? env.CHECK_EVERY_MINUTES ?? 5);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.error('error: --every must be a positive number of minutes');
    process.exit(2);
  }
  console.log(paint('dim', `watching every ${minutes} minute(s); Ctrl-C to stop\n`));

  process.on('SIGINT', () => {
    console.log('\nstopped');
    process.exit(0);
  });

  while (true) {
    await runOnce();
    console.log('');
    await delay(minutes * 60_000);
  }
}
