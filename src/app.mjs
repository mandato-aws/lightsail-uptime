import { loadConfig } from './config.mjs';
import { checkWithRetries, describeFailure, isCoolingDown } from './monitor.mjs';
import * as aws from './aws.mjs';

function log(entry) {
  console.log(JSON.stringify(entry));
}

/**
 * Build the Lambda handler. Every AWS interaction is injected so the whole
 * decision flow can be tested without the SDK or network.
 */
export function createHandler(deps = {}) {
  const {
    env = process.env,
    now = () => Date.now(),
    fetchImpl = fetch,
    sleep,
    rebootInstance = aws.rebootInstance,
    publishAlert = aws.publishAlert,
    readLastReboot = aws.readLastReboot,
    writeLastReboot = aws.writeLastReboot,
    logger = log
  } = deps;

  return async function handler() {
    const config = loadConfig(env);
    const startedAt = now();

    const { ok, attempts } = await checkWithRetries({
      url: config.url,
      retries: config.retries,
      sleepMs: config.sleepMs,
      timeoutMs: config.timeoutMs,
      fetchImpl,
      sleep,
      log: logger
    });

    if (ok) {
      const last = attempts[attempts.length - 1];
      logger({
        event: 'site_up',
        url: config.url,
        status: last.status,
        attempts: attempts.length,
        durationMs: now() - startedAt
      });
      return { status: 'up', url: config.url, attempts: attempts.length, httpStatus: last.status };
    }

    const failureDetail = describeFailure(attempts);
    logger({
      event: 'site_down',
      url: config.url,
      instanceName: config.instanceName,
      attempts: attempts.length,
      detail: failureDetail
    });

    const lastRebootMs = await readLastReboot(config.cooldownParameterName);
    const nowMs = now();
    if (isCoolingDown({ lastRebootMs, nowMs, cooldownMs: config.cooldownMs })) {
      const remainingSeconds = Math.ceil((lastRebootMs + config.cooldownMs - nowMs) / 1000);
      logger({
        event: 'reboot_skipped_cooldown',
        url: config.url,
        instanceName: config.instanceName,
        lastRebootAt: new Date(lastRebootMs).toISOString(),
        remainingSeconds
      });
      return {
        status: 'down',
        action: 'cooldown-skip',
        url: config.url,
        attempts: attempts.length,
        remainingSeconds
      };
    }

    try {
      await rebootInstance(config.instanceName);
    } catch (err) {
      logger({
        event: 'reboot_failed',
        instanceName: config.instanceName,
        error: String(err?.message ?? err)
      });
      await safePublish(publishAlert, logger, {
        topicArn: config.alertTopicArn,
        subject: `[Uptime] Reboot FAILED for ${config.instanceName}`,
        message: [
          `The website ${config.url} is DOWN and the Lightsail reboot could NOT be performed.`,
          '',
          `Instance: ${config.instanceName}`,
          `Checked at: ${new Date(startedAt).toISOString()}`,
          `Attempts (${attempts.length}): ${failureDetail}`,
          '',
          `Reboot error: ${String(err?.message ?? err)}`,
          '',
          'Manual intervention is required.'
        ].join('\n')
      });
      throw err;
    }

    const rebootedAt = now();
    await writeLastReboot(config.cooldownParameterName, rebootedAt);
    logger({ event: 'reboot_triggered', instanceName: config.instanceName, url: config.url });

    await safePublish(publishAlert, logger, {
      topicArn: config.alertTopicArn,
      subject: `[Uptime] Rebooted ${config.instanceName} - ${config.url} is down`,
      message: [
        `The website ${config.url} failed ${attempts.length} consecutive checks.`,
        `A reboot of Lightsail instance "${config.instanceName}" has been requested.`,
        '',
        `Checked at: ${new Date(startedAt).toISOString()}`,
        `Rebooted at: ${new Date(rebootedAt).toISOString()}`,
        `Attempts (${attempts.length}): ${failureDetail}`,
        '',
        `No further reboot will be attempted for ${config.cooldownMs / 60000} minute(s).`
      ].join('\n')
    });

    return {
      status: 'down',
      action: 'rebooted',
      url: config.url,
      instanceName: config.instanceName,
      attempts: attempts.length
    };
  };
}

/** A failing alert must not mask the outcome of the reboot itself. */
async function safePublish(publishAlert, logger, payload) {
  if (!payload.topicArn) return;
  try {
    await publishAlert(payload);
    logger({ event: 'alert_published', subject: payload.subject });
  } catch (err) {
    logger({ event: 'alert_failed', error: String(err?.message ?? err) });
  }
}

export const handler = createHandler();
