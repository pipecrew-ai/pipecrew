# Terraform — Known Anti-Patterns

Seed list for `type: terraform` repos.

## Apply is never the agent's call

- `terraform apply` changes cloud state and cannot be reliably rolled back from inside a coding agent. The deliverable is always the `plan`, reviewed by a human.
- Even `terraform apply -target=...` is dangerous — it bypasses dependency resolution and can leave infrastructure in an inconsistent state.

## Destroys are irreversible for stateful resources

- Plan output containing `will be destroyed` for an RDS instance, S3 bucket with `force_destroy=false`, DynamoDB table, or EBS volume means data loss. Stop and report — do not commit unless explicitly authorized.
- `# forces replacement` destroys and recreates — for stateful resources this means rebuild from backups (if any). Common causes: changing `name`/`bucket`/`identifier` on resources that don't allow it; changing `availability_zone`.
- `lifecycle { prevent_destroy = true }` on critical resources blocks the plan entirely if a destroy is attempted — copy this pattern onto new critical resources.

## `count` vs `for_each`

- `count` uses positional indices — removing the MIDDLE element of a `count = length(var.list)` list destroys-and-recreates every resource after the removed one.
- Use `for_each` with a map when the set can change over time. Example: `for_each = { for svc in var.services : svc.name => svc }`.

## Hard-coded environment values

- Embedding `"arn:aws:iam::123456789012:role/..."` or `"us-east-1"` breaks cross-env deployments. Use `data "aws_caller_identity" "current"` and `data "aws_region" "current"` to derive them.
- Region-specific resources (Lambda, Cognito, some IAM) must be in the provider's region; cross-region references require an aliased provider.

## Provider configuration

- Sub-module resources don't automatically inherit the parent's provider aliases. Pass explicitly: `providers = { aws = aws.alt_region }` when the module uses a non-default provider.
- Major provider version upgrades (e.g., hashicorp/aws v4 → v5) always include breaking argument changes. They are always a separate PR, never a side-effect of a feature.

## Tagging

- AWS provider v4+ supports `default_tags` at the provider block. If the repo uses this, don't duplicate those tags on each resource — it causes perpetual diff.
- Required tag keys typically include `Environment`, `Service`, `Owner`, `ManagedBy = "terraform"`. Grep existing resources to learn the required set; missing a required key fails the convention.

## State drift

- Terraform plans against state, not cloud reality. Manual changes in the console cause drift that plan won't see until `terraform plan -refresh-only` or a full `terraform apply -refresh-only`.
- Flag suspiciously empty plans when you know you made a change — usually means you edited in the wrong directory/workspace.

## IAM least privilege

- `"Action": "s3:*"` or `"Action": "dynamodb:*"` on a feature branch is a security-review fail. Scope to the specific actions the consumer actually uses.
- Resource ARNs: a policy allowing `s3:PutObject` on `arn:aws:s3:::my-bucket` (without `/*`) applies to the BUCKET, not its objects. You need `arn:aws:s3:::my-bucket/*` for object-level actions.
- Trust policies on IAM roles are often over-scoped (`"Principal": "*"`). Narrow to the specific service or account.

## Cross-stack references

- `terraform_remote_state` requires read access to the producing stack's state file. A plan that succeeds locally but fails in CI is usually a state-access permission issue.
- An output not re-declared after a refactor disappears — consumers referencing it break. Add `output` blocks back before removing the producing resource.

## CI-friendly validation

- `terraform init -backend=false` validates HCL without touching real backend credentials. Use this for agent/CI validation runs.
- `terraform fmt -recursive .` catches style drift; CI should run it in check mode (`-check`) and fail on diff.
- `terraform validate` exits non-zero for syntax and type errors — always run before `plan`.

## Variable defaults

- A variable declared without a `default` MUST be set at plan time — either via `-var`, `-var-file`, `TF_VAR_...` env, or `terraform.tfvars`. Forgetting one in a workspace-specific tfvars file causes plan failure on that workspace only.
- Sensitive variables should be marked `sensitive = true` so their values don't appear in plan output.
