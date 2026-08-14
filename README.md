# lightsail-uptime

A serverless uptime monitor. On a schedule it fetches a website; if the site
does not answer with a `2xx`, it sleeps and retries a configurable number of
times, and when every attempt fails it calls `lightsail:RebootInstance` on the
Lightsail instance you name. Optionally it emails you through SNS when a reboot
happens.

Node.js 24 Lambda + EventBridge schedule, deployed with AWS SAM.

## How a run works

```
check URL ──2xx──> done (status: up)
    │
   not 2xx / network error / timeout
    │
    ├─ sleep RetrySleepSeconds, check again … up to RetryCount extra attempts
    │
    └─ all attempts failed
         ├─ last reboot within CooldownMinutes? ──> skip (status: cooldown-skip)
         ├─ lightsail:RebootInstance <InstanceName>
         ├─ record the reboot time in SSM Parameter Store
         └─ publish an SNS alert (if AlertEmail was set)
```

Defaults mean a down site triggers a reboot after 4 failed requests spread over
about 45 seconds, and no second reboot for 15 minutes.

## Parameters

| Parameter | Required | Default | Description |
| --- | --- | --- | --- |
| `WebsiteUrl` | yes | – | URL to monitor, e.g. `https://example.com` |
| `InstanceName` | yes | – | Lightsail instance to reboot, e.g. `YourInstanceName` |
| `AlertEmail` | no | `""` | Email for SNS alerts. Empty disables alerting entirely |
| `CheckEveryMinutes` | no | `5` | How often the check runs |
| `RetryCount` | no | `3` | Retries **after** the first failed check (3 → 4 requests total) |
| `RetrySleepSeconds` | no | `15` | Sleep between attempts |
| `RequestTimeoutSeconds` | no | `10` | Per-request timeout; a slower response counts as down |
| `CooldownMinutes` | no | `15` | Minimum gap between two reboots. `0` disables the guard |
| `FunctionTimeoutSeconds` | no | `300` | Lambda timeout — see the note below |
| `LogRetentionDays` | no | `30` | CloudWatch Logs retention |

**Keep the Lambda timeout above the worst-case run:**
`(RetryCount + 1) × RequestTimeoutSeconds + RetryCount × RetrySleepSeconds`.
With the defaults that is `4 × 10 + 3 × 15 = 85` seconds, comfortably under 300.
If you raise the retry count or the sleep, raise `FunctionTimeoutSeconds` too
(the Lambda maximum is 900).

## Deploy

Requires the [AWS SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html)
and credentials for the account that owns the Lightsail instance.

**Deploy the stack in the same region as the instance** — the function reboots
the instance in its own region.

```bash
sam build
sam deploy --guided
```

Or edit `parameter_overrides` in `samconfig.toml` and run:

```bash
sam build && sam deploy
```

A one-liner without touching the config file:

```bash
sam build
sam deploy \
  --stack-name lightsail-uptime \
  --region us-east-1 \
  --capabilities CAPABILITY_IAM \
  --resolve-s3 \
  --parameter-overrides \
      WebsiteUrl=https://example.com \
      InstanceName=YourInstanceName \
      AlertEmail=name@example.com \
      CheckEveryMinutes=5 \
      RetryCount=3 \
      RetrySleepSeconds=15
```

### Confirm the alert email

If you set `AlertEmail`, AWS sends a "Subscription Confirmation" message to that
address as soon as the stack is created. **Alerts are not delivered until you
click the confirm link.** Changing the address later means confirming again.

## What gets created

| Resource | Notes |
| --- | --- |
| Lambda function `<stack>-uptime-monitor` | Node.js 24, arm64, 256 MB |
| EventBridge schedule | `rate(CheckEveryMinutes minutes)` |
| IAM role | `lightsail:RebootInstance` (account+region scoped), `ssm:GetParameter`/`PutParameter` on this stack's parameter, `sns:Publish` on this stack's topic |
| SSM parameter `/lightsail-uptime/<stack>/last-reboot` | Epoch-ms timestamp backing the cooldown |
| SNS topic + email subscription | Only when `AlertEmail` is non-empty |
| CloudWatch log group | Retention from `LogRetentionDays` |

Note on IAM: Lightsail's `RebootInstance` cannot be scoped to an instance *name*
in an IAM policy, so the policy grants it on
`arn:aws:lightsail:<region>:<account>:Instance/*`. The instance actually
rebooted is fixed by the `InstanceName` parameter.

Note on the cooldown parameter: a **stack update resets it to `0`**, so the
first failure after a deploy can reboot even if a reboot just happened.

## Alerts

Two messages are sent, both only when `AlertEmail` is set:

- **Reboot triggered** — the URL, the instance, each failed attempt, and the
  cooldown window before another reboot is possible.
- **Reboot failed** — the `RebootInstance` call itself errored (permissions,
  wrong instance name, throttling). The function then fails the invocation so
  the error shows up in Lambda metrics.

A failing SNS publish is logged but never masks the reboot outcome.

## Local development

```bash
npm install     # dev-only: AWS SDK clients for local runs
npm test        # node:test, no network needed
sam validate --lint
```

The function has **no production dependencies** — `@aws-sdk/client-lightsail`,
`@aws-sdk/client-sns` and `@aws-sdk/client-ssm` are provided by the Node.js
Lambda runtime and are listed as devDependencies only so tests and local
invokes work. They are imported lazily, so the unit tests exercise the full
decision flow without the SDK or the network.

Invoke it locally against real AWS credentials:

```bash
cat > env.json <<'JSON'
{
  "UptimeFunction": {
    "WEBSITE_URL": "https://example.com",
    "INSTANCE_NAME": "YourInstanceName",
    "RETRY_COUNT": "3",
    "RETRY_SLEEP_SECONDS": "15",
    "REQUEST_TIMEOUT_SECONDS": "10",
    "COOLDOWN_MINUTES": "15",
    "COOLDOWN_PARAMETER_NAME": "",
    "ALERT_TOPIC_ARN": ""
  }
}
JSON

sam build && sam local invoke UptimeFunction --env-vars env.json
```

With `COOLDOWN_PARAMETER_NAME` empty the cooldown is skipped and no SSM calls
are made — but a genuinely down site **will** reboot the real instance.

## Layout

```
src/
  app.mjs       handler + decision flow (all AWS calls injectable)
  monitor.mjs   HTTP check, retry loop, cooldown maths — pure, no AWS
  config.mjs    environment parsing and validation
  aws.mjs       Lightsail / SNS / SSM wrappers, lazily imported
test/           node:test unit tests
template.yaml   SAM template
```

## Logs

Every run emits JSON lines to CloudWatch: `check_attempt`, `site_up`,
`site_down`, `reboot_triggered`, `reboot_skipped_cooldown`, `reboot_failed`,
`alert_published`, `alert_failed`. To find reboots:

```bash
aws logs filter-log-events \
  --log-group-name /aws/lambda/lightsail-uptime-uptime-monitor \
  --filter-pattern '"reboot_triggered"'
```
