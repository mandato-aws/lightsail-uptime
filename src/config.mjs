/** Read and validate the function configuration from environment variables. */

function requiredString(env, name) {
  const value = (env[name] ?? '').trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function intInRange(env, name, fallback, { min, max }) {
  const raw = (env[name] ?? '').trim();
  if (raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`Environment variable ${name} must be an integer between ${min} and ${max}, got "${raw}"`);
  }
  return value;
}

export function loadConfig(env = process.env) {
  return {
    url: requiredString(env, 'WEBSITE_URL'),
    instanceName: requiredString(env, 'INSTANCE_NAME'),
    retries: intInRange(env, 'RETRY_COUNT', 3, { min: 0, max: 20 }),
    sleepMs: intInRange(env, 'RETRY_SLEEP_SECONDS', 15, { min: 0, max: 300 }) * 1000,
    timeoutMs: intInRange(env, 'REQUEST_TIMEOUT_SECONDS', 10, { min: 1, max: 300 }) * 1000,
    cooldownMs: intInRange(env, 'COOLDOWN_MINUTES', 15, { min: 0, max: 1440 }) * 60 * 1000,
    cooldownParameterName: (env.COOLDOWN_PARAMETER_NAME ?? '').trim(),
    alertTopicArn: (env.ALERT_TOPIC_ARN ?? '').trim()
  };
}
