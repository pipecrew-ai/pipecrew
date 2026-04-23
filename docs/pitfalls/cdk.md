# AWS CDK — Known Pitfalls

Seed list for `type: cdk` repos.

## Resource cross-references

- Any SQS queue, S3 bucket, or DynamoDB table referenced by config in a service repo MUST be declared in the infra repo. An application YAML reference to `abvi-contracts-bucket-{stage}` that isn't in `lib/abvi-s3-buckets-stack.ts` → `NoSuchBucket` at runtime.
- Cross-stack refs should use CDK exports (`Fn.importValue`) or construct-level `ssm.StringParameter` lookups — never hardcoded ARNs.

## IAM least-privilege

- `s3:*` on `*` Resource is a common default that violates least-privilege. Every ECS task role or Lambda role should be scoped to specific bucket ARNs it needs.
- `bucket.grantRead(function)` / `queue.grantSendMessages(function)` are the idiomatic helpers — prefer them over raw policy statements.

## Runtime pinning

- Lambda Python / Node runtimes pinned to deprecated versions (`PYTHON_3_10` etc.) silently accumulate EOL risk. Update at every feature touch.
- Bundling image must match the function runtime — referenced in two places, easy to diverge.

## Version / dependency drift

- `aws-cdk-lib` version drift across sibling CDK repos (one at 2.172, another at 2.232) causes L2 construct-signature mismatches. Sync at feature start.
- `constructs` major version must align with `aws-cdk-lib`.

## Config centralisation

- Hardcoding bucket names / queue names inline in stack files scales poorly. A `conf.ts` that centralises resource names per stage is standard in mature repos — replicate the pattern.
- Directory convention (`bin/` vs `cdk/` vs `stacks/`) — sibling CDK repos should agree, otherwise `cdk deploy` commands diverge.

## DLQ / encryption / observability defaults

- SQS queues without explicit `encryption: QueueEncryption.SQS_MANAGED` default to unencrypted.
- DLQ wiring (`maxReceiveCount: 3`) must be asserted in tests — easy to accidentally drop.
- Lambda without `logRetention` defaults to never-expiring logs.

## Test coverage

- Stack tests should assert: resource counts, critical IAM grants, event-source wirings, env-var presence. Not just "the stack synths".
