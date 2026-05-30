# Structured block schema registry — producer/consumer contracts for every machine-read JSON block

The contract registry for every machine-read JSON block in PipeCrew. Phase outputs are markdown files written for humans first, but several pieces of data inside them are extracted programmatically by downstream phases. This document is the catalogue: one entry per block, naming its producer, its consumers, where it lives, and its field rules — so the producer (typically the `solution-architect`) and the consumer (a phase orchestrator) agree on schema. The canonical example files sit beside this doc in `templates/blocks/`; this doc carries the field reference tables and the producer/consumer wiring those examples can't express.

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
**Canonical example**: [`templates/blocks/affected-services.example.json`](./affected-services.example.json) — the single source of truth for the structure. Update that file when the schema changes; this doc only carries the field reference table below.

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
**Canonical example**: [`templates/blocks/api-design.example.json`](./api-design.example.json) — the structured INDEX. Detailed per-endpoint schemas (request/response bodies for code-first, event-handler details for no-api) live in the prose under each service's section.

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
**Canonical example**: [`templates/blocks/data-model.example.json`](./data-model.example.json) — the structured INDEX. Field-level details (types, relationships, migration SQL) live in the prose under each entity / change section.

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
**Canonical example**: [`templates/blocks/infrastructure-impact.example.json`](./infrastructure-impact.example.json) — the structured INDEX. Configuration details (cross-stack ref shapes, IAM policy contents, naming conventions) live in the prose under each repo's section.

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

### `MAPPER_REPORT`

**Producer**: `architecture-mapper` agent (dispatched by `/draw-diagram --scan` or `/draw-diagram --repos`)
**Consumers**: `/draw-diagram` skill orchestrator (prints summary), human reviewer (audits skipped/unresolved items), future `--reconcile` mode (compares against `platform.md`)
**File**: emitted in the agent's response alongside `architecture-overview.mmd` + `architecture.mmd` blocks; the orchestrator extracts it for printing
**Canonical example**: [`templates/blocks/mapper-report.example.json`](./mapper-report.example.json)

**Field reference:**

| Field | Type | Notes |
|-------|------|-------|
| `scanned_repos[]` | array | One entry per repo the mapper scanned. |
| `scanned_repos[].path` | string | Absolute repo path. |
| `scanned_repos[].name` | string | Repo name (from package metadata). |
| `scanned_repos[].tech_stack` | enum | spring-boot / nestjs / fastapi / django / flask / express / react / nextjs / cdk / terraform / python-worker / node-mock / go / rust / dotnet / unknown. |
| `scanned_repos[].role_hint` | enum | frontend / backend / worker / infra / contract / unknown. |
| `scanned_repos[].tier_a_reads` | number | Tier A (repo identity) reads — typically ~3. |
| `scanned_repos[].tier_b_reads` | number | Tier B (declared integrations) reads — typically 5–15. |
| `scanned_repos[].tier_c_grep_hits` | number | Tier C grep matches before filtering. |
| `scanned_repos[].tier_d_verification_reads` | number | Tier D verification reads — capped at 20 per HARD RULE R1. |
| `edges[]` | array | Cross-repo edges discovered. |
| `edges[].from` | string | Source repo / service / queue. |
| `edges[].to` | string | Target repo / service / queue. May be `(unknown-host: ...)` or `(dynamic-target)`. |
| `edges[].kind` | enum | `http` / `event-publish` / `event-consume` / `db` / `cross-stack`. |
| `edges[].confidence` | enum | `high` (declared in config) / `medium` (code grep + verified) / `low` (name-similarity inference only). |
| `edges[].evidence` | string | File:line or file path that supports the edge. |
| `unresolved[]` | array | Targets the mapper could not resolve (dynamic, hardcoded localhost, unresolved env vars). |
| `skipped[]` | array | Items deliberately not scanned, with reason — typically Tier D overflow. |
| `stats` | object | Aggregate counts: `total_repos_scanned`, `total_edges`, `edges_{high,medium,low}_confidence`, `unresolved_count`, `skipped_count`. |

The MAPPER_REPORT exists so the human reviewer can judge **what the mapper saw vs. what it inferred vs. what it deliberately skipped**. Diagrams are lossy by design; this report is the reconciliation layer.

---

### `REQUIREMENTS_INDEX`

**Producer**: workspace product-owner agent (Phase 1 dispatch instructs it)
**Consumers**: Phase 4 (task generation), Phase 5.5 (reviewers walking FR/EC), Phase 6 (assessor)
**File**: `{run_dir}/outputs/phase-1-requirements.md`
**Canonical example**: [`templates/blocks/requirements-index.example.json`](./requirements-index.example.json)

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
**Canonical example**: [`templates/blocks/coverage.example.json`](./coverage.example.json)

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
**Canonical example**: [`templates/blocks/findings-summary.example.json`](./findings-summary.example.json)

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

### `OBSERVABILITY`

**Producer**: `scripts/extract-observability.js` during `/discover` Phase B (deterministic IaC parse), curated by the LLM with the user to fill the parts no parser can extract (trace correlation header, dashboard URLs, runbook pointers).
**Consumers**: `{slug}-troubleshooter` agent (selects a row by `service` + `env`, formats `query` with `{since}` / `{filter}` placeholders, runs via Bash), `scripts/validate-observability.js` (required-fields check at end of Phase B and start of `/troubleshoot`)
**File**: `{workspace_root}/{slug}/context/platform.md` under the `## Observability` H2 section
**Canonical example**: [`templates/blocks/observability.example.json`](./observability.example.json) — single source of truth for the structure. Update that file when the schema changes; this doc only carries the field reference table below.

**Field reference:**

| Field | Type | Notes |
|-------|------|-------|
| `log_destinations[]` | array | One row per (service, env) pair. A service running in three envs produces three rows. |
| `log_destinations[].service` | string | Must match a key in `config.services`. |
| `log_destinations[].env` | string | Env label — `prod` / `staging` / `dev` / `local` or any name the workspace uses. |
| `log_destinations[].type` | enum | `cloudwatch` / `kubectl` / `docker` / `journalctl` (extensible — add new types in the example file + extractor + validator together). |
| `log_destinations[].log_group` | string | Required when `type` = `cloudwatch`. Full log group path (e.g., `/aws/ecs/payments-prod`). |
| `log_destinations[].namespace` | string | Required when `type` = `kubectl`. Kubernetes namespace. |
| `log_destinations[].selector` | string | Required when `type` = `kubectl`. Label selector (e.g., `app=foo`). |
| `log_destinations[].container` | string | Required when `type` = `docker`. Container name (matches `docker-compose.yml` service key). |
| `log_destinations[].unit` | string | Required when `type` = `journalctl`. systemd unit name. |
| `log_destinations[].query` | string | Shell command template. Supports placeholders the troubleshooter formats at query time: `{since}`, `{filter}`, `{log_group}`, `{namespace}`, `{selector}`, `{container}`, `{unit}`. |
| `log_destinations[].source` | string | IaC `file:line` the row was extracted from — used by `/discover --refresh` for drift detection and by the troubleshooter when a query returns nothing (so the user can re-check the IaC). |
| `trace.correlation_header` | string | Header that propagates a request ID across services (e.g., `X-Request-Id`, `traceparent`). Filled by LLM curation, not the extractor. |
| `trace.propagated_through` | array of strings | Service names known to read AND forward the header. Useful for the troubleshooter to know which logs to query when chasing a cross-service trace. |
| `dashboards[]` | array | Operator dashboards relevant to this platform. Filled by LLM curation. |
| `dashboards[].name` | string | Display name. |
| `dashboards[].url` | string | Direct link. |
| `dashboards[].scope` | string | Service name or `platform`. |
| `runbooks.index` | string | Repo-relative path to the runbook index file (e.g., `docs/runbooks/README.md`). |

If the workspace has no observability stack (toy or local-only), the producer emits `{"log_destinations": [], "trace": {}, "dashboards": [], "runbooks": {}}` rather than omitting the block — empty arrays preserve the contract for downstream consumers.

---

### `REPO_PROFILE`

**Producer**: `repo-discoverer` agent (Sonnet) during `/discover` Phase B2.0 — one dispatch per repo, fired in parallel.
**Consumers**: `solution-architect` (Phase B2 synthesis — reads the full set of profiles via direct `Read` + `JSON.parse`), `scripts/validate-repo-profile.js` (required-fields + shape gate run at the end of Phase B2.0, before the architect dispatch), `scripts/discover-cache.js` (Win #6 — reads cached profiles to skip re-scanning unchanged repos on `/discover --resume`; gates on `schema_version` matching the canonical example).
**File**: `{run_dir}/outputs/repo-profiles/{repo_key}.json` — **one standalone `.json` file per repo**.
**Canonical example**: [`templates/blocks/repo-profile.example.json`](./repo-profile.example.json) — single source of truth for the structure. Update that file when the schema changes; this doc only carries the field reference table below.

> **This block is an exception to "How structured blocks work" above.** `REPO_PROFILE` is NOT a `<!-- BEGIN -->`…`<!-- END -->` section embedded in a markdown file — it is a bare JSON file written with the `Write` tool, no fence, no markers. `extract-block.js` does not apply; consumers `Read` the file and `JSON.parse` it directly. The contract is "every key in the canonical example is present; role-non-applicable fields are `null` (objects) or `[]` (arrays), never omitted" — that invariant is what `validate-repo-profile.js` enforces so a truncated or prose-wrapped write is caught deterministically before the Opus synthesis pass instead of failing mid-synthesis.

**Field reference:**

| Field | Type | Notes |
|-------|------|-------|
| `schema_version` | integer | Schema version of the REPO_PROFILE shape itself. Today: `1`. The `discover-cache.js` plan command reads the canonical example's `schema_version` at runtime and invalidates any cached profile whose `schema_version` is less than the canonical value — so bumping the example file's `schema_version` automatically forces a rescan on every workspace's next `/discover` run. Always emit the value from the canonical example. |
| `repo_key` | string | Must match a key in `config.repos`. Echoes the dispatch input. |
| `type` | string | Repo type (`spring-boot` / `react` / `cdk` / …). Echoes the dispatch input. |
| `role` | string | `api-service` / `frontend` / `mock-server` / `infrastructure` / `worker` / `contract` / `other`. |
| `description` | string | A short paragraph (2–4 sentences, ~250–500 chars) on what this repo is for, sampled at discovery from `README.md` / dep manifest / module docstring. Must cover: (1) the domain / boundary it owns, (2) its key responsibilities, (3) optionally one notable integration or constraint. The architect uses the first sentence as the Service Map "Description" column and renders the full paragraph below the table. Should NOT restate what other profile fields already carry (`framework`, `entities`, `endpoints`, `integrations`) — describe *intent*, not inventory. Empty string when the discoverer would be guessing. |
| `scanned_at` | string | ISO-8601 scan time. Required today (the cache reads it back via `state.json`); the agent fills it from the current UTC timestamp at write time. |
| `head_sha` | string | Repo `HEAD` SHA at scan time. Optional today; reserved for the same cache. |
| `branch` | string | Branch scanned. Optional today; reserved for the same cache. |
| `framework` | object\|null | `{ name, version, language_version, key_libs[] }`. `null` only for `type=other` with no recognizable manifest. |
| `entities[]` | array\|null | `{ name, purpose, key_states[], owning_module }`. `null` for frontend / infra repos. `purpose`: one sentence (≤120 chars) on what the entity represents in the domain, sampled from class Javadoc / docstring; empty string when the discoverer would be guessing. `key_states`: state-field values when the entity has a clear lifecycle. **Transitions are NOT extracted** — they live scattered across business logic and are out of scope for B2.0; if a lifecycle is non-trivial (4+ states), the discoverer flags it in `notes_for_architect` and the architect may spend ONE targeted read on the named service file. |
| `endpoints[]` | array\|null | `{ method, path, auth, purpose }`. `null` for frontend / infra. Workers omit this and use `event_handlers[]` (same shape; `method` = trigger source, `path` = queue/topic). |
| `integrations` | object\|null | `{ outbound_http[], outbound_events[], outbound_storage[], inbound_http[], inbound_events[] }`. The cross-repo topology and BOTH architecture diagrams derive from this. Sub-arrays are `[]` (never `null`) when a category doesn't apply. `outbound_http[]`: `{ target, base_path, purpose }`. `outbound_events[]` / `inbound_events[]`: `{ topic_or_queue, transport, purpose }`. `outbound_storage[]`: `{ kind, name, purpose }`. `inbound_http[]`: array of caller repo/service names. |
| `auth` | object\|null | `{ scheme, library, enforcement_pattern, role_decisions[] }`. `null` for frontend / infra. |
| `persistence` | object\|null | `{ orm, db, migrations: { tool, format, count } }`. `null` when the repo has no datastore. |
| `tests` | object\|null | `{ framework, count, harness }`. |
| `key_conventions[]` | array of strings | Patterns used CONSISTENTLY across the repo (observed in ≥2 sibling files). |
| `constraints_observed[]` | array of strings | Workspace-shaping limits / divergences / coverage gaps. Feeds platform.md § Known Constraints. |
| `audit_findings[]` | array | `{ severity: CRITICAL\|HIGH\|MEDIUM\|LOW, file, line, description }`. Aggregated verbatim into `audit-findings.md`. |
| `specs[]` | array\|null | OpenAPI / contract files the repo OWNS: `{ path, spec_policy_inferred: api-first\|code-first\|no-api, endpoints_in_spec }`. `[]` for repos with no owned spec. Frontends record specs they CONSUME under `frontend_signals.specs_consumed`, not here. |
| `frontend_signals` | object\|null | Set only for `role=frontend`, else `null`. `{ component_library, state_management, routing, i18n: { library, languages[], rtl }, styling, design_system_path, tests_framework, specs_consumed[] }`. |
| `infra_signals` | object\|null | Set only for `cdk` / `terraform` repos, else `null`. CDK: `{ language, stacks[], iam_pattern, stage_handling }`. Terraform: `{ modules[], state_backend, providers }`. |
| `metrics` | object | `{ src_files, test_files, controllers, services, repositories, models, scan_truncated }`. `scan_truncated` is `true` when the repo was too large to sample comprehensively. |
| `notes_for_architect` | string | Free-form heads-up paragraph (1–3 sentences). Feeds platform.md § Open Questions / Evolving Decisions. |

Role-non-applicable fields keep their key with a `null` (object fields) or `[]` (array fields) value — they are never omitted, so the architect's synthesis passes can rely on the shape without per-field existence checks.

---

## Adding a new structured block

1. Define the schema here under "Defined block schemas".
2. Update the producer agent (e.g., the architect) to emit a ```` ```json ```` block at the top of the named section.
3. Update consumer phase files to call `node {plugin_dir}/scripts/extract-block.js {file} {NAME}` instead of asking the LLM to re-parse prose.
4. Keep prose under the JSON for human context only — never have prose contradict the JSON.

The extractor script is schema-agnostic (any valid JSON works) — no script changes needed when you add a new block.
