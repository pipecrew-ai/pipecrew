# Machine-readable file formats

Phase outputs in PipeCrew are markdown files written for humans first, but several pieces of data inside them are extracted programmatically by downstream phases. This document defines the structured blocks that downstream consumers depend on, so the producer (typically the `solution-architect`) and the consumer (a phase orchestrator) agree on schema.

## How structured blocks work

Each structured block sits inside a normal HTML-comment delimited section (`<!-- BEGIN X -->` … `<!-- END X -->`) and contains a ```` ```json ```` fenced code block as its first element. Prose follows the JSON for human context — the JSON is the source of truth.

To extract a block:

```bash
node {plugin_dir}/scripts/extract-block.js {markdown-file} {BLOCK_NAME}
```

The script emits the parsed JSON to stdout (compact, single line). Exit code 0 = success. See `scripts/extract-block.js` for other exit codes.

The orchestrator (an LLM) can read the script's stdout as-is — JSON is its natural input format. No `jq` filtering required; the LLM picks the fields it needs.

---

## Defined block schemas

### `AFFECTED_SERVICES`

**Producer**: `solution-architect` (Phase 2 design output)
**Consumers**: Phase 3 (spec edit), Phase 4 (plan), Phase 5 (build), Phase 5.5 (review), Phase 7 (report)
**File**: `{run_dir}/outputs/phase-2-architecture.md`
**Canonical example**: [`templates/blocks/affected-services.example.json`](../templates/blocks/affected-services.example.json) — the single source of truth for the structure. Update that file when the schema changes; this doc only carries the field reference table below.

**Field reference:**

| Field | Type | Notes |
|-------|------|-------|
| `services[].name` | string | Must match a key in `config.services`. |
| `services[].spec_policy` | enum | `api-first` → has OpenAPI spec; `code-first` → contract is in `API_DESIGN` block; `no-api` → event-driven worker. |
| `services[].endpoints_added` | array | HTTP services only. Empty for workers. |
| `services[].endpoints_modified` | array | HTTP services only. |
| `services[].handlers_added` | array of strings | Worker services only (handler function names). |
| `services[].fr_ids` | array of strings | Functional requirement IDs from Phase 1 that this service owns. |
| `services[].ec_ids` | array of strings | Edge case IDs from Phase 1 that this service owns. |
| `spec_edit_order` | array of names | Order to edit specs when multiple `api-first` services are affected. |
| `frontend_required` | boolean | Drives Phase 5b skip decision. |
| `mock_required` | boolean | Drives Phase 5c skip decision. |

---

### `API_DESIGN`

**Producer**: `solution-architect` (Phase 2 design output)
**Consumers**: Phase 3b (openapi-spec-editor — enumerates endpoints to edit), Phase 4 (task generation — selects per-service endpoint subsets), Phase 5 (backend implementers — read via task file)
**File**: `{run_dir}/outputs/phase-2-architecture.md`
**Canonical example**: [`templates/blocks/api-design.example.json`](../templates/blocks/api-design.example.json) — the structured INDEX. Detailed per-endpoint schemas (request/response bodies for code-first, event-handler details for no-api) live in the prose under each service's section.

**Field reference:**

| Field | Type | Notes |
|-------|------|-------|
| `services[].name` | string | Must match a key in `config.services`. |
| `services[].spec_policy` | enum | `api-first` / `code-first` / `no-api` — same as in `AFFECTED_SERVICES`. |
| `services[].endpoints[]` | array | HTTP services (api-first / code-first) only. Empty for `no-api`. |
| `services[].endpoints[].method` | string | HTTP method (GET / POST / PUT / PATCH / DELETE). |
| `services[].endpoints[].path` | string | URL path with `{param}` placeholders. |
| `services[].endpoints[].change_kind` | enum | `added` / `modified` / `removed`. |
| `services[].endpoints[].summary` | string | One-line description. For `code-first`, points readers to the inline contract in the prose. |
| `services[].endpoints[].fr_ids` | array of strings | FRs this endpoint implements. |
| `services[].endpoints[].ec_ids` | array of strings | ECs this endpoint handles. |
| `services[].handlers[]` | array | `no-api` worker services only. Empty for HTTP services. |
| `services[].handlers[].name` | string | Handler function name. |
| `services[].handlers[].trigger_source` | string | e.g., `sqs:order-events`, `kafka:user-events`, `schedule:hourly`. |
| `services[].handlers[].event_schema_ref` | string | Path or name of the event schema (typically lives in a contract repo). |
| `services[].handlers[].fr_ids` | array of strings | FRs this handler implements. |
| `services[].handlers[].ec_ids` | array of strings | ECs this handler handles. |
| `cross_service_calls[]` | array | Sync or async calls between services this feature introduces. |
| `cross_service_calls[].from` | string | Caller service name. |
| `cross_service_calls[].to` | string | Callee service name. |
| `cross_service_calls[].purpose` | string | One-line reason for the call. |

The JSON serves as the addressable index for orchestration (which endpoints to edit, which handlers to implement, which FRs map where). Detailed schemas — full request/response bodies, status codes, error shapes for `code-first` endpoints; delivery semantics, batch config, downstream targets, failure modes for `no-api` handlers — remain in the prose under each service section. Consumers extract the JSON to enumerate; they read the prose for details.

---

### `DATA_MODEL`

**Producer**: `solution-architect` (Phase 2 design output)
**Consumers**: Phase 4 (task generation — selects per-service entity/DB changes), Phase 5 (backend implementers — read via task file), Phase 6 (assessor — checks migrations are present)
**File**: `{run_dir}/outputs/phase-2-architecture.md`
**Canonical example**: [`templates/blocks/data-model.example.json`](../templates/blocks/data-model.example.json) — the structured INDEX. Field-level details (types, relationships, migration SQL) live in the prose under each entity / change section.

**Field reference:**

| Field | Type | Notes |
|-------|------|-------|
| `entities[]` | array | One entry per entity touched. Empty if no entity changes. |
| `entities[].name` | string | Entity / class / model name (e.g., `Book`, `Order`). |
| `entities[].change_kind` | enum | `added` / `modified` / `removed`. |
| `entities[].service` | string | Service that owns this entity (must match `config.services` key). |
| `entities[].fr_ids` | array of strings | FRs this entity supports. |
| `database_changes[]` | array | One entry per DB-level change. Empty if no DB changes. |
| `database_changes[].service` | string | Owning service. |
| `database_changes[].scope` | enum | `table` / `column` / `index` / `migration`. |
| `database_changes[].name` | string | The new/changed item's name (table name, column name, index name). |
| `database_changes[].table` | string | Required when `scope` = `column` or `index` — the table the change applies to. |
| `database_changes[].change_kind` | enum | `added` / `modified` / `removed` / `alter`. |
| `database_changes[].migration_file` | string | Path/name of the migration file the implementer creates. |
| `database_changes[].summary` | string | One-line description. |

If a feature touches no data layer, the producer emits `{"entities": [], "database_changes": []}` rather than omitting the block — empty arrays preserve the contract for downstream consumers.

---

### `INFRASTRUCTURE_IMPACT`

**Producer**: `solution-architect` (Phase 2 design output)
**Consumers**: Phase 5d (`terraform-implementer`, `cdk-stack-implementer` — read via task file), Phase 6 (assessor — verifies cross-stack refs)
**File**: `{run_dir}/outputs/phase-2-architecture.md`
**Canonical example**: [`templates/blocks/infrastructure-impact.example.json`](../templates/blocks/infrastructure-impact.example.json) — the structured INDEX. Configuration details (cross-stack ref shapes, IAM policy contents, naming conventions) live in the prose under each repo's section.

**Field reference:**

| Field | Type | Notes |
|-------|------|-------|
| `infra_changes[]` | array | One entry per affected infra repo. Empty if no infra impact. |
| `infra_changes[].repo` | string | Repo name (must match a `config.repos` entry with `role: infrastructure`). |
| `infra_changes[].type` | enum | `cdk` / `terraform` / other infra-as-code stack from the workspace config. |
| `infra_changes[].resources_added[]` | array | New resources this feature creates. |
| `infra_changes[].resources_modified[]` | array | Existing resources this feature alters. |
| `infra_changes[].resources_removed[]` | array | Resources this feature deletes (rare). |
| `*_resources*[].name` | string | Resource logical name (e.g., `BookUploadBucket` for CDK; `aws_s3_bucket.uploads` for Terraform). |
| `*_resources*[].kind` | string | Resource type (e.g., `s3.Bucket`, `sqs.Queue`, `iam.Role`). |
| `*_resources*[].summary` | string | One-line description. |
| `infra_changes[].cross_stack_refs[]` | array | Resources this feature exposes to or consumes from other stacks. Empty if none. |
| `infra_changes[].cross_stack_refs[].from` | string | The resource being referenced. |
| `infra_changes[].cross_stack_refs[].to` | string | The consuming stack / service. |
| `infra_changes[].cross_stack_refs[].purpose` | string | One-line reason. |
| `infra_changes[].fr_ids` | array of strings | FRs this infra change supports. |

If no infra repo is affected, the producer emits `{"infra_changes": []}` rather than omitting the block.

---

### `REQUIREMENTS_INDEX`

**Producer**: workspace product-owner agent (Phase 1 dispatch instructs it)
**Consumers**: Phase 4 (task generation), Phase 5.5 (reviewers walking FR/EC), Phase 6 (assessor)
**File**: `{run_dir}/outputs/phase-1-requirements.md`
**Canonical example**: [`templates/blocks/requirements-index.example.json`](../templates/blocks/requirements-index.example.json)

**Field reference:**

| Field | Type | Notes |
|-------|------|-------|
| `requirements[].id` | string | Functional requirement ID, format `FR-{N}`. |
| `requirements[].summary` | string | One-line description of the requirement. |
| `edge_cases[].id` | string | Edge case ID, format `EC-{N}`. |
| `edge_cases[].summary` | string | One-line description of the boundary condition. |
| `edge_cases[].applies_to` | array of strings | FR IDs this edge case modifies (optional). |

The `services` mapping (which service owns which FR/EC) lives in `AFFECTED_SERVICES`, not here — single source of truth, no duplication.

---

### `COVERAGE`

**Producer**: every implementer agent (per common-rules R9, in its final report)
**Consumers**: code reviewers (Phase 5.5) — verify the implementer's claim against actual diff
**File**: each implementer's report (in-context, then archived to `{run_dir}/outputs/phase-5-implementer-{repo}.md`)
**Canonical example**: [`templates/blocks/coverage.example.json`](../templates/blocks/coverage.example.json)

**Field reference:**

| Field | Type | Notes |
|-------|------|-------|
| `coverage[].id` | string | An FR-X or EC-X from the implementer's task file. Every ID in the task file MUST appear here. |
| `coverage[].file` | string | Repo-relative path to the file enforcing this requirement. |
| `coverage[].line` | number | Line number of the enforcement point. |
| `coverage[].test` | string | Optional: `path:line` of the test that exercises this requirement. Strongly preferred for EC-X entries. |

---

### `FINDINGS_SUMMARY`

**Producer**: every code reviewer (spring-boot, react, nestjs, nextjs)
**Consumers**: Phase 5.5 Step 2 (gate decision logic)
**File**: each reviewer's report (in-context, then archived to `{run_dir}/outputs/phase-5-5-code-review.md`)
**Canonical example**: [`templates/blocks/findings-summary.example.json`](../templates/blocks/findings-summary.example.json)

**Field reference:**

| Field | Type | Notes |
|-------|------|-------|
| `critical_total` | number | Count of `critical` rows in the FINDINGS block. |
| `critical_mechanical` | number | Subset where the 5th pipe field is `mechanical`. |
| `critical_architectural` | number | Subset where the 5th pipe field is `architectural`. |
| `non_critical_total` | number | Count of `non-critical` rows. |
| `scope_total` | number | Count of `scope` rows. |

The summary is pre-computed by the reviewer so the orchestrator's gate decision in Phase 5.5 Step 2 is one extract call instead of a row-counting LLM pass per report. Detail rows still live in the FINDINGS block — both are emitted side-by-side.

---

## Adding a new structured block

1. Define the schema here under "Defined block schemas".
2. Update the producer agent (e.g., the architect) to emit a ```` ```json ```` block at the top of the named section.
3. Update consumer phase files to call `node {plugin_dir}/scripts/extract-block.js {file} {NAME}` instead of asking the LLM to re-parse prose.
4. Keep prose under the JSON for human context only — never have prose contradict the JSON.

The extractor script is schema-agnostic (any valid JSON works) — no script changes needed when you add a new block.
