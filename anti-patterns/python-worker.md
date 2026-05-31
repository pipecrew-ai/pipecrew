# Python Worker — Known Anti-Patterns

Seed list for `type: python-worker` repos — Lambda handlers, SQS/SNS/Kinesis/Kafka consumers, Celery tasks, scheduled jobs.

## Idempotency

- Events will be delivered more than once. Every handler must be idempotent: `INSERT ... ON CONFLICT DO NOTHING`, DynamoDB `ConditionExpression: attribute_not_exists(...)`, or aws-lambda-powertools `@idempotent_function`.
- Idempotency key = **business key** (event_id, order_id), NOT the SQS `MessageId` — the latter changes on redelivery in some flows.

## Partial failure (SQS batch, Kinesis)

- Returning a naked success from `lambda_handler` on a batch event marks ALL records as processed. Use `ReportBatchItemFailures` with `batchItemFailures: [{ "itemIdentifier": "..." }]` to retry only failed records.
- Failing to set `FunctionResponseTypes: [ReportBatchItemFailures]` in the SAM/CDK event source mapping means the partial-failure response is ignored — the whole batch retries.
- `BatchProcessor` from aws-lambda-powertools handles this correctly — use it when the repo already has powertools as a dependency.

## SNS → SQS envelope

- When SNS publishes to SQS, the SQS message body is a JSON-wrapped SNS envelope. The real event is in `json.loads(record['body'])['Message']` (another JSON string — parse twice). Forgetting this produces cryptic `KeyError` on event fields.

## Kinesis ordering

- Events with the same business key are only ordered within the same shard if you set the partition key to that business key. The default (often random) partition key gives no ordering guarantee.
- Kinesis retains events for 24h by default — if a consumer is down for longer, events are lost. Check retention period before declaring the worker "complete."

## Client reuse

- Creating `boto3.client('s3')` inside `lambda_handler` creates a new client per invocation — slow cold starts, wastes connection reuse. Create at module scope.
- Database connections follow the same rule, but with a twist: Lambda may reuse containers, so a module-scope DB connection must tolerate being reused across invocations (ping-before-use, connection pooler) or it accumulates stale connections.

## Celery

- `task.delay(...)` doesn't accept a `task_id` — can't pass an idempotency key. Use `task.apply_async(args=(...), task_id=event.event_id)` when idempotency matters.
- `retry=True` with `max_retries=N` must be set on the task decorator AND the retry must be raised via `self.retry(...)` or a `Retry` exception — otherwise unhandled exceptions are sent to the failure queue immediately.
- Celery result backend (Redis / RDS) is often the hidden bottleneck — if unused, disable it (`ignore_result=True` per task).

## Schema evolution

- A producer writing with schema v2 to a consumer still on schema v1 silently drops new fields. Always read the contract repo's current schema; never cache a locally pinned copy when the producer is out of your control.
- Avro logical-type `timestamp-millis` is UTC. Always deserialize with `datetime.fromtimestamp(ms/1000, tz=timezone.utc)` — never use naive datetimes.

## DLQ + retry config

- SQS-triggered Lambdas need a DLQ configured on the SOURCE QUEUE with `maxReceiveCount` ≥ 3 (typical). A DLQ on the Lambda itself catches only invocation errors, not message-level failures.
- Log when a message lands in DLQ so on-call has a pointer. A silent DLQ is a data loss you discover in a retro.

## Observability

- Lambda cold-start init failures are retried forever WITHOUT your business logic running, which means zero CloudWatch invocation metrics for the failing function. Wrap init in try/except + log, so the error surfaces.
- Structured logs must include `event_id` (or equivalent business key) so you can trace an event end-to-end across services.
- AWS Powertools `@tracer.capture_lambda_handler` + `@logger.inject_lambda_context` are the repo-conventional wrappers — don't roll your own tracer/logger if powertools is already a dependency.

## Deployment descriptor

- A Lambda handler function with no event source mapping never runs. After adding a handler, verify the SAM template / CDK stack / Serverless YAML wires it to the right trigger.
- IAM policies on the handler must be tight — `s3:*` or `dynamodb:*` on a feature branch is a security-review fail. Scope to the specific actions and resource ARNs needed.
