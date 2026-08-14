# lightsail-uptime

A serverless uptime monitor. On a schedule it fetches a website; if the site
does not answer with a `2xx`, it sleeps and retries a configurable number of
times, and when every attempt fails it calls `lightsail:RebootInstance` on the
Lightsail instance you name. Optionally it emails you through SNS when a reboot
happens.

Node.js 22 Lambda + EventBridge schedule, deployed with AWS SAM.

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
| Lambda function `<stack>-uptime-monitor` | Node.js 22, arm64, 256 MB |
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

The reboot alert says `(cooldown NOT recorded)` in its subject when the
timestamp could not be written — see below.

A failing SNS publish is logged but never masks the reboot outcome.

## When Parameter Store misbehaves

The cooldown is a guard against reboot loops, not a gate on recovery, so both
SSM failure modes degrade the guard rather than the recovery:

- **Read fails** — logged as `cooldown_read_failed`, and the run proceeds as if
  the instance had never been rebooted. An SSM outage therefore cannot leave a
  down site unrecovered.
- **Write fails after a successful reboot** — logged as `cooldown_write_failed`
  and reported as `cooldownRecorded: false`, but the invocation still succeeds,
  because the corrective action did work. The alert carries an explicit warning
  that the next failed check can reboot again before the window has elapsed.

Alarm on either event if you want to know the guard is degraded:

```bash
aws logs filter-log-events \
  --log-group-name /aws/lambda/lightsail-uptime-uptime-monitor \
  --filter-pattern '"cooldown_write_failed"'
```

## Run it locally

Settings live in a **`.env` file at the repo root**. Node 20.6+ reads it
natively via `--env-file`, so there is no `dotenv` dependency and the deployed
function still ships zero production dependencies. `.env` is gitignored;
`.env.example` is committed and documents every variable.

```bash
cp .env.example .env      # then edit WEBSITE_URL and INSTANCE_NAME
npm install               # dev-only: AWS SDK clients
npm run local             # one check, dry-run
```

`src/local.mjs` is the runner. It invokes the **real handler**, so what you see
locally is what runs in Lambda — the same retry loop, cooldown logic and log
events.

**It is dry-run by default:** the HTTP check really happens, but reboot, SNS
and SSM calls are printed instead of made, and no AWS credentials are needed.

```
$ npm run local
dry-run: AWS calls are printed, not made (pass --reboot to go live)

09:41:02 attempt 1/4 HTTP 503 233ms
09:41:17 attempt 2/4 HTTP 503 34ms
09:41:32 attempt 3/4 HTTP 503 34ms
09:41:47 attempt 4/4 HTTP 503 45ms
09:41:47 DOWN https://example.com after 4 attempt(s) - #1: HTTP 503, ...
         [dry-run] would reboot Lightsail instance "YourInstanceName"
```

Flags override `.env` for one run, which is the quick way to test a config
before committing to it:

```bash
npm run local -- --url https://example.com --retries 1 --sleep 2
npm run local -- --json          # raw JSON lines, exactly as CloudWatch sees them
npm run local -- --watch         # keep checking on the CHECK_EVERY_MINUTES interval
npm run local -- --help
npm start                        # same thing, if you are already inside src/
```

Exit codes are `0` site up, `1` site down, `2` configuration or AWS error — so
`npm run local` works in a shell pipeline too.

To exercise the real AWS calls, add credentials (`AWS_REGION` / `AWS_PROFILE`
in `.env`) and pass `--reboot`. **This reboots the instance for real** when the
site is down:

```bash
npm run local -- --reboot
```

Fill in `COOLDOWN_PARAMETER_NAME` and `ALERT_TOPIC_ARN` (from the `sam deploy`
outputs) to also exercise the cooldown and the email alert. Left empty, the
cooldown is skipped and no alert is sent.

Other useful commands:

```bash
npm test                  # node:test, no network or credentials needed
sam validate --lint
sam build && sam local invoke UptimeFunction --env-vars env.json   # in a Lambda container
```

The function has **no production dependencies** — `@aws-sdk/client-lightsail`,
`@aws-sdk/client-sns` and `@aws-sdk/client-ssm` are provided by the Node.js
Lambda runtime and are listed as devDependencies in the root `package.json`
only so local runs and tests work (Node resolves them upward from `src/`).
They are imported lazily, so the unit tests exercise the full decision flow
without the SDK or the network, and `sam build` packages no `node_modules`.

## Layout

```
.env.example    every setting, documented; copy to .env
src/
  app.mjs       handler + decision flow (all AWS calls injectable)
  monitor.mjs   HTTP check, retry loop, cooldown maths — pure, no AWS
  config.mjs    environment parsing and validation
  aws.mjs       Lightsail / SNS / SSM wrappers, lazily imported
  local.mjs     local CLI runner (not used by the deployed handler)
  package.json  function manifest: no production dependencies
test/           node:test unit tests
template.yaml   SAM template
```

## Logs

Every run emits JSON lines to CloudWatch: `check_attempt`, `site_up`,
`site_down`, `reboot_triggered`, `reboot_skipped_cooldown`, `reboot_failed`,
`cooldown_read_failed`, `cooldown_write_failed`, `alert_published`,
`alert_failed`. To find reboots:

```bash
aws logs filter-log-events \
  --log-group-name /aws/lambda/lightsail-uptime-uptime-monitor \
  --filter-pattern '"reboot_triggered"'
```
