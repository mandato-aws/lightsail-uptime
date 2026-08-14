/**
 * Thin wrappers over the AWS SDK clients.
 *
 * The SDK is imported lazily so that unit tests (and any code path that never
 * touches AWS) can import this module without the SDK being installed. At
 * runtime the clients come from the Node.js Lambda runtime, which ships AWS
 * SDK v3; locally they come from devDependencies.
 */

let lightsailClient;
let snsClient;
let ssmClient;

async function getLightsail() {
  if (!lightsailClient) {
    const { LightsailClient } = await import('@aws-sdk/client-lightsail');
    lightsailClient = new LightsailClient({});
  }
  return lightsailClient;
}

async function getSns() {
  if (!snsClient) {
    const { SNSClient } = await import('@aws-sdk/client-sns');
    snsClient = new SNSClient({});
  }
  return snsClient;
}

async function getSsm() {
  if (!ssmClient) {
    const { SSMClient } = await import('@aws-sdk/client-ssm');
    ssmClient = new SSMClient({});
  }
  return ssmClient;
}

export async function rebootInstance(instanceName) {
  const [client, { RebootInstanceCommand }] = await Promise.all([
    getLightsail(),
    import('@aws-sdk/client-lightsail')
  ]);
  return client.send(new RebootInstanceCommand({ instanceName }));
}

export async function publishAlert({ topicArn, subject, message }) {
  if (!topicArn) return null;
  const [client, { PublishCommand }] = await Promise.all([getSns(), import('@aws-sdk/client-sns')]);
  return client.send(
    new PublishCommand({
      TopicArn: topicArn,
      // SNS rejects subjects over 100 chars or containing newlines.
      Subject: subject.replace(/\s+/g, ' ').slice(0, 100),
      Message: message
    })
  );
}

/** Epoch milliseconds of the last reboot, or 0 when unknown. */
export async function readLastReboot(parameterName) {
  if (!parameterName) return 0;
  const [client, { GetParameterCommand }] = await Promise.all([getSsm(), import('@aws-sdk/client-ssm')]);
  try {
    const result = await client.send(new GetParameterCommand({ Name: parameterName }));
    const value = Number(result.Parameter?.Value);
    return Number.isFinite(value) ? value : 0;
  } catch (err) {
    if (err?.name === 'ParameterNotFound') return 0;
    throw err;
  }
}

export async function writeLastReboot(parameterName, epochMs) {
  if (!parameterName) return null;
  const [client, { PutParameterCommand }] = await Promise.all([getSsm(), import('@aws-sdk/client-ssm')]);
  return client.send(
    new PutParameterCommand({
      Name: parameterName,
      Value: String(epochMs),
      Type: 'String',
      Overwrite: true
    })
  );
}
