import { setTimeout as delay } from 'node:timers/promises';

/** A response is healthy only when the final status is 2xx. */
export function isHealthyStatus(status) {
  return Number.isInteger(status) && status >= 200 && status <= 299;
}

/**
 * Perform a single GET against the URL.
 * Redirects are followed (fetch default) and the final status decides.
 * Network, DNS, TLS and timeout errors all count as "down".
 */
export async function checkOnce(url, { timeoutMs, fetchImpl = fetch } = {}) {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': 'lightsail-uptime/1.0 (+https://github.com/mandato-aws/lightsail-uptime)',
        accept: '*/*',
        'cache-control': 'no-cache'
      }
    });

    // Drain the body so the socket is released before the next attempt.
    if (response.body) {
      try {
        await response.arrayBuffer();
      } catch {
        // A truncated body does not change the verdict; the status already decided it.
      }
    }

    return {
      ok: isHealthyStatus(response.status),
      status: response.status,
      error: null,
      durationMs: Date.now() - startedAt
    };
  } catch (err) {
    const timedOut = err?.name === 'AbortError' || err?.name === 'TimeoutError';
    return {
      ok: false,
      status: null,
      error: timedOut ? `timed out after ${timeoutMs}ms` : String(err?.message ?? err),
      durationMs: Date.now() - startedAt
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Check the URL once, then retry `retries` more times, sleeping `sleepMs`
 * between attempts. Returns as soon as one attempt is healthy.
 */
export async function checkWithRetries({
  url,
  retries,
  sleepMs,
  timeoutMs,
  fetchImpl = fetch,
  sleep = delay,
  log = () => {}
}) {
  const attempts = [];
  const totalAttempts = retries + 1;

  for (let attempt = 1; attempt <= totalAttempts; attempt += 1) {
    const result = await checkOnce(url, { timeoutMs, fetchImpl });
    attempts.push({ attempt, ...result });
    log({ event: 'check_attempt', url, attempt, totalAttempts, ...result });

    if (result.ok) {
      return { ok: true, attempts };
    }
    if (attempt < totalAttempts) {
      await sleep(sleepMs);
    }
  }

  return { ok: false, attempts };
}

/** True while the cooldown window since the last reboot has not elapsed. */
export function isCoolingDown({ lastRebootMs, nowMs, cooldownMs }) {
  if (!Number.isFinite(lastRebootMs) || lastRebootMs <= 0) return false;
  if (cooldownMs <= 0) return false;
  const elapsed = nowMs - lastRebootMs;
  // A timestamp in the future (clock skew, manual edit) is treated as still cooling down.
  if (elapsed < 0) return true;
  return elapsed < cooldownMs;
}

/** One-line human summary of why the site was judged down. */
export function describeFailure(attempts) {
  return attempts
    .map(({ attempt, status, error }) =>
      `#${attempt}: ${status === null ? `error (${error})` : `HTTP ${status}`}`)
    .join(', ');
}
